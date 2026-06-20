// ═══ CONNECT — verifies proxy before accepting ═══
async function connect(){
  const ip = document.getElementById('cfg-ip').value.trim();
  const errEl = document.getElementById('connect-error');
  const btn = document.getElementById('connect-btn');
  const btnText = btn?.querySelector('.connect-btn-text');
  const btnLoading = btn?.querySelector('.connect-btn-loading');
  const input = document.getElementById('cfg-ip');

  if(!ip){ showConnectError('Enter an IP address'); return; }

  // Show loading state
  if(btn) btn.disabled = true;
  if(btnText) btnText.style.display = 'none';
  if(btnLoading) btnLoading.style.display = 'inline';
  if(errEl) errEl.textContent = `Connecting to ${ip}:${CFG.PROXY_PORT}...`;

  const base = `http://${ip}:${CFG.PROXY_PORT}${CFG.PROXY_PATH||''}`;

  try {
    const res = await fetch(base+'/api/health', { signal: AbortSignal.timeout(CFG.CONNECT_TIMEOUT_MS) });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if(data.status !== 'ok') throw new Error('Proxy returned unexpected status');

    // SUCCESS — load node config from proxy
    const ncRes = await fetch(`${base}/api/config/nodes`,{signal:AbortSignal.timeout(5000),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
    S.nodeConfig = await ncRes.json();
    S.base = base;
    // Init per-node runtime state
    Object.keys(S.nodeConfig).forEach(n=>{
      if(!S.nodes[n]) S.nodes[n]={status:'unknown',lat:null,up:0,total:0,hist:[]};
    });
    document.body.classList.add('connected');
    document.getElementById('setup-card').classList.add('hidden');
    document.getElementById('header-conn').classList.remove('hidden');
    const nodeCount = Object.keys(S.nodeConfig).length;
    document.getElementById('conn-label').textContent = `Live — ${ip}:${CFG.PROXY_PORT} · nodes: ${Object.keys(S.nodeConfig).join(', ')}`;
    const shortEl = document.getElementById('conn-label-short');
    if(shortEl) shortEl.textContent = `${nodeCount} nodes`;
    // Render node cards first, then show loading state, then poll
    renderNodeGrid();
    renderClusterRoster();
    renderReplChaosButtons();
    if(S.patroni) renderNodeGridPatroni(S.patroni);
    checkPatroni().catch(()=>{});
    // Populate probe-node select
    const pn=document.getElementById('probe-node');
    if(pn){ pn.innerHTML=nodeNames().map(n=>`<option value="${n}">${n}</option>`).join(''); }
    initChart();
    // Show loading state on freshly rendered cards
    nodeNames().forEach(n=>{
      const st=document.getElementById('nst-'+n);
      if(st) st.textContent='polling...';
    });
    pollNow();
    if(S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = setInterval(pollNow, CFG.POLL_MS);
    log(`Connected to proxy at ${base}`,'success');
    toast('Connected — proxy verified','success');
  } catch(e) {
    showConnectError(`Cannot reach ${ip}:${CFG.PROXY_PORT} — ${e.message}`);
    input.classList.add('error');
    setTimeout(()=>input.classList.remove('error'), 600);
  }

  if(btn) btn.disabled = false;
  if(btnText) btnText.style.display = '';
  if(btnLoading) btnLoading.style.display = 'none';
}

function showConnectError(msg){
  const el = document.getElementById('connect-error');
  el.textContent = '✗ ' + msg;
}

// ═══ DISCONNECT — full reset ═══
function disconnect(){
  if(S.pollTimer){ clearInterval(S.pollTimer); S.pollTimer = null; }
  if(S.metricsTimer){ clearInterval(S.metricsTimer); S.metricsTimer = null; }
  _DOM = null; // invalidate DOM cache on disconnect
  S.base = null;
  S.reqs = 0; S.ok = 0;
  S.chaosEvents = {};

  S.nodeConfig = {};
  S.nodes = {};
  S.metrics = {};
  S.metricsTs = {};
  document.getElementById('sys-badge').className = 'sys-badge badge-off';
  document.getElementById('sys-text').textContent = 'OFFLINE';
  document.getElementById('s-online').textContent = '—';
  document.getElementById('s-online').className = 'stat-value sv-muted';
  document.getElementById('s-lat').textContent = '—';
  document.getElementById('s-lat').className = 'stat-value sv-muted';
  document.getElementById('s-reqs').textContent = '—';
  document.getElementById('s-rate').textContent = '—';
  document.getElementById('s-rate').className = 'stat-value sv-muted';
  document.getElementById('connect-error').textContent = '';
  document.getElementById('recovery-list').innerHTML = '<div class="empty-state" style="font-family:var(--mono);font-size:11px;color:var(--text3);padding:8px">No chaos events yet.</div>';
  if(chart){ chart.destroy(); chart = null; }
  initChart();

  document.body.classList.remove('connected');
  document.getElementById('setup-card').classList.remove('hidden');
  document.getElementById('header-conn').classList.add('hidden');
  document.getElementById('cfg-ip').value = '';
  document.getElementById('connect-error').textContent = '';
  log('Disconnected — all state cleared','warning');
}

function resetNodeUI(n){
  const card=document.getElementById('node-'+n); if(!card) return;
  card.className='node checking';
  const dot=document.getElementById('ndot-'+n); if(dot){ dot.className='dot dot-chk'; }
  const st=document.getElementById('nst-'+n); if(st){ st.textContent='—'; st.className='node-st muted'; }
  const nh=document.getElementById('nh-'+n); if(nh){ nh.textContent='—'; nh.className='nm-val muted'; }
  const nl=document.getElementById('nl-'+n); if(nl){ nl.textContent='—'; nl.className='nm-val muted'; }
  const nu=document.getElementById('nu-'+n); if(nu){ nu.textContent='—'; nu.className='nm-val muted'; }
  const ubn=document.getElementById('nbar-'+n); if(ubn) ubn.style.width='0%';
}


function pushHist(name, lat){
  if(!S.hist[name]) S.hist[name]=[];
  S.hist[name].push(lat);
  if(S.hist[name].length > HIST) S.hist[name].shift();
}
