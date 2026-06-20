// ═══ LOAD TEST ═══
async function runLoadTest(){
  if(!S.base){ toast('Connect first','warning'); return; }
  const n=parseInt(document.getElementById('lt-n').value)||100;
  const c=parseInt(document.getElementById('lt-c').value)||10;
  const path=document.getElementById('lt-path').value||'/health';
  const btn=document.getElementById('lt-btn');
  btn.textContent='Running...'; btn.disabled=true;
  document.getElementById('lt-fill').style.width='0%';
  document.getElementById('lt-status').textContent='Running server-side via proxy...';

  document.getElementById('lt-fill').style.width='30%';
  try{
    const r=await fetch(`${S.base}/api/loadtest?n=${n}&c=${c}&path=${encodeURIComponent(path)}`,{signal:AbortSignal.timeout(CFG.LOADTEST_TIMEOUT_MS),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
    const d=await r.json();
    document.getElementById('lt-fill').style.width='100%';
    applyLT(d,n,c,path);
  }catch(e){
    toast('Load test failed: '+e.message,'error');
    document.getElementById('lt-status').textContent='Error: '+e.message;
  }
  btn.textContent='Run load test →'; btn.disabled=false;
}

function applyLT(d,n,c,path){
  document.getElementById('lt-total').textContent=d.total;
  document.getElementById('lt-ok').textContent=d.ok;
  document.getElementById('lt-fail').textContent=d.fail;
  const pe=document.getElementById('lt-pct');
  pe.textContent=d.successRate+'%';
  pe.className='nm-val '+(d.successRate>=CFG.RATE_GOOD_PCT?'good':d.successRate>=CFG.RATE_WARN_PCT?'warn':'bad');
  document.getElementById('lt-avg').textContent=d.avgLatency+'ms';
  document.getElementById('lt-rps').textContent=d.reqPerSec;
  document.getElementById('lt-p50').textContent=d.p50+'ms';
  document.getElementById('lt-p95').textContent=d.p95+'ms';
  document.getElementById('lt-p99').textContent=d.p99+'ms';
  const p50El=document.getElementById('lt-p50-pass');
  const p95El=document.getElementById('lt-p95-pass');
  if(p50El){p50El.textContent=d.p50<=TARGETS.LAT_P50_MS?'✓':'✗';p50El.style.color=d.p50<=TARGETS.LAT_P50_MS?'var(--green)':'var(--red)';}
  if(p95El){p95El.textContent=d.p95<=TARGETS.LAT_P95_MS?'✓':'✗';p95El.style.color=d.p95<=TARGETS.LAT_P95_MS?'var(--green)':'var(--red)';}
  document.getElementById('lt-ptable').style.display='table';
  document.getElementById('lt-status').textContent=`Done — ${d.ok}/${d.total} ok · avg ${d.avgLatency}ms · ${d.reqPerSec} req/s`;
    const bRow = document.createElement('tr');
  bRow.innerHTML = `<td>${ts()}</td><td>${parseInt(n)}</td><td>${parseInt(c)}</td><td></td>
    <td style="color:${d.successRate>=CFG.TARGETS_SPEC.RATE_GOOD_PCT?'var(--green)':d.successRate>=CFG.TARGETS_SPEC.RATE_WARN_PCT?'var(--amber)':'var(--red)'}">${parseInt(d.successRate)}%</td>
    <td>${parseInt(d.avgLatency)}ms</td><td>${parseInt(d.p50)}ms</td><td>${parseInt(d.p95)}ms</td><td>${parseInt(d.p99)}ms</td><td>${parseInt(d.reqPerSec)}</td>`;
  // Set path cell via textContent to prevent XSS
  bRow.cells[3].textContent = String(path).slice(0,50);
  const tbody = document.getElementById('bench-body');
  if(tbody.querySelector('td[colspan]')) tbody.innerHTML='';
  tbody.prepend(bRow);
  log(`Load test n=${n} c=${c}: ${d.successRate}% · avg ${d.avgLatency}ms · p99 ${d.p99}ms`,d.successRate>=CFG.RATE_GOOD_PCT?'success':'warning');
  toast(`Load test: ${d.successRate}% success`,d.successRate>=CFG.RATE_GOOD_PCT?'success':'warning');
}

// ═══ REPLICATION ═══
async function checkRepl(btnEl){
  if(!S.base){ toast('Not connected','warning'); return; }
  if(btnEl){ btnEl.disabled=true; btnEl.textContent='CHECKING...'; }
  fetch(`${S.base}/api/replication`,{signal:AbortSignal.timeout(CFG.REPL_CHECK_TIMEOUT_MS),headers:{'x-ha-token':CFG.AUTH_TOKEN}})
    .then(r=>r.json())
    .then(r=>{
      updateReplUI(r);
      addEvidence('replication · /api/replication', r);
      log(`Replication: ${r.replicating?r.replicas?.length+' replica(s) streaming':'no replicas connected'} · lag ${r.lagMs!==null?r.lagMs+'ms':'unknown'}`, r.replicating?'success':'warning');
      toast(r.replicating?`Replication active · ${r.replicas?.length} replica(s) · ${r.lagMs}ms lag`:'No replicas connected', r.replicating?'success':'warning');
    })
    .catch(e=>{
      log(`Replication check failed: ${e.message}`,'error');
      toast('Replication check failed','error');
    })
    .finally(()=>{ if(btnEl){ btnEl.disabled=false; btnEl.textContent='VERIFY'; }});
}

function updateReplUI(r){
  if(!r) return;

  // Overall badge
  const badge = document.getElementById('repl-overall-badge');
  if(badge){
    badge.textContent = r.replicating ? `${r.replicas?.length||0} STREAMING` : 'OFFLINE';
    badge.className = r.replicating ? 'badge badge-green' : 'badge badge-muted';
    badge.style.borderColor = r.replicating ? 'var(--amber)' : '';
    badge.style.color = r.replicating ? 'var(--amber)' : '';
  }

  // Lag
  const lagEl = document.getElementById('repl-lag');
  if(lagEl){
    lagEl.textContent = r.lagMs!==null ? (r.lagMs===0?'<1ms':r.lagMs+'ms') : '—';
    lagEl.style.color = r.lagMs!==null ? (r.lagMs<50?'var(--amber)':r.lagMs<100?'var(--amber)':'var(--red)') : 'var(--text3)';
  }

  // Replica count
  const countEl = document.getElementById('repl-count');
  const totalEl = document.getElementById('repl-total');
  const replicaNodes = nodeList().filter(n=>n.db==='replica');
  if(countEl) countEl.textContent = `${r.replicas?.length||0}/${replicaNodes.length}`;
  if(countEl) countEl.style.color = (r.replicas?.length||0)===replicaNodes.length ? 'var(--amber)' : 'var(--red)';
  if(totalEl) totalEl.textContent = replicaNodes.length;

  // Update target tables
  if(r.lagMs!==null){
    setTarget('lag', r.lagMs===0?'<1ms ✓':r.lagMs+'ms', r.lagMs<TARGETS.REPL_LAG_MS);
    setTarget('lag-peak', r.lagMs===0?'<1ms ✓':r.lagMs+'ms', r.lagMs<TARGETS.REPL_LAG_PEAK);
  }
  if(r.replicating){
    setTarget('rpo','0s ✓',true);
    setTarget('replicas',`${r.replicas?.length||0}/${replicaNodes.length} streaming`,true);
  }

  // Compat IDs
  const recovEl = document.getElementById('repl-recovery');
  if(recovEl){
    const cnt = r.replicas?.length||0;
    recovEl.textContent = cnt ? `t (true) — ${cnt} replica${cnt>1?'s':''} streaming` : 'f (false)';
    recovEl.style.color = cnt ? 'var(--amber)' : 'var(--red)';
  }
  const lagSub = document.getElementById('repl-lag-sub');
  if(lagSub) lagSub.textContent = `of ${replicaNodes.length} configured`;

  // Dynamic topology diagram
  renderReplTopology(r);

  // Live replica table
  renderReplicaTable(r);

  // Update slot status compat
  const slotEl = document.getElementById('repl-slot-status');
  if(slotEl) slotEl.textContent = r.slots?.some(s=>s.active)?'active':'inactive';
}

function renderReplTopology(r){
  const wrap = document.getElementById('repl-topology');
  if(!wrap) return;
  const master = masterNode();
  const replicas = nodeList().filter(n=>n.db==='replica');
  if(!master){ wrap.innerHTML='<div style="font-family:var(--mono);font-size:11px;color:var(--text3);padding:12px;text-align:center">No master node configured</div>'; return; }

  const masterOnline = S.nodes[master.name]?.status==='online';
  const masterColor = masterOnline ? 'var(--amber)' : 'var(--red)';

  wrap.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px;background:var(--bg3);border:1px solid var(--border)">
    <div style="flex:1;min-width:80px;background:var(--bg4);border:2px solid ${masterColor};padding:8px 10px;text-align:center;box-shadow:0 0 8px ${masterColor}30">
      <div style="font-size:8px;color:var(--text3);text-transform:uppercase;letter-spacing:.1em">MASTER</div>
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:var(--yellow);margin-top:2px">${escapeHtml(master.label||master.name)}</div>
      <div style="font-size:9px;color:${masterColor};margin-top:2px">${masterOnline?'ONLINE':'OFFLINE'}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
      ${replicas.map((_,i)=>{
        const streaming = r?.replicas?.length > i;
        return `<div style="font-size:16px;color:${streaming?'var(--amber)':'var(--text3)'};${streaming?'text-shadow:var(--amber-glow)':''};animation:${streaming?'arrowPulse .8s ease infinite alternate':'none'}">──▶</div>`;
      }).join('')}
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;flex:2">
      ${replicas.map((rep,i)=>{
        const connected = r?.replicas?.some(rv=>rv.client_addr===rep.ip || i < (r?.replicas?.length||0));
        const repOnline = S.nodes[rep.name]?.status==='online';
        const repColor = connected && repOnline ? 'var(--border2)' : 'var(--border)';
        const lag = r?.replicas?.[i];
        return `<div style="background:var(--bg4);border:1px solid ${repColor};padding:7px 10px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.1em">REPLICA ${i+1}</div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text)">${escapeHtml(rep.label||rep.name)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:9px;color:${connected?'var(--amber)':'var(--text3)'}">${connected?lag?.state||'streaming':'disconnected'}</div>
            <div style="font-size:9px;color:var(--text3)">${repOnline?S.nodes[rep.name]?.lat+'ms':'offline'}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderReplicaTable(r){
  const wrap = document.getElementById('repl-replica-table');
  if(!wrap) return;
  if(!r?.replicas?.length){
    wrap.innerHTML='<div style="font-family:var(--mono);font-size:11px;color:var(--red);padding:8px">No replicas connected to master</div>';
    return;
  }
  wrap.innerHTML = `<table class="rtable">
    <thead><tr><th>CLIENT IP</th><th>STATE</th><th>WRITE LAG</th><th>FLUSH LAG</th><th>REPLAY LAG</th></tr></thead>
    <tbody>
      ${r.replicas.map(rep=>`
        <tr>
          <td style="font-family:var(--mono)">${escapeHtml(rep.client_addr||'—')}</td>
          <td><span style="color:var(--amber)">${escapeHtml(rep.state||'—')}</span></td>
          <td style="font-family:var(--mono)">${rep.write_lag||'<1ms'}</td>
          <td style="font-family:var(--mono)">${rep.flush_lag||'<1ms'}</td>
          <td style="font-family:var(--mono)">${rep.replay_lag||'<1ms'}</td>
        </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderReplChaosButtons(){
  const wrap = document.getElementById('chaos-btn-list');
  const dbWrap = document.getElementById('chaos-db-btn-list');
  const nodes = nodeNames();
  const empty = '<span style="font-family:var(--mono);font-size:10px;color:var(--text3)">No nodes loaded</span>';
  if(!nodes.length){
    if(wrap) wrap.innerHTML = empty;
    if(dbWrap) dbWrap.innerHTML = empty;
    return;
  }
  if(wrap) wrap.innerHTML = nodes.map(name=>
    `<button class="btn btn-danger btn-sm" onclick="chaosKill('${escapeHtml(name)}')">KILL ${escapeHtml(name.toUpperCase())}</button>`
  ).join('');
  if(dbWrap) dbWrap.innerHTML = nodes.map(name=>{
    const isLeader = S.patroni?.leader?.name === name;
    const isUnreachable = S.patroni?.members?.find(m=>m.name===name)?.state === 'unreachable';
    const killLabel = isLeader ? `KILL DB ${name.toUpperCase()} ★` : `KILL DB ${name.toUpperCase()}`;
    const restoreBtn = isUnreachable
      ? `<button class="btn btn-primary btn-sm" onclick="chaosRestoreDb('${escapeHtml(name)}')">RESTORE ${escapeHtml(name.toUpperCase())}</button>`
      : '';
    return `<button class="btn btn-danger btn-sm" onclick="chaosKillDb('${escapeHtml(name)}')">${killLabel}</button>${restoreBtn}`;
  }).join('') + (nodes.length ? `<button class="btn btn-primary btn-sm" onclick="chaosRestoreAllDb()" style="margin-left:auto">RESTORE ALL</button>` : '');
}

function renderReplCommands(){
  const wrap = document.getElementById('repl-cmd-list');
  if(!wrap) return;
  const nodes = nodeList();
  if(!nodes.length){ wrap.innerHTML='<div style="font-family:var(--mono);font-size:11px;color:var(--text3)">No nodes loaded</div>'; return; }
  wrap.innerHTML = nodes.map(n=>{
    const stopCmd = n.os==='macos'
      ? `launchctl unload ~/Library/LaunchAgents/com.ha-app.plist`
      : `systemctl stop ha-app`;
    const startCmd = n.os==='macos'
      ? `launchctl load ~/Library/LaunchAgents/com.ha-app.plist`
      : `systemctl start ha-app`;
    return `<div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border)">
      <div style="font-size:9px;font-weight:700;letter-spacing:.15em;color:var(--amber);text-transform:uppercase;margin-bottom:6px">${escapeHtml(n.label||n.name)}</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--text2);line-height:2">
        <div><span style="color:var(--text3)">stop:&nbsp;&nbsp;</span><code style="background:var(--bg4);padding:1px 6px;border:1px solid var(--border)">${escapeHtml(stopCmd)}</code></div>
        <div><span style="color:var(--text3)">start: </span><code style="background:var(--bg4);padding:1px 6px;border:1px solid var(--border)">${escapeHtml(startCmd)}</code></div>
        <div><span style="color:var(--text3)">ssh:&nbsp;&nbsp;&nbsp;</span><code style="background:var(--bg4);padding:1px 6px;border:1px solid var(--border)">ssh -i ~/.ssh/ha_key ${n.local?'root@127.0.0.1':escapeHtml(n.sshUser||'root')+'@'+escapeHtml(n.sshHost||n.ip)}${n.sshPort&&n.sshPort!==22?' -p '+n.sshPort:''}</code></div>
      </div>
    </div>`;
  }).join('');
}

function toggleReplCommands(){
  const body = document.getElementById('repl-cmd-body');
  const arrow = document.getElementById('repl-cmd-toggle');
  if(!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if(arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
  if(!open) renderReplCommands();
}


function updateRecoveryList(){
  const wrap=document.getElementById('recovery-list');
  if(Object.keys(S.chaosEvents).length===0){
    wrap.innerHTML='<div class="empty-state" style="font-family:var(--mono);font-size:11px;color:var(--text3);padding:8px">No chaos events yet.</div>';
    return;
  }
  wrap.innerHTML='';
  Object.entries(S.chaosEvents).forEach(([name,ev])=>{
    const el=document.createElement('div');
    el.className='recovery-item';
    if(!ev.confirmed){
      el.innerHTML=`
        <span class="recovery-node">${escapeHtml(name)}</span>
        <span class="recovery-status" style="color:var(--amber)">⏳ verifying kill via SSH...</span>
        <span class="recovery-time">~1.5s</span>`;
    } else if(!ev.recoveredAt){
      const downSec=((Date.now()-ev.killedAt)/1000).toFixed(1);
      el.innerHTML=`
        <span class="recovery-node">${escapeHtml(name)}</span>
        <span class="recovery-status" style="color:var(--red)">● offline — waiting for auto-recovery</span>
        <span class="recovery-time">down ${downSec}s</span>`;
    } else {
      const totalSec=((ev.recoveredAt-ev.killedAt)/1000).toFixed(1);
      el.innerHTML=`
        <span class="recovery-node">${escapeHtml(name)}</span>
        <span class="recovery-status">✓ auto-recovered</span>
        <span class="recovery-time recovered">back in ${totalSec}s</span>`;
    }
    wrap.appendChild(el);
  });
}

// Poll countdown state
let _lastPollTime = null;
let _nextPollIn = 0;

function updatePollCountdown(){
  const el = document.getElementById('s-countdown');
  const lastEl = document.getElementById('s-last-poll');
  const logTimeEl = document.getElementById('last-poll-time');
  if(el){
    if(!S.base){ el.textContent='—'; el.className='stat-value sv-muted'; return; }
    if(_nextPollIn > 0){
      el.textContent = _nextPollIn+'s';
      el.className = _nextPollIn<=3?'stat-value sv-amber':'stat-value sv-muted';
      _nextPollIn = Math.max(0, _nextPollIn-1);
    } else {
      el.textContent = '...';
      el.className = 'stat-value sv-amber';
    }
  }
  if(lastEl && _lastPollTime){
    const ago = Math.round((Date.now()-_lastPollTime)/1000);
    lastEl.textContent = ago<60?`polled ${ago}s ago`:`polled ${Math.floor(ago/60)}m ago`;
  }
  if(logTimeEl && _lastPollTime){
    logTimeEl.textContent = new Date(_lastPollTime).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
}

// Update recovery timers + cache age every second
setInterval(()=>{
  const onRepl = document.getElementById('page-replication')?.classList.contains('active');
  if(onRepl && Object.keys(S.chaosEvents).some(n=>!S.chaosEvents[n].recoveredAt)){
    updateRecoveryList();
  }
  // Live cache-age labels on nodes page — only when visible
  updatePollCountdown();
  const nodesActive=document.getElementById('page-nodes')?.classList.contains('active');
  if(nodesActive && Object.keys(S.metricsTs).length){
    nodeNames().forEach(n=>{
      const el=document.getElementById('mts-'+n);
      if(el && S.metricsTs[n]) el.textContent='updated '+Math.round((Date.now()-S.metricsTs[n])/1000)+'s ago';
    });
  }
},1000);


