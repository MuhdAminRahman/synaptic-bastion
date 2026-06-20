// ═══ CLUSTER MANAGEMENT ═══════════════════════════════════════════════════
const PROVISION_STEPS = {
  ssh:       'SSH Connectivity',
  ssh_key:   'Deploy SSH Key',
  os_detect: 'Detect OS',
  deps:      'Install Dependencies',
  tailscale: 'Tailscale VPN',
  deploy:    'Deploy Source',
  compile:   'Compile App',
  service:   'Setup Service',
  postgres:  'PostgreSQL Setup',
  health:    'Health Check',
  register:  'Register Node',
};
const PROVISION_STEP_KEYS = Object.keys(PROVISION_STEPS);

async function refreshClusterPage(){
  if(!S.base){ toast('Not connected','warning'); return; }
  try{
    const nodes = await api('/api/config/nodes');
    S.nodeConfig = nodes;
    renderClusterRoster();
  }catch(e){ toast('Failed to load nodes: '+e.message,'error'); }
}

function renderClusterRoster(){
  const wrap = document.getElementById('cluster-roster');
  if(!wrap) return;
  const names = nodeNames();

  const sumEl = document.getElementById('cluster-summary');
  const onlineCount = names.filter(n=>S.nodes[n]?.status==='online').length;
  if(sumEl) sumEl.textContent = names.length ? `${onlineCount}/${names.length} ONLINE` : '—';

  if(!names.length){
    wrap.innerHTML='<div style="padding:20px;font-family:var(--mono);font-size:11px;color:var(--text3);text-align:center;letter-spacing:.08em">NO NODES REGISTERED — CLICK ENLIST NODE TO ADD</div>';
    return;
  }

  wrap.innerHTML = `<table class="roster-table">
    <thead>
      <tr>
        <th style="width:180px">NODE</th>
        <th>ADDRESS</th>
        <th>ROLE</th>
        <th>DB</th>
        <th>OS / SERVICE</th>
        <th>STATUS</th>
        <th style="width:130px">ACTIONS</th>
      </tr>
    </thead>
    <tbody>
      ${names.map(name=>{
        const n = S.nodeConfig[name];
        const status = S.nodes[name]?.status || 'unknown';
        const lat = S.nodes[name]?.lat;
        const statusBadge = status==='online'
          ? `<span class="roster-badge online">ONLINE${lat?' &nbsp;'+lat+'ms':''}</span>`
          : status==='offline'
          ? `<span class="roster-badge offline">OFFLINE</span>`
          : `<span class="roster-badge">—</span>`;
        const dbBadge = n.db==='master'
          ? `<span class="roster-badge master">MASTER</span>`
          : n.db==='replica'
          ? `<span class="roster-badge replica">REPLICA</span>`
          : `<span class="roster-badge">NONE</span>`;
        return `<tr>
          <td>
            <div class="roster-node-name">${escapeHtml(name)}</div>
            <div class="roster-label">${escapeHtml(n.label||'')}</div>
          </td>
          <td>
            <div class="roster-ip">${escapeHtml(n.ip)}:${n.appPort}</div>
            <div class="roster-label">ssh ${escapeHtml(n.sshUser||'root')}@${escapeHtml(n.sshHost||n.ip)}:${n.sshPort||22}</div>
          </td>
          <td><span class="roster-badge">${escapeHtml(n.role||'—')}</span></td>
          <td>${dbBadge}</td>
          <td>
            <div style="font-size:11px">${escapeHtml(n.os||'—')}</div>
            <div class="roster-label">${escapeHtml(n.serviceType||'—')}</div>
          </td>
          <td>${statusBadge}</td>
          <td onclick="event.stopPropagation()">
            <div class="roster-actions">
              <button class="btn btn-ghost btn-sm" onclick="editNode('${escapeHtml(name)}')">EDIT</button>
              <button class="btn btn-danger btn-sm" onclick="removeNode('${escapeHtml(name)}')">REMOVE</button>
            </div>
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}


