// ═══ EXPORT ═══
function exportResults(){
  const now = new Date();
  const tsStr = now.toISOString().replace(/[:.]/g,'-').slice(0,19);
  const results = {
    exported: now.toISOString(),
    cluster: { nodes: nodeNames(), proxyPort: CFG.PROXY_PORT },
    targets: CFG.TARGETS_SPEC,
    tests: Object.entries(S.testRes).map(([id,pass])=>({
      id,
      name: document.getElementById('tc-'+id)?.querySelector('.test-name')?.textContent||id,
      pass,
      result: document.getElementById('tr-'+id)?.textContent||'',
    })),
    targetTable: {
      reliability: ['uptime','rto','rpo','detect','recovery'].map(k=>({
        metric: k,
        result: document.getElementById('tr-'+k)?.textContent||'—',
        tested: document.getElementById('tt-'+k)?.textContent||'—',
      })),
      performance: ['p50','p95','rps','lag','lag-peak'].map(k=>({
        metric: k,
        result: document.getElementById('tr-'+k)?.textContent||'—',
        tested: document.getElementById('tt-'+k)?.textContent||'—',
      })),
    },
    nodeMetrics: S.metrics,
    sessionStats: {
      requests: S.reqs,
      successful: S.ok,
      successRate: S.reqs>0?Math.round((S.ok/S.reqs)*100):null,
    },
  };
  const blob = new Blob([JSON.stringify(results,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ha-mission-control-${tsStr}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  log('Test results exported to ha-mission-control-'+tsStr+'.json','success');
  toast('Results exported','success');
}

// ═══ NODE METRICS ═══

const METRICS_TTL = 30000; // 30 seconds before re-fetch

async function refreshAllMetrics(force=false){
  if(!S.base){ toast('Not connected','warning'); return; }
  const list = document.getElementById('node-detail-list');
  if(!list) return;

  // Show cached data immediately if available
  const hasCached = nodeNames().some(n=>S.metrics[n]);
  if(hasCached) renderNodeDetails();
  else {
    // No cache — show skeletons
    list.innerHTML = nodeNames().map(n=>`
      <div class="node-detail">
        <div class="nd-header">
          <div><div class="nd-title">${n}</div></div>
        </div>
        <div class="nd-loading">fetching metrics...</div>
      </div>`).join('');
  }

  // Only fetch nodes whose data is stale or forced
  const now = Date.now();
  const stale = nodeNames().filter(n => force || !S.metricsTs[n] || (now - S.metricsTs[n]) > METRICS_TTL);
  if(!stale.length){ return; } // all fresh

  // Fetch stale nodes in parallel
  const results = await Promise.all(stale.map(n=>
    fetch(`${S.base}/api/node/${n}/metrics`,{signal:AbortSignal.timeout(15000),headers:{'x-ha-token':CFG.AUTH_TOKEN}})
      .then(r=>r.json())
      .then(d=>{ S.metricsTs[n]=Date.now(); return d; })
      .catch(e=>({ok:false,node:n,error:e.message}))
  ));
  results.forEach(d=>{ if(d.node) S.metrics[d.node]=d; });
  renderNodeDetails();
}

function fmtUptime(s){
  if(!s||s<=0) return '—';
  const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60);
  return d>0?`${d}d ${h}h ${m}m`:`${h}h ${m}m`;
}
function normDisk(s){
  if(!s) return '—';
  // Normalize binary (Gi/Mi) and decimal (G/M) units to consistent labels
  return s
    .replace(/(\d+(?:\.\d+)?)Gi/g, (_,n)=>parseFloat(n).toFixed(0)+'GB')  // 228Gi→228GB
    .replace(/(\d+(?:\.\d+)?)Mi/g, (_,n)=>parseFloat(n).toFixed(0)+'MB')  // 512Mi→512MB
    .replace(/(\d+(?:\.\d+)?)G/g,  (_,n)=>parseFloat(n).toFixed(0)+'GB')  // 38G→38GB
    .replace(/(\d+(?:\.\d+)?)M/g,  (_,n)=>parseFloat(n).toFixed(0)+'MB'); // 512M→512MB
}
function fmtMem(mb){ return mb>=1024?(mb/1024).toFixed(1)+'GB':mb+'MB'; }
function barClass(pct){ return pct<60?'good':pct<85?'warn':'bad'; }
function metricColor(pct){ return pct<60?'var(--green)':pct<85?'var(--amber)':'var(--red)'; }

let _lastMetricsHash = '';
function renderNodeDetails(){
  const list = document.getElementById('node-detail-list');
  if(!list) return;
  // Skip re-render if metrics data hasn't changed
  const hash = JSON.stringify(nodeNames().map(n=>S.metrics[n]?.app?.pid+'|'+S.nodes[n]?.status+'|'+S.nodes[n]?.lat));
  if(hash === _lastMetricsHash && list.children.length > 0 && !list.querySelector('.nd-loading')) return;
  _lastMetricsHash = hash;
  // Skip if loading skeleton is showing and metrics just arrived for first time
  if(!nodeNames().some(n=>S.metrics[n])){
    list.innerHTML='<div style="font-family:var(--mono);font-size:12px;color:var(--text3);text-align:center;padding:40px">Click refresh to load node details.</div>';
    return;
  }
  list.innerHTML = nodeNames().map(n=>{
    const d = S.metrics[n];
    const nodeStatus = S.nodes[n]?.status || 'unknown';
    if(!d||!d.ok) return `
      <div class="node-detail">
        <div class="nd-header">
          <div><div class="nd-title">${n}</div><div class="nd-subtitle">${S.nodeConfig[n]?.label||n}</div></div>
          <div class="nd-status-badge" style="background:var(--red-dim);border:1px solid var(--red);color:var(--red)">✗ metrics unavailable${d?.error?' — '+d.error:''}</div>
        </div>
      </div>`;

    const memPct = d.memory.total_mb>0?Math.round((d.memory.used_mb/d.memory.total_mb)*100):0;
    const diskPct = parseInt(d.disk?.pct)||0;
    const statusColor = nodeStatus==='online'?'var(--green)':nodeStatus==='offline'?'var(--red)':'var(--text3)';
    const statusBg = nodeStatus==='online'?'var(--green-dim)':nodeStatus==='offline'?'var(--red-dim)':'var(--bg4)';
    const statusBorder = nodeStatus==='online'?'var(--green2)':nodeStatus==='offline'?'var(--red)':'var(--border2)';

    return `
      <div class="node-detail" id="nd-${n}">
        <div class="nd-header">
          <div>
            <div class="nd-title">${d.hostname||n}</div>
            <div class="nd-subtitle">${d.os} · ${S.nodeConfig[n]?.role||''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <div class="nd-status-badge" style="background:${statusBg};border:1px solid ${statusBorder};color:${statusColor}">
              <span>◆</span> ${nodeStatus}
            </div>
            <span class="f-mono f-11 c-text3">uptime ${fmtUptime(d.uptime_s)}</span>
            <span class="f-mono f-10 c-text3" id="mts-${n}">${S.metricsTs[n]?'updated '+Math.round((Date.now()-S.metricsTs[n])/1000)+'s ago':''}</span>
            <button class="btn btn-ghost btn-sm" onclick="refreshSingleNode('${n}')">refresh</button>
          </div>
        </div>
        <div class="nd-body">

          <!-- CPU -->
          <div class="nd-section">
            <div class="nd-section-title">CPU</div>
            <div class="nd-row">
              <span class="nd-label">Usage</span>
              <span class="nd-value" style="color:${metricColor(d.cpu.usage_pct)}">${d.cpu.usage_pct}%</span>
            </div>
            <div class="nd-bar-wrap"><div class="nd-bar ${barClass(d.cpu.usage_pct)}" style="width:${Math.min(d.cpu.usage_pct,100)}%"></div></div>
            <div class="nd-row">
              <span class="nd-label">Load avg 1m</span>
              <span class="nd-value">${d.load.load1}</span>
            </div>
            <div class="nd-row">
              <span class="nd-label">Load avg 5m</span>
              <span class="nd-value">${d.load.load5}</span>
            </div>
            <div class="nd-row">
              <span class="nd-label">Load avg 15m</span>
              <span class="nd-value">${d.load.load15}</span>
            </div>
          </div>

          <!-- Memory -->
          <div class="nd-section">
            <div class="nd-section-title">Memory</div>
            <div class="nd-row">
              <span class="nd-label">Used</span>
              <span class="nd-value" style="color:${metricColor(memPct)}">${fmtMem(d.memory.used_mb)} / ${fmtMem(d.memory.total_mb)}</span>
            </div>
            <div class="nd-bar-wrap"><div class="nd-bar ${barClass(memPct)}" style="width:${memPct}%"></div></div>
            <div class="nd-row">
              <span class="nd-label">Used %</span>
              <span class="nd-value" style="color:${metricColor(memPct)}">${memPct}%</span>
            </div>
            <div class="nd-row">
              <span class="nd-label">Available</span>
              <span class="nd-value">${fmtMem(d.memory.free_mb||0)} <span style="font-size:10px;color:var(--text3)">(${100-memPct}% free)</span></span>
            </div>
          </div>

          <!-- Disk -->
          <div class="nd-section">
            <div class="nd-section-title">Disk</div>
            <div class="nd-row">
              <span class="nd-label">Used</span>
              <span class="nd-value" style="color:${metricColor(diskPct)}">${normDisk(d.disk.used)} / ${normDisk(d.disk.total)}</span>
            </div>
            <div class="nd-bar-wrap"><div class="nd-bar ${barClass(diskPct)}" style="width:${diskPct}%"></div></div>
            <div class="nd-row">
              <span class="nd-label">Used %</span>
              <span class="nd-value" style="color:${metricColor(diskPct)}">${d.disk.pct}</span>
            </div>
            <div class="nd-row">
              <span class="nd-label">Free</span>
              <span class="nd-value">${normDisk(d.disk.free)}</span>
            </div>
          </div>

          <!-- App process -->
          <div class="nd-app-section">
            <div class="nd-section-title">App process — /opt/ha-app/app</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
              <div class="nm">
                <div class="nm-label">Status</div>
                <div class="nm-val ${d.app.running?'good':'bad'}">${d.app.running?'running':'stopped'}</div>
              </div>
              <div class="nm">
                <div class="nm-label">PID</div>
                <div class="nm-val blue">${d.app.pid||'—'}</div>
              </div>
              <div class="nm">
                <div class="nm-label">CPU %</div>
                <div class="nm-val ${d.app.cpu_pct>50?'warn':'good'}">${d.app.cpu_pct}%</div>
              </div>
              <div class="nm">
                <div class="nm-label">Memory %</div>
                <div class="nm-val">${d.app.mem_pct}%</div>
              </div>
              <div class="nm">
                <div class="nm-label">RSS</div>
                <div class="nm-val">${(d.app.rss_kb/1024).toFixed(1)} MB</div>
              </div>
              <div class="nm">
                <div class="nm-label">Connections</div>
                <div class="nm-val cyan">${d.network.established_connections}</div>
              </div>
              <div class="nm">
                <div class="nm-label">DB role</div>
                <div class="nm-val ${S.nodeConfig[n]?.db==='master'?'good':'blue'}">${S.nodeConfig[n]?.db||'—'}</div>
              </div>
              <div class="nm">
                <div class="nm-label">Node latency</div>
                <div class="nm-val ${S.nodes[n]?.lat<100?'good':S.nodes[n]?.lat<500?'warn':'bad'}">${S.nodes[n]?.lat!==null?S.nodes[n]?.lat+'ms':'—'}</div>
              </div>
            </div>
          </div>

        </div>
      </div>`;
  }).join('');
}

// Node metadata is now in S.nodeConfig (loaded dynamically from proxy)

async function refreshSingleNode(name){
  if(!S.base) return;
  const card = document.getElementById('nd-'+name);
  if(card) card.style.opacity='0.6';
  try{
    const d = await fetch(`${S.base}/api/node/${name}/metrics`,{signal:AbortSignal.timeout(15000),headers:{'x-ha-token':CFG.AUTH_TOKEN}}).then(r=>r.json());
    S.metrics[name] = d;
    S.metricsTs[name] = Date.now();
    renderNodeDetails();
  }catch(e){ toast('Metrics fetch failed: '+e.message,'error'); }
  if(card) card.style.opacity='1';
}

function toggleEvidence(){
  const wrap=document.getElementById('ev-body-wrap');
  const arrow=document.getElementById('ev-toggle');
  if(!wrap) return;
  const open=wrap.style.display!=='none';
  wrap.style.display=open?'none':'';
  if(arrow) arrow.style.transform=open?'':'rotate(180deg)';
}

function toggleGuide(){
  const body = document.getElementById('guide-body');
  const arrow = document.getElementById('guide-toggle');
  if(!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if(arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
}

function toggleNginxLog(){
  const body = document.getElementById('nginx-log-body');
  const arrow = document.getElementById('nginx-log-toggle');
  if(!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if(arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
  if(!open) fetchNginxLog();
}

async function fetchNginxLog(){
  if(!S.base) return; // silently skip if not connected
  const wrap = document.getElementById('nginx-log-wrap');
  if(!wrap) return; // silently skip if not on Monitor page
  wrap.innerHTML='<div style="padding:14px;color:var(--text3)">Loading...</div>';
  try{
    const r = await fetch(`${S.base}/api/logs?n=30`,{
      signal:AbortSignal.timeout(6000),
      headers:{'x-ha-token':CFG.AUTH_TOKEN}
    });
    const d = await r.json();
    if(!d.ok || !d.lines.length){
      wrap.innerHTML='<div style="padding:14px;color:var(--text3)">No log entries found.</div>';
      return;
    }
    wrap.innerHTML = d.lines.map(l=>{
      if(!l.path) return `<div style="padding:4px 14px;border-bottom:1px solid var(--border);color:var(--text3);font-size:11px">${l.raw||''}</div>`;
      const statusColor = l.status < 300 ? 'var(--green)' : l.status < 400 ? 'var(--amber)' : 'var(--red)';
      const safePath=escapeHtml(l.path||'');
      const safeMethod=escapeHtml(l.method||'GET');
      const safeTime=escapeHtml(l.time?.split(':').slice(1).join(':').split(' ')[0]||'');
      return `<div style="display:grid;grid-template-columns:100px 50px 50px 1fr;gap:8px;padding:5px 14px;border-bottom:1px solid var(--border);font-size:11px;line-height:1.5">
        <span style="color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeTime}</span>
        <span style="color:${statusColor};font-weight:600">${l.status}</span>
        <span style="color:var(--text2)">${safeMethod}</span>
        <span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safePath} <span style="color:var(--text3)">(${l.bytes}b)</span></span>
      </div>`;
    }).join('');
  }catch(e){
    wrap.innerHTML=`<div style="padding:14px;color:var(--red)">Error: ${e.message}</div>`;
  }
}
