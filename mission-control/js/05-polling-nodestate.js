// ═══ POLLING ═══
async function pollNow(){
  if(!S.base) return;
  if(S.polling){ return; } // deduplicate concurrent polls
  S.polling = true;
  _lastPollTime = Date.now();
  _nextPollIn = Math.round(CFG.POLL_MS/1000);
  try{
    const r=await fetch(S.base+'/api/nodes',{signal:AbortSignal.timeout(CFG.POLL_TIMEOUT_MS),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
    const d=await r.json();
    d.nodes.forEach(n=>{
      const prev=S.nodes[n.name]?.status;
      setNode(n.name, n.status, n.latency);

      if(n.status==='online'){ pushHist(n.name,n.latency); S.reqs++; S.ok++; }
      else S.reqs++;
      // Recovery detection
      if(prev==='offline' && n.status==='online' && S.chaosEvents[n.name]){
        S.chaosEvents[n.name].recoveredAt = Date.now();
        updateRecoveryList();
      }
    });
    updateChart(); updateSummary(); updateSys();
  }catch(e){ log('Poll failed: '+e.message,'error'); }
  finally{
    S.polling = false;
    // Auto-refresh Patroni if replication page is active
    if(document.getElementById('page-replication')?.classList.contains('active')){
      checkPatroni().catch(()=>{});
    }
  }
}

// ═══ NODE STATE ═══
function openAllNodeHealth(){
  nodeNames().forEach(name => openNodeHealth(name));
}

function openNodeHealth(name){
  // Opens raw health JSON via proxy pass-through — direct port 8080 is Tailscale-only
  const url = `http://${CFG.PROXY_HOST}:${CFG.PROXY_PORT}${CFG.PROXY_PATH}/api/node/${name}/live`;
  window.open(url, '_blank');
}

function renderNodeGrid(){
  const grid=document.getElementById('nodes-grid');
  if(!grid) return;
  const nodes=nodeList();
  if(!nodes.length){
    grid.innerHTML='<div style="font-family:var(--mono);font-size:12px;color:var(--text3);padding:20px;grid-column:1/-1">No nodes configured. Go to Cluster page to add nodes.</div>';
    return;
  }
  grid.innerHTML=nodes.map(node=>{
    const n=node.name;
    const dbBadgeColor = node.db==='master' ? 'var(--blue)' : node.db==='replica' ? 'var(--text3)' : 'var(--text3)';
    const dbBadgeBorder = node.db==='master' ? 'var(--blue)' : 'var(--border2)';
    const roleBadge = node.db!=='none' ? `<span style="font-size:8px;border:1px solid ${dbBadgeBorder};color:${dbBadgeColor};padding:1px 5px;letter-spacing:.08em;text-transform:uppercase;margin-left:4px">${node.db}</span>` : '';
    return `<div class="node checking" id="node-${n}">
      <div class="node-top">
        <div style="flex:1;min-width:0">
          <div class="node-name">${escapeHtml(node.label||n)}${roleBadge}<span class="patroni-role" style="font-size:8px;border:1px solid var(--border2);color:var(--text3);padding:1px 5px;letter-spacing:.08em;text-transform:uppercase;margin-left:4px;display:none"></span></div>
          <div class="node-role">${escapeHtml(node.role||'')}</div>
          <div class="node-ip">${escapeHtml(node.ip)}:${node.appPort}</div>
        </div>
        <div class="node-ind">
          <div class="dot dot-chk" id="ndot-${n}"></div>
          <div class="node-st muted" id="nst-${n}">—</div>
        </div>
      </div>
      <div class="nm-grid">
        <div class="nm"><div class="nm-label">HTTP</div><div class="nm-val muted" id="nh-${n}">—</div></div>
        <div class="nm"><div class="nm-label">Latency</div><div class="nm-val muted" id="nl-${n}">—</div></div>
        <div class="nm"><div class="nm-label">Uptime</div><div class="nm-val muted" id="nu-${n}">—</div></div>
        <div class="nm"><div class="nm-label">Polls</div><div class="nm-val muted" id="nd-${n}">—</div></div>
      </div>
      <div class="node-foot">
        <div class="node-acts">
          <button class="btn btn-ghost btn-sm" onclick="quickProbe('${n}','/health')">PROBE</button>
          <button class="btn btn-ghost btn-sm" onclick="openNodeHealth('${n}')">OPEN ↗</button>
          <button class="btn btn-danger btn-sm" onclick="chaosKill('${n}')">KILL</button>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
          <div class="upbar"><div class="upbar-fill" id="nbar-${n}" style="width:0%"></div></div>
          <div style="font-size:8px;color:var(--text3);font-family:var(--mono)" id="nts-${n}"></div>
        </div>
      </div>
    </div>`;
  }).join('');
  nodeNames().forEach(n=>{
    if(!S.nodes[n]) S.nodes[n]={status:'unknown',lat:null,up:0,total:0,hist:[]};
    if(!S.hist[n]) S.hist[n]=[];
  });
}


function setNode(name,status,lat){
  // Guard: node must be in config and state
  if(!S.nodeConfig[name]) return;
  if(!S.nodes[name]) S.nodes[name]={status:'unknown',lat:null,up:0,total:0,hist:[]};
  const prev=S.nodes[name].status;
  S.nodes[name].status=status; S.nodes[name].lat=lat;
  S.nodes[name].total++;
  if(status==='online') S.nodes[name].up++;

  const card=document.getElementById('node-'+name);
  if(!card) return; // cards not rendered yet — state updated, UI will catch up
  card.className='node '+status;
  const dot=document.getElementById('ndot-'+name);
  const st=document.getElementById('nst-'+name);

  if(status==='online'){
    dot.className='dot dot-on';
    st.textContent='online'; st.className='node-st good';
    document.getElementById('nh-'+name).textContent='200 OK';
    document.getElementById('nh-'+name).className='nm-val good';
    const le=document.getElementById('nl-'+name);
    le.textContent=lat+'ms';
    le.className='nm-val '+(lat<CFG.LAT_GOOD_MS?'good':lat<CFG.LAT_WARN_MS?'warn':'bad');
    if(prev!=='online'&&prev!=='checking'){
      log(name+' came back online ↑','success');
      // Recovery detected — close out chaos event if one exists
      if(S.chaosEvents[name] && S.chaosEvents[name].confirmed && !S.chaosEvents[name].recoveredAt){
        S.chaosEvents[name].recoveredAt = Date.now();
        updateRecoveryList();
      }
    }
  } else if(status==='offline'){
    dot.className='dot dot-off';
    st.textContent='offline'; st.className='node-st bad';
    document.getElementById('nh-'+name).textContent='offline';
    document.getElementById('nh-'+name).className='nm-val bad';
    document.getElementById('nl-'+name).textContent='timeout';
    document.getElementById('nl-'+name).className='nm-val bad';
    if(prev==='online'){
      log(name+' went offline ↓','error');
      // Poll confirmed offline — start the recovery timer now
      if(S.chaosEvents[name] && !S.chaosEvents[name].confirmed){
        S.chaosEvents[name].killedAt = Date.now();
        S.chaosEvents[name].confirmed = true;
        updateRecoveryList();
      }
    }
  } else {
    dot.className='dot dot-chk';
    st.textContent='checking'; st.className='node-st muted';
  }

  const nd=S.nodes[name];
  const pct=nd.total>0?Math.round((nd.up/nd.total)*100):0;
  const ue=document.getElementById('nu-'+name);
  if(ue){ue.textContent=pct+'%'; ue.className='nm-val '+(pct>=CFG.UPTIME_GOOD_PCT?'good':pct>=CFG.UPTIME_WARN_PCT?'warn':'bad');}
  const ub=document.getElementById('nbar-'+name);
  ub.style.width=pct+'%';
  ub.style.background=pct>=CFG.UPTIME_GOOD_PCT?'var(--green)':pct>=CFG.UPTIME_WARN_PCT?'var(--amber)':'var(--red)';
}

function updateChart(){
  if(!chart) return;
  if(!document.getElementById('page-monitor')?.classList.contains('active')) return;
  const names=nodeNames();
  names.forEach((n,i)=>{
    if(!chart.data.datasets[i]) return;
    const h=S.hist[n]||[];
    chart.data.datasets[i].data=[...Array(HIST-h.length).fill(null),...h];
  });
  chart.update('none');
}

function updateSys(){
  const nodeVals=Object.values(S.nodes);
  const online=nodeVals.filter(n=>n.status==='online').length;
  const b=document.getElementById('sys-badge');
  const t=document.getElementById('sys-text');
  if(!S.base){ b.className='sys-badge badge-off'; t.textContent='OFFLINE'; return; }
  const isMobile = window.innerWidth <= 768;
  if(online===nodeNames().length){b.className='sys-badge badge-ok'; t.textContent=isMobile?'ALL GO':'ALL SYSTEMS GO';}
  else if(online>=1){b.className='sys-badge badge-deg'; t.textContent=isMobile?`${online}/${nodeNames().length}`:`DEGRADED ${online}/${nodeNames().length}`;}
  else{b.className='sys-badge badge-down'; t.textContent=isMobile?'DOWN':'CLUSTER DOWN';}
}

// Cache frequently-accessed DOM elements after first poll
let _DOM = null;
function getDOM(){
  if(_DOM) return _DOM;
  _DOM = {
    sOnline:   document.getElementById('s-online'),
    sLat:      document.getElementById('s-lat'),
    sReqs:     document.getElementById('s-reqs'),
    sRate:     document.getElementById('s-rate'),
    sysBadge:  document.getElementById('sys-badge'),
    sysText:   document.getElementById('sys-text'),
    logList:   document.getElementById('log-list'),
    latChart:  document.getElementById('latChart'),
  };
  return _DOM;
}

function updateSummary(){
  const dom=getDOM();
  const se=dom.sOnline;
  const nodeVals=Object.values(S.nodes);
  const online=nodeVals.filter(n=>n.status==='online').length;
  const total=nodeNames().length;
  // Replica count from nodeConfig
  const replicaNames=nodeList().filter(n=>n.db==='replica').map(n=>n.name);
  const onlineReplicas=replicaNames.filter(n=>S.nodes[n]?.status==='online').length;
  const replicaEl=document.getElementById('s-replicas');
  if(replicaEl){
    replicaEl.textContent=`${onlineReplicas}/${replicaNames.length}`;
    replicaEl.className='stat-value '+(onlineReplicas===replicaNames.length?'sv-green':onlineReplicas>0?'sv-amber':'sv-red');
  }
  const subEl=document.getElementById('s-online-sub');
  if(subEl) subEl.textContent=`of ${total} nodes`;
  se.textContent=online;
  se.className='stat-value '+(online===nodeNames().length?'sv-green':online>=1?'sv-amber':'sv-red');
  // Sidebar status strip
  const sideStatus=document.getElementById('side-status-text');
  if(sideStatus) sideStatus.textContent=`${online}/${total} NODES ONLINE`;
  const lats=nodeVals.filter(n=>n.lat!==null).map(n=>n.lat);
  const avg=lats.length?Math.round(lats.reduce((a,b)=>a+b,0)/lats.length):null;
  const minLat=lats.length?Math.min(...lats):null;
  const maxLat=lats.length?Math.max(...lats):null;
  const le=dom.sLat;
  le.textContent=avg!==null?avg+'ms':'—';
  le.className='stat-value '+(avg===null?'sv-muted':avg<CFG.LAT_GOOD_MS?'sv-green':avg<CFG.LAT_WARN_MS?'sv-amber':'sv-red');
  const latSubEl=document.getElementById('s-lat-sub');
  if(latSubEl && minLat!==null) latSubEl.textContent=`min ${minLat}ms · max ${maxLat}ms`;
  dom.sReqs.textContent=S.reqs;
  const rate=S.reqs>0?Math.round((S.ok/S.reqs)*100):null;
  // Session uptime % (successful polls / total polls)
  const totalPolls=nodeVals.reduce((a,n)=>a+n.total,0);
  const upPolls=nodeVals.reduce((a,n)=>a+n.up,0);
  const sessionUptime=totalPolls>0?((upPolls/totalPolls)*100).toFixed(1):null;
  // s-uptime removed — countdown handled by updatePollCountdown()
  const re=dom.sRate;
  re.textContent=rate!==null?rate+'%':'—';
  re.className='stat-value '+(rate===null?'sv-muted':rate>=CFG.RATE_GOOD_PCT?'sv-green':rate>=CFG.RATE_WARN_PCT?'sv-amber':'sv-red');
}