function showAddNodeForm(prefill={}){
  const panel = document.getElementById('add-node-panel');
  panel.style.display='';
  // Prefill if editing
  if(prefill.name) document.getElementById('an-name').value=prefill.name;
  if(prefill.label) document.getElementById('an-label').value=prefill.label;
  if(prefill.ip) document.getElementById('an-ip').value=prefill.ip;
  if(prefill.appPort) document.getElementById('an-appport').value=prefill.appPort;
  if(prefill.sshHost) document.getElementById('an-sshhost').value=prefill.sshHost;
  if(prefill.sshPort) document.getElementById('an-sshport').value=prefill.sshPort;
  if(prefill.sshUser) document.getElementById('an-sshuser').value=prefill.sshUser;
  if(prefill.role) document.getElementById('an-role').value=prefill.role;
  if(prefill.db) document.getElementById('an-db').value=prefill.db;
  if(prefill.serviceType) document.getElementById('an-service').value=prefill.serviceType;
  panel.scrollIntoView({behavior:'smooth',block:'start'});
}

function hideAddNodeForm(){
  document.getElementById('add-node-panel').style.display='none';
  document.getElementById('provision-panel').style.display='none';
  clearProvisionForm();
}

function clearProvisionForm(){
  ['an-name','an-label','an-ip','an-sshhost','an-sshpass','an-dbhost','an-dbpass'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.value='';
  });
  const appPort=document.getElementById('an-appport');
  if(appPort) appPort.value='8080';
  const sshPort=document.getElementById('an-sshport');
  if(sshPort) sshPort.value='22';
}

function getNodeFormData(){
  return {
    name:        document.getElementById('an-name').value.trim(),
    label:       document.getElementById('an-label').value.trim(),
    ip:          document.getElementById('an-ip').value.trim(),
    appPort:     parseInt(document.getElementById('an-appport').value)||8080,
    sshHost:     document.getElementById('an-sshhost').value.trim()||document.getElementById('an-ip').value.trim(),
    sshPort:     parseInt(document.getElementById('an-sshport').value)||22,
    sshUser:     document.getElementById('an-sshuser').value.trim()||'root',
    sshPassword: document.getElementById('an-sshpass').value||'',
    role:        document.getElementById('an-role').value,
    db:          document.getElementById('an-db').value,
    serviceType: document.getElementById('an-service').value,
    dbHost:      document.getElementById('an-dbhost')?.value.trim()||'localhost',
    dbPass:      document.getElementById('an-dbpass')?.value||'secure-password-here',
  };
}

async function addNodeManual(){
  if(!S.base){ toast('Not connected','warning'); return; }
  const data = getNodeFormData();
  if(!data.name||!data.ip){ toast('Name and IP are required','warning'); return; }
  try{
    const r = await fetch(`${S.base}/api/config/nodes`,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-ha-token':CFG.AUTH_TOKEN},
      body:JSON.stringify(data),
      signal:AbortSignal.timeout(5000),
    });
    const res = await r.json();
    if(!r.ok) throw new Error(res.error||'Failed to add node');
    S.nodeConfig[data.name] = res.node;
    S.nodes[data.name] = {status:'unknown',lat:null,up:0,total:0,hist:[]};
    S.hist[data.name] = [];
    renderNodeGrid();
    renderClusterRoster();
    renderReplChaosButtons();
    if(S.patroni) renderNodeGridPatroni(S.patroni);
    checkPatroni().catch(()=>{});
    initChart();
    hideAddNodeForm();
    toast(`Node '${data.name}' added`,'success');
    log(`Node '${data.name}' registered at ${data.ip}:${data.appPort}`,'success');
    pollNow();
  }catch(e){ toast(e.message,'error'); }
}

async function editNode(name){
  const node = S.nodeConfig[name];
  if(!node){ toast('Node not found','error'); return; }
  showAddNodeForm(node);
  document.getElementById('add-node-title').textContent=`Edit Node — ${name}`;
  // Override submit to use PUT
  window._editingNode = name;
}

