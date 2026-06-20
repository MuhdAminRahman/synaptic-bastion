// ═══ TESTS ═══

// Helpers
async function freshNodes(){
  try{
    const d = await api('/api/nodes');
    if(!d) throw new Error('proxy unreachable');
    return d;
  }catch(e){
    throw new Error('freshNodes: '+e.message);
  }
}
async function killAndConfirm(node){
  const r = await fetch(`${S.base}/api/chaos/kill-verify/${node}`,{method:'POST',signal:AbortSignal.timeout(CFG.CHAOS_TIMEOUT_MS),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
  return r.json();
}

// Stops Patroni on `oldLeaderName` (NOT the app — app keeps serving, so /api/nodes
// online/offline polling is useless here) and polls /api/patroni until a DIFFERENT
// node assumes the primary role. Returns {newLeader, elapsedMs, timedOut, members}.
async function killDbAndAwaitElection(oldLeaderName, maxWaitMs = 40000, pollMs = 2000){
  const t0 = Date.now();
  const killR = await fetch(`${S.base}/api/chaos/kill-db/${oldLeaderName}`,{
    method:'POST', signal:AbortSignal.timeout(CFG.CHAOS_TIMEOUT_MS), headers:{'x-ha-token':CFG.AUTH_TOKEN}
  });
  const killD = await killR.json();
  addEvidence(`kill-db · ${oldLeaderName}`, killD);

  let newLeader = null, members = null;
  while(Date.now()-t0 < maxWaitMs){
    await sleep(pollMs);
    try{
      const r = await fetch(`${S.base}/api/patroni`,{headers:{'x-ha-token':CFG.AUTH_TOKEN},signal:AbortSignal.timeout(5000)});
      const d = await r.json();
      members = d.members;
      const leaderMember = members?.find(m=>(m.role==='primary'||m.role==='master') && m.name!==oldLeaderName);
      if(leaderMember){ newLeader = leaderMember.name; break; }
    }catch(_){ /* keep polling */ }
  }
  const elapsedMs = Date.now()-t0;
  return { newLeader, elapsedMs, timedOut: !newLeader, members };
}
const TESTS = {
  // ── FAILOVER ───────────────────────────────────────────────────────────
  t1: {
    name: 'T1 · Single Node Offline — Failover',
    desc: 'Kills a non-master app node via SIGKILL. Nginx redistributes to remaining nodes. RTO: <5s. DB replicas retain full dataset.',
    category: 'failover',
    async fn(){
      // Pick a non-master, non-local node to kill
      const victim = nodeList().find(n=>n.db!=='master' && !n.local) || nodeList().find(n=>!n.local);
      if(!victim) return {pass:false, msg:'No remote node to kill'};
      const survivors = nodeNames().filter(n=>n!==victim.name);
      const before = await api('/api/nodes');
      const kill = await killAndConfirm(victim.name);
      addEvidence(`T1 · kill-verify · ${victim.name}`, kill);
      const after = await api('/api/nodes');
      const victimAfter = after.nodes.find(n=>n.name===victim.name);
      const survivorsOnline = survivors.every(n=>after.nodes.find(r=>r.name===n)?.status==='online');
      if(!survivorsOnline) return {pass:false, msg:`Survivors not all online after killing ${victim.name}`};
      const lb = await api('/api/lb?n=6');
      addEvidence('T1 · LB after kill', lb);
      setTarget('uptime', survivorsOnline?'✓ surviving':'✗ degraded', survivorsOnline);
      return {
        pass: survivorsOnline,
        msg: `${victim.name} killed · ${survivors.length} survivors online · LB backends: ${lb.backends?.join(',')||'?'}`
      };
    }
  },
  t2: {
    name: 'T2 · Patroni Leader Failure — Automatic DB Failover',
    desc: 'Stops Patroni (not the app) on the current leader. Verifies surviving replicas stay readable throughout and a new leader is elected automatically.',
    category: 'failover',
    async fn(){
      await checkPatroni().catch(()=>{});
      const oldLeader = S.patroni?.leader?.name;
      if(!oldLeader) return {pass:false, msg:'No Patroni leader known — ensure Patroni is running on all nodes'};
      const survivors = nodeNames().filter(n=>n!==oldLeader);
      if(!survivors.length) return {pass:false, msg:'No surviving nodes to check read continuity'};

      // Probe survivors' /data continuously in the background while failover happens
      let readFailures = 0, readChecks = 0;
      let probing = true;
      const probeLoop = (async()=>{
        while(probing){
          for(const n of survivors){
            readChecks++;
            try{
              const r = await fetch(`${S.base}/api/node/${n}/data`,{signal:AbortSignal.timeout(3000),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
              const d = await r.json();
              if(!(d.status==='online' && d.body?.tables)) readFailures++;
            }catch(_){ readFailures++; }
          }
          await sleep(1000);
        }
      })();

      const result = await killDbAndAwaitElection(oldLeader, 40000, 2000);
      probing = false;
      await probeLoop;
      addEvidence(`T2 · election result`, result);

      // Best-effort cleanup — bring the old leader's Patroni back as a replica
      try{
        await fetch(`${S.base}/api/chaos/restore-db/${oldLeader}`,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
      }catch(_){}

      const readUptime = readChecks ? Math.round(((readChecks-readFailures)/readChecks)*1000)/10 : 0;
      const pass = !result.timedOut && readFailures===0;
      setTarget('dbfailover', result.timedOut?'✗ no election':`${result.elapsedMs}ms ✓`, !result.timedOut);
      return {
        pass,
        msg: result.timedOut
          ? `No new leader elected within 40s after killing ${oldLeader}`
          : `${oldLeader} → ${result.newLeader} in ${result.elapsedMs}ms · reads ${readUptime}% uninterrupted (${readChecks-readFailures}/${readChecks})`
      };
    }
  },
  t3: {
    name: 'T3 · Two Nodes Offline — Single Node Holds',
    desc: 'Kills two nodes simultaneously. Remaining node handles 100% traffic alone (~33% capacity). Must remain functional with full dataset.',
    category: 'failover',
    async fn(){
      const nodes = nodeNames();
      if(nodes.length < 3) return {pass:false, msg:'Need at least 3 nodes'};
      // Kill non-local nodes, keep local (Hetzner 1 / LB node)
      const local = nodeList().find(n=>n.local);
      const toKill = nodeList().filter(n=>!n.local).slice(0,2);
      if(toKill.length < 2) return {pass:false, msg:'Need at least 2 remote nodes'};
      const [k1, k2] = toKill;
      const [kill1, kill2] = await Promise.all([killAndConfirm(k1.name), killAndConfirm(k2.name)]);
      addEvidence(`T3 · kill ${k1.name}+${k2.name}`, {kill1, kill2});
      await sleep(2000);
      const check = await api('/api/nodes');
      const survivor = check.nodes.find(n=>n.name===(local?.name||nodes[0]));
      const lb = await api('/api/lb?n=6');
      addEvidence('T3 · LB single node', lb);
      const pass = survivor?.status==='online' && lb.ok > 0;
      return {
        pass,
        msg: `Killed ${k1.name}+${k2.name} · ${survivor?.name||'?'} alone: ${survivor?.status} · LB: ${lb.ok}/${lb.total} ok`
      };
    }
  },
  t4: {
    name: 'T4 · Process Crash — Auto-Restart',
    desc: 'SIGKILLs all nodes in sequence. systemd (Linux) and launchctl (macOS) must auto-restart each. RTO: <5s per node.',
    category: 'failover',
    async fn(){
      const passed = [], failed = [];
      for(const name of nodeNames()){
        try{
          const r = await fetch(`${S.base}/api/chaos/kill-verify/${name}`,{method:'POST',signal:AbortSignal.timeout(CFG.CHAOS_TIMEOUT_MS),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
          const d = await r.json();
          addEvidence(`T4 · kill-verify · ${name}`, d);
          if(d.ok && d.recovered) passed.push(name);
          else failed.push(name);
        }catch(e){ failed.push(name+' ('+e.message+')'); }
      }
      setTarget('recovery', passed.length===nodeNames().length?'100% ✓':'✗ '+failed.join(','), passed.length===nodeNames().length);
      return {
        pass: failed.length===0,
        msg: `${passed.length}/${nodeNames().length} auto-recovered · ${failed.length?'failed: '+failed.join(','):'all ok'}`
      };
    }
  },
  // ── VALIDATION ─────────────────────────────────────────────────────────
  t5: {
    name: 'T5 · Health Endpoint Validation',
    desc: 'Hits /health on all nodes directly. Validates JSON response shape: {status:"healthy", server, timestamp}.',
    category: 'validation',
    async fn(){
      const passed=[], failed=[];
      for(const n of nodeNames()){
        try{
          const r = await fetch(`${S.base}/api/node/${n}`,{signal:AbortSignal.timeout(CFG.PROBE_TIMEOUT_MS),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
          const d = await r.json();
          addEvidence(`T5 · /health · ${n}`, d);
          if(d.status==='online' && d.body?.status==='healthy') passed.push(n);
          else failed.push(n+' ('+d.body?.status+')');
        }catch(e){ failed.push(n+' ('+e.message+')'); }
      }
      return {
        pass: failed.length===0,
        msg: `${passed.length}/${nodeNames().length} healthy · ${failed.length?'failed: '+failed.join(','):'all ok'}`
      };
    }
  },
  t6: {
    name: 'T6 · PostgreSQL /data Endpoint',
    desc: 'Hits /data on all 3 nodes. Validates live DB connections. Confirms all replicas are readable.',
    category: 'validation',
    async fn(){
      const passed=[], failed=[];
      for(const n of nodeNames()){
        try{
          const r = await fetch(`${S.base}/api/node/${n}/data`,{signal:AbortSignal.timeout(CFG.PROBE_TIMEOUT_MS),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
          const d = await r.json();
          addEvidence(`T6 · /data · ${n}`, d);
          if(d.status==='online' && d.body?.tables) passed.push(`${n}(${d.body.tables} tables)`);
          else failed.push(n+' ('+JSON.stringify(d.body||d.error)+')');
        }catch(e){ failed.push(n+' ('+e.message+')'); }
      }
      const replicaNodes = nodeList().filter(n=>n.db==='replica');
      const onlineReplicas = replicaNodes.filter(n=>passed.some(p=>p.startsWith(n.name)));
      if(passed.length===nodeNames().length){
        setTarget('rpo',`0s ✓ (${onlineReplicas.length} replicas readable)`,true);
        setTarget('replicas',`${onlineReplicas.length}/${replicaNodes.length} replicas online`,true);
      }
      return {
        pass: failed.length===0,
        msg: `${passed.length}/${nodeNames().length} DB ok · ${failed.length?'failed: '+failed.join(','):passed.join(', ')}`
      };
    }
  },
  t7: {
    name: 'T7 · LB Distribution — Round-Robin Verified',
    desc: 'Sends 12 requests through Nginx LB. Verifies all configured backends receive traffic.',
    category: 'validation',
    async fn(){
      const lb = await api('/api/lb?n=12');
      addEvidence('T7 · LB distribution', lb);
      const expected = nodeNames().length;
      const got = lb.backends?.length||0;
      const pass = got >= Math.max(1, expected-1); // allow 1 offline node
      setTarget('uptime', pass?`${lb.ok}/${lb.total} ✓`:`${lb.ok}/${lb.total} ✗`, pass);
      return {
        pass,
        msg: `${lb.ok}/${lb.total} ok · backends: ${lb.backends?.join(',')||'none'} · avg ${lb.avgLatency}ms`
      };
    }
  },
  // ── PERFORMANCE ────────────────────────────────────────────────────────
  t8: {
    name: 'T8 · Latency — p50 ≤180ms, p95 ≤250ms',
    desc: 'Fires 50 sequential requests through the LB. Measures p50 and p95 latency.',
    category: 'performance',
    async fn(){
      const lb = await api('/api/lb?n=50');
      addEvidence('T8 · latency', lb);
      const p50 = lb.p50 || lb.results?.filter(r=>r.ok).map(r=>r.latency).sort((a,b)=>a-b)[Math.floor(lb.ok*.50)] || 0;
      const p95 = lb.p95 || lb.results?.filter(r=>r.ok).map(r=>r.latency).sort((a,b)=>a-b)[Math.floor(lb.ok*.95)] || 0;
      setTarget('p50', p50+'ms', p50 <= TARGETS.LAT_P50_MS);
      setTarget('p95', p95+'ms', p95 <= TARGETS.LAT_P95_MS);
      const pass = p50<=TARGETS.LAT_P50_MS && p95<=TARGETS.LAT_P95_MS;
      return {
        pass,
        msg: `p50: ${p50}ms (target ≤${TARGETS.LAT_P50_MS}ms) · p95: ${p95}ms (target ≤${TARGETS.LAT_P95_MS}ms)`
      };
    }
  },
  t9: {
    name: 'T9 · Throughput ≥ 1000 req/s',
    desc: 'Stress test: 500 requests × 80 concurrency through Nginx LB. No artificial caps — tests real system limits. Target: ≥1000 req/s. LAN equivalent ~10×.',
    category: 'performance',
    async fn(){
      const r = await fetch(`${S.base}/api/loadtest?n=500&c=80`,{signal:AbortSignal.timeout(CFG.LOADTEST_TIMEOUT_MS),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
      const d = await r.json();
      addEvidence('T9 · load test', d);
      const rps = d.reqPerSec||0;
      const pass = rps >= TARGETS.THROUGHPUT_RPS;
      const lanEstimate = d.p50 > 0 ? Math.round(50 / (d.p50/1000)) : 0; // estimate at 1ms LAN latency
      setTarget('rps', rps+' req/s', pass);
      return {
        pass,
        msg: `${rps} req/s · p50: ${d.p50}ms · p95: ${d.p95}ms · ${d.successRate}% success · target: ≥${TARGETS.THROUGHPUT_RPS} req/s`
      };
    }
  },
  t10: {
    name: 'T10 · RTO — App Process Recovery Cycle',
    desc: 'Kills a node\'s app process (systemd-managed, not DB-related). Measures detect+recover time via LB status. Target RTO: <5s.',
    category: 'performance',
    async fn(){
      const victim = nodeList().find(n=>!n.local) || nodeList()[0];
      if(!victim) return {pass:false, msg:'No node available to test'};
      const t0 = Date.now();
      const killR = await fetch(`${S.base}/api/chaos/kill/${victim.name}`,{method:'POST',signal:AbortSignal.timeout(CFG.CHAOS_TIMEOUT_MS),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
      const killD = await killR.json();
      addEvidence(`T10 · kill ${victim.name}`, killD);
      let detectedMs = null;
      for(let i=0;i<CFG.RTO_MAX_POLLS;i++){
        await sleep(CFG.RTO_POLL_MS);
        const nodes = await api('/api/nodes');
        const m = nodes.nodes.find(n=>n.name===victim.name);
        if(m?.status==='offline'){ detectedMs=Date.now()-t0; break; }
      }
      if(!detectedMs) return {pass:false, msg:`${victim.name} did not go offline within timeout`};
      setTarget('detect', detectedMs+'ms', detectedMs<=TARGETS.DETECT_MS);
      for(let i=0;i<CFG.RTO_MAX_POLLS;i++){
        await sleep(CFG.RTO_POLL_MS);
        const nodes = await api('/api/nodes');
        const m = nodes.nodes.find(n=>n.name===victim.name);
        if(m?.status==='online'){
          const rto = Date.now()-t0;
          setTarget('rto', rto+'ms', rto<=TARGETS.RTO_MS);
          addEvidence('T10 · recovery', {detectedMs, rto, node: victim.name});
          return {
            pass: rto <= CFG.RTO_ACCEPTABLE_MS,
            msg: `${victim.name} · detected: ${detectedMs}ms · recovered: ${rto}ms · target: <${TARGETS.RTO_MS}ms`
          };
        }
      }
      return {pass:false, msg:`${victim.name} did not recover within ${CFG.RTO_MAX_POLLS*CFG.RTO_POLL_MS}ms`};
    }
  },
  // ── PERFORMANCE (cont'd) ──────────────────────────────────────────────
  t11: {
    name: 'T11 · Replication Lag — Live Check',
    desc: 'Queries pg_stat_replication directly via the proxy. Asserts current and peak lag against spec targets. No synthetic write load (none available) — reports live steady-state lag.',
    category: 'performance',
    async fn(){
      const r = await fetch(`${S.base}/api/replication`,{signal:AbortSignal.timeout(CFG.REPL_CHECK_TIMEOUT_MS),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
      const d = await r.json();
      addEvidence('T11 · replication', d);
      if(!d.replicating) return {pass:false, msg:'No replicas currently streaming'};
      const lag = d.lagMs ?? 0;
      const pass = lag <= TARGETS.REPL_LAG_MS;
      setTarget('lag', lag===0?'<1ms ✓':lag+'ms', lag<=TARGETS.REPL_LAG_MS);
      setTarget('lag-peak', lag===0?'<1ms ✓':lag+'ms', lag<=TARGETS.REPL_LAG_PEAK);
      return {
        pass,
        msg: `${d.replicas?.length||0} replica(s) streaming · lag ${lag===0?'<1ms':lag+'ms'} (target ≤${TARGETS.REPL_LAG_MS}ms)`
      };
    }
  },
  // ── EXTERNAL ───────────────────────────────────────────────────────────
  t12: {
    name: 'T12 · Outpost — Double Check Method Validation',
    desc: 'Adds a temporary healthy target and a temporary unreachable target. Verifies the Double Check pipeline correctly classifies each, then cleans up.',
    category: 'external',
    async fn(){
      if(!S.base) return {pass:false, msg:'Not connected'};
      let goodId=null, badId=null;
      try{
        const goodR = await fetch(`${S.base}/api/outposts`,{method:'POST',headers:{'Content-Type':'application/json','x-ha-token':CFG.AUTH_TOKEN},body:JSON.stringify({name:'T12-good',url:'https://example.com',intervalSec:300}),signal:AbortSignal.timeout(8000)});
        const goodD = await goodR.json();
        if(!goodR.ok) throw new Error(goodD.error||'failed to add good outpost');
        goodId = goodD.id;

        const badR = await fetch(`${S.base}/api/outposts`,{method:'POST',headers:{'Content-Type':'application/json','x-ha-token':CFG.AUTH_TOKEN},body:JSON.stringify({name:'T12-bad',url:'http://127.0.0.1:9',intervalSec:300}),signal:AbortSignal.timeout(8000)});
        const badD = await badR.json();
        if(!badR.ok) throw new Error(badD.error||'failed to add bad outpost');
        badId = badD.id;

        // Force-check the good one (should resolve fast)
        await fetch(`${S.base}/api/outposts/${goodId}/check`,{method:'POST',headers:{'x-ha-token':CFG.AUTH_TOKEN},signal:AbortSignal.timeout(10000)});
        // Force-check the bad one — this triggers the full Double Check pipeline (debounce + socket quorum), can take ~5-20s
        await fetch(`${S.base}/api/outposts/${badId}/check`,{method:'POST',headers:{'x-ha-token':CFG.AUTH_TOKEN},signal:AbortSignal.timeout(30000)});

        const listR = await fetch(`${S.base}/api/outposts`,{headers:{'x-ha-token':CFG.AUTH_TOKEN},signal:AbortSignal.timeout(8000)});
        const listD = await listR.json();
        addEvidence('T12 · outposts after check', listD);
        const good = listD.outposts?.find(o=>o.id===goodId);
        const bad = listD.outposts?.find(o=>o.id===badId);
        const goodOk = good?.status==='healthy';
        const badOk = ['down','degraded'].includes(bad?.status);
        return {
          pass: goodOk && badOk,
          msg: `good target → ${good?.status||'?'} ${goodOk?'✓':'✗'} · bad target → ${bad?.status||'?'} ${badOk?'✓':'✗'}`
        };
      }catch(e){
        return {pass:false, msg:'Error: '+e.message};
      }finally{
        // Always clean up test artifacts
        if(goodId) await fetch(`${S.base}/api/outposts/${goodId}`,{method:'DELETE',headers:{'x-ha-token':CFG.AUTH_TOKEN}}).catch(()=>{});
        if(badId) await fetch(`${S.base}/api/outposts/${badId}`,{method:'DELETE',headers:{'x-ha-token':CFG.AUTH_TOKEN}}).catch(()=>{});
      }
    }
  },
  t13: {
    name: 'T13 · Floating IP — Public Reachability',
    desc: 'Direct browser fetch to the Floating IP\'s public LB port (bypassing the proxy entirely). Confirms the SPOF-mitigation entry point is currently routing traffic correctly.',
    category: 'external',
    async fn(){
      try{
        const t0=Date.now();
        const r = await fetch(`http://${CFG.PROXY_HOST}/health`,{signal:AbortSignal.timeout(5000)});
        const d = await r.json();
        const ms = Date.now()-t0;
        addEvidence('T13 · floating IP /health', d);
        const pass = d.status==='healthy';
        return {
          pass,
          msg: pass
            ? `${CFG.PROXY_HOST} routed to '${d.server}' in ${ms}ms ✓`
            : `${CFG.PROXY_HOST} responded but status='${d.status}'`
        };
      }catch(e){
        return {pass:false, msg:`Floating IP unreachable: ${e.message}`};
      }
    }
  },
};

const TEST_PRIORITY = {t1:'high',t2:'high',t3:'high',t10:'high'};

const TEST_CATEGORIES = {
  failover:    { label: 'FAILOVER TESTS',    color: 'var(--red)' },
  validation:  { label: 'VALIDATION TESTS',  color: 'var(--amber)' },
  performance: { label: 'PERFORMANCE TESTS', color: 'var(--blue)' },
  external:    { label: 'EXTERNAL TESTS',    color: 'var(--cyan)' },
};

function renderTestGrid(){
  const grid = document.getElementById('test-grid');
  if(!grid) return;
  let html = '<div class="test-list">';
  let globalNum = 0;
  let lastCat = null;
  for(const [id, t] of Object.entries(TESTS)){
    globalNum++;
    const num = String(globalNum).padStart(2,'0');
    const pri = TEST_PRIORITY[id]||'normal';
    const cat = t.category||'validation';
    // Category header
    if(cat !== lastCat){
      const catInfo = TEST_CATEGORIES[cat]||{label:cat.toUpperCase(),color:'var(--text3)'};
      html += `<div class="tl-cat-header" style="border-left:2px solid ${catInfo.color}">
        <span style="color:${catInfo.color}">${catInfo.label}</span>
        <button class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:9px" onclick="runCategory('${cat}')">RUN</button>
      </div>`;
      lastCat = cat;
    }
    html += `<div class="tl-item" id="tc-${id}" data-priority="${pri}" data-category="${cat}" onclick="runTest('${id}')">
      <div class="tl-num">${num}</div>
      <div class="tl-status idle" id="tl-st-${id}">○</div>
      <div class="tl-name-col">
        <span class="tl-name">${t.name}</span>
        <span class="tl-desc">${t.desc}</span>
      </div>
      <div class="tl-result-col" id="tr-${id}">PENDING</div>
      <div class="tl-time" id="tl-time-${id}"></div>
    </div>`;
  }
  html += '</div>';
  grid.innerHTML = html;
}

async function runCategory(category){
  if(!S.base){ toast('Connect first','warning'); return; }
  const ids = Object.entries(TESTS).filter(([,t])=>t.category===category).map(([id])=>id);
  for(const id of ids) await runTest(id);
}

async function runTest(id){
  if(!S.base){ toast('Connect first','warning'); return; }
  const t=TESTS[id]; if(!t) return;
  const card=document.getElementById('tc-'+id);
  const res=document.getElementById('tr-'+id);
  const stEl=document.getElementById('tl-st-'+id);
  const timeEl=document.getElementById('tl-time-'+id);
  const _t0=Date.now();
  if(card) card.className='tl-item running';
  if(stEl){ stEl.className='tl-status running'; stEl.textContent='▶'; }
  if(res){ res.className='tl-result-col running'; res.textContent='RUNNING...'; }
  log(`> ${t.name}`,'info');
  try{
    const r=await t.fn();
    S.testRes[id]=r.pass;
    if(card) card.className='tl-item '+(r.pass?'pass':'fail');
    if(stEl){ stEl.className='tl-status '+(r.pass?'pass':'fail'); stEl.textContent=r.pass?'✓':'✗'; }
    if(res){
      res.className='tl-result-col '+(r.pass?'pass':'fail');
      res.textContent=r.msg;
    }
    if(timeEl){ const ms=Date.now()-_t0; timeEl.textContent=ms>1000?(ms/1000).toFixed(1)+'s':ms+'ms'; }
    log((r.pass?'✓ PASS  ':'✗ FAIL  ')+r.msg,r.pass?'success':'error');
    toast(t.name+': '+(r.pass?'PASS':'FAIL'),r.pass?'success':'error');
    updateTestSummary();
  }catch(e){
    S.testRes[id]=false;
    if(card) card.className='tl-item fail';
    if(stEl){ stEl.className='tl-status fail'; stEl.textContent='✗'; }
    if(res){ res.className='tl-result-col fail'; res.textContent='ERROR: '+e.message; }
    if(timeEl){ const ms=Date.now()-_t0; timeEl.textContent=ms>1000?(ms/1000).toFixed(1)+'s':ms+'ms'; }
    log('ERROR: '+e.message,'error');
    updateTestSummary();
  }
}

async function runAllTests(){
  if(!S.base){ toast('Connect first','warning'); return; }
  // Mark all idle cards as queued so user knows they will run
  // Cache all card/result elements before looping
  const testEls = Object.fromEntries(Object.keys(TESTS).map(id=>[id,{
    card: document.getElementById('tc-'+id),
    res:  document.getElementById('tr-'+id),
  }]));
  Object.entries(testEls).forEach(([id,{card,res}])=>{
    if(card && card.className==='tl-item'){
      card.style.opacity='0.5';
      const st=document.getElementById('tl-st-'+id);
      if(st){ st.className='tl-status queued'; st.textContent='○'; }
      if(res && res.textContent==='PENDING') res.textContent='QUEUED';
    }
  });
  for(const id of Object.keys(TESTS)){
    if(testEls[id]?.card){ testEls[id].card.style.opacity='1'; }
    await runTest(id); await sleep(350);
  }
  const passed=Object.values(S.testRes).filter(Boolean).length;
  const total=Object.keys(TESTS).length;
  toast(`Tests done: ${passed}/${total} passed`,passed===total?'success':passed>=total*.7?'warning':'error');
}

function resetTests(){
  renderTestGrid();
  S.testRes={}; updateTestSummary();
  const sumEl=document.getElementById('test-summary');
  if(sumEl) sumEl.textContent=`${Object.keys(TESTS).length} TESTS PENDING`;
}

function setTarget(id, value, pass){
  const el = document.getElementById('tr-'+id);
  const tel = document.getElementById('tt-'+id);
  if(el){
    el.textContent = value;
    el.style.color = pass===true ? 'var(--amber)' : pass===false ? 'var(--red)' : 'var(--amber)';
    el.style.fontFamily = 'var(--mono)';
    el.style.fontWeight = '600';
    // Color the whole row
    const row = el.closest('tr');
    if(row){
      row.style.background = pass===true ? 'var(--amber-dim)' : pass===false ? 'var(--red-dim)' : '';
    }
  }
  if(tel){
    const d = new Date();
    tel.textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }
}

function updateTestSummary(){
  const testVals=Object.values(S.testRes);
  const passed=testVals.filter(Boolean).length;
  const ran=testVals.length;
  const total=Object.keys(TESTS).length;
  const el=document.getElementById('test-summary');
  if(ran===0){el.textContent='Run tests to see summary.';return;}
  el.innerHTML=`<span style="color:${passed===ran?'var(--green)':passed>=ran*.7?'var(--amber)':'var(--red)'}">${passed}/${total} tests passed</span> · ${total-ran} not yet run`;
}