async function removeNode(name){
  if(!S.base){ toast('Not connected','warning'); return; }
  if(!confirm(`Remove node '${name}' from the cluster? This only removes the config — it does not stop the app on the server.`)) return;
  try{
    const r = await fetch(`${S.base}/api/config/nodes/${name}`,{
      method:'DELETE',
      headers:{'x-ha-token':CFG.AUTH_TOKEN},
      signal:AbortSignal.timeout(5000),
    });
    if(!r.ok) throw new Error((await r.json()).error||'Failed');
    delete S.nodeConfig[name];
    delete S.nodes[name];
    delete S.hist[name];
    delete S.metrics[name];
    delete S.metricsTs[name];
    renderNodeGrid();
    renderClusterRoster();
    renderReplChaosButtons();
    if(S.patroni) renderNodeGridPatroni(S.patroni);
    checkPatroni().catch(()=>{});
    initChart(); // rebuild chart datasets
    toast(`Node '${name}' removed`,'success');
    log(`Node '${name}' removed from cluster config`,'warning');
  }catch(e){ toast(e.message,'error'); }
}

// ── Provisioning ────────────────────────────────────────────────────────────
let _provisionJobId = null;
let _provisionPollTimer = null;
let _provisionStartTime = null;
let _provisionElapsedTimer = null;

async function provisionNode(){
  if(!S.base){ toast('Not connected','warning'); return; }
  if(!validateAllFields()) return;
  const data = getNodeFormData();

  const provPanel = document.getElementById('provision-panel');
  const stepsEl = document.getElementById('provision-steps');
  const resultEl = document.getElementById('provision-result');
  const overallEl = document.getElementById('prov-overall');
  const fillEl = document.getElementById('prov-progress-fill');
  const stepLabel = document.getElementById('prov-step-label');

  provPanel.style.display='';
  document.getElementById('provision-node-name').textContent = data.name.toUpperCase();
  resultEl.style.display='none';
  if(overallEl) overallEl.textContent='INITIALIZING...';
  if(fillEl) fillEl.style.width='0%';
  if(stepLabel) stepLabel.textContent='STEP 0 / 11';

  stepsEl.innerHTML = PROVISION_STEP_KEYS.map(key=>`
    <div class="prov-step" id="pstep-${key}" data-status="pending">
      <span class="pstep-icon">○</span>
      <span class="pstep-label">${PROVISION_STEPS[key]}</span>
      <span class="pstep-detail" id="pdetail-${key}"></span>
    </div>`).join('');

  provPanel.scrollIntoView({behavior:'smooth'});
  _provisionStartTime = Date.now();

  if(_provisionElapsedTimer) clearInterval(_provisionElapsedTimer);
  _provisionElapsedTimer = setInterval(()=>{
    const el=document.getElementById('prov-elapsed');
    if(el) el.textContent=Math.floor((Date.now()-_provisionStartTime)/1000)+'s';
  }, 1000);

  try{
    const r = await fetch(`${S.base}/api/provision`,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-ha-token':CFG.AUTH_TOKEN},
      body:JSON.stringify(data),
      signal:AbortSignal.timeout(10000),
    });
    const job = await r.json();
    _provisionJobId = job.jobId;
    if(_provisionPollTimer) clearInterval(_provisionPollTimer);
    _provisionPollTimer = setInterval(()=>pollProvisionJob(_provisionJobId, data.name), 2000);
    pollProvisionJob(_provisionJobId, data.name);
  }catch(e){
    clearInterval(_provisionElapsedTimer);
    toast('Failed to start: '+e.message,'error');
    renderProvisionStep('ssh','error',e.message);
    if(overallEl) overallEl.textContent='FAILED';
  }
}

async function pollProvisionJob(jobId, nodeName){
  try{
    const r = await fetch(`${S.base}/api/provision/${jobId}`,{
      headers:{'x-ha-token':CFG.AUTH_TOKEN},
      signal:AbortSignal.timeout(5000),
    });
    const job = await r.json();

    // Update each step
    // Show Tailscale auth URL if waiting
    if(job.tailscaleAuthUrl && job.awaitingTailscaleAuth){
      let authBanner = document.getElementById('ts-auth-banner');
      if(!authBanner){
        authBanner = document.createElement('div');
        authBanner.id = 'ts-auth-banner';
        authBanner.style.cssText = 'background:var(--amber-dim);border:1px solid var(--amber);color:var(--amber);padding:10px 14px;font-size:11px;letter-spacing:.04em;margin-bottom:8px';
        document.getElementById('provision-steps').before(authBanner);
      }
      authBanner.innerHTML = `⚠ TAILSCALE AUTH REQUIRED<br><a href="${job.tailscaleAuthUrl}" target="_blank" style="color:var(--yellow);word-break:break-all">${job.tailscaleAuthUrl}</a><br><span style="font-size:10px;color:var(--text3)">Open the link above in your browser to authorise this node. Provisioning will continue automatically.</span>`;
    } else {
      const banner = document.getElementById('ts-auth-banner');
      if(banner) banner.remove();
    }

    job.steps.forEach(s=>renderProvisionStep(s.step, s.status, s.detail));

    if(job.status==='done'||job.status==='error'){
      clearInterval(_provisionPollTimer);
      _provisionPollTimer=null;

      const resEl=document.getElementById('provision-result');
      resEl.style.display='';
      if(job.status==='done'){
        resEl.style.background='var(--green-dim)';
        resEl.style.border='1px solid var(--green2)';
        resEl.style.color='var(--green)';
        resEl.textContent=`✓ Node '${nodeName}' provisioned and added to cluster`;
        // Reload node config
        const nc=await api('/api/config/nodes');
        S.nodeConfig=nc;
        Object.keys(S.nodeConfig).forEach(n=>{
          if(!S.nodes[n]) S.nodes[n]={status:'unknown',lat:null,up:0,total:0,hist:[]};
          if(!S.hist[n]) S.hist[n]=[];
        });
        renderNodeGrid();
        renderClusterRoster();
        renderReplChaosButtons();
        if(S.patroni) renderNodeGridPatroni(S.patroni);
        checkPatroni().catch(()=>{});
        initChart();
        pollNow();
        toast(`Node '${nodeName}' provisioned successfully`,'success');
        log(`Node '${nodeName}' provisioned and added to cluster`,'success');
      }else{
        resEl.style.background='var(--red-dim)';
        resEl.style.border='1px solid var(--red)';
        resEl.style.color='var(--red)';
        resEl.textContent=`✗ Provisioning failed: ${job.error||'unknown error'}`;
        toast(`Provisioning failed: ${job.error}`,'error');
      }
    }
  }catch(e){ console.warn('Provision poll error:', e.message); }
}

function renderProvisionStep(step, status, detail=''){
  const el=document.getElementById('pstep-'+step);
  const detEl=document.getElementById('pdetail-'+step);
  if(!el) return;
  const icons={pending:'○',running:'⟳',done:'✓',error:'✗'};
  const colors={pending:'var(--text3)',running:'var(--amber)',done:'var(--green)',error:'var(--red)'};
  el.querySelector('.pstep-icon').textContent=icons[status]||'○';
  el.style.color=colors[status]||'var(--text3)';
  el.dataset.status=status;
  if(status==='running') el.querySelector('.pstep-icon').style.animation='spin 1s linear infinite';
  else el.querySelector('.pstep-icon').style.animation='';
  if(detEl && detail) detEl.textContent=' — '+detail;
}

initChart();
renderTestGrid();

// Boot sequence + auto-connect
(async function autoConnect(){
  const ipEl = document.getElementById('cfg-ip');
  if(ipEl && CFG.PROXY_HOST) ipEl.value = CFG.PROXY_HOST;

  // Animate boot status
  const bootEl = document.getElementById('boot-status');
  const bootLines = [
    'LOADING CLUSTER INTERFACE...',
    'CHECKING PROXY ENDPOINT...',
    `PINGING FLOATING IP ${CFG.PROXY_HOST}:${CFG.PROXY_PORT}...`,
  ];
  if(bootEl){
    for(const line of bootLines){
      bootEl.textContent = line;
      await sleep(300);
    }
  }

  if(!CFG.PROXY_HOST || S.base) return;
  try{
    const r = await fetch(`http://${CFG.PROXY_HOST}:${CFG.PROXY_PORT}${CFG.PROXY_PATH||''}/api/health`,{
      signal: AbortSignal.timeout(3000)
    });
    if(r.ok){
      if(bootEl) bootEl.textContent = 'CONNECTION ESTABLISHED. AUTHENTICATING...';
      await sleep(200);
      connect();
    } else {
      if(bootEl) bootEl.textContent = 'PROXY OFFLINE. ENTER ADDRESS MANUALLY.';
    }
  }catch(e){
    if(bootEl) bootEl.textContent = 'PROXY UNREACHABLE. ENTER ADDRESS MANUALLY.';
  }
})();
