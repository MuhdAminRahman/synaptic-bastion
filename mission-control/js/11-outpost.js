// ═══ OUTPOST ════════════════════════════════════════════════════════════════

let _outpostPollTimer = null;
let _outpostDetailId = null;

function toggleOutpostInfo(){
  const body = document.getElementById('outpost-info-body');
  const arrow = document.getElementById('outpost-info-toggle');
  if(!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if(arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
}

async function refreshOutposts(){
  if(!S.base){ toast('Not connected','warning'); return; }
  try{
    const d = await api('/api/outposts');
    S.outposts = d.outposts || [];
    renderOutpostGrid();
  }catch(e){ toast('Failed to load outposts: '+e.message,'error'); }
}

function renderOutpostGrid(){
  const grid = document.getElementById('outpost-grid');
  const countEl = document.getElementById('outpost-count');
  if(!grid) return;
  const outposts = S.outposts || [];
  if(countEl) countEl.textContent = `${outposts.length} MONITORED`;

  if(!outposts.length){
    grid.innerHTML = '<div style="padding:20px;font-family:var(--mono);font-size:11px;color:var(--text3)">No outposts yet — add one above.</div>';
    return;
  }

  grid.innerHTML = outposts.map(op=>{
    const badge = op.verifying
      ? `<span class="op-verifying">VERIFYING...</span>`
      : `<span class="op-badge ${op.status}">${op.status.toUpperCase()}</span>`;
    const lastCheck = op.lastCheck ? new Date(op.lastCheck).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
    return `<div class="op-card" onclick="openOutpostDetail('${op.id}')">
      <div class="op-card-top">
        <div>
          <div class="op-name">${escapeHtml(op.name)}</div>
          <div class="op-url">${escapeHtml(op.url)}</div>
        </div>
        ${badge}
      </div>
      <div class="op-metrics">
        <div>
          <div class="op-metric-label">Latency</div>
          <div class="op-metric-val">${op.lastLatency!==null&&op.lastLatency!==undefined?op.lastLatency+'ms':'—'}</div>
        </div>
        <div>
          <div class="op-metric-label">Uptime</div>
          <div class="op-metric-val">${op.uptimePct!==null?op.uptimePct+'%':'—'}</div>
        </div>
        <div>
          <div class="op-metric-label">Checks</div>
          <div class="op-metric-val">${op.totalChecks||0}</div>
        </div>
      </div>
      <div style="font-size:9px;color:var(--text3);font-family:var(--mono)">last check: ${lastCheck} · every ${op.intervalSec}s</div>
      <div class="op-actions" onclick="event.stopPropagation()">
        <button class="btn btn-ghost btn-sm" onclick="forceOutpostCheck('${op.id}')">CHECK NOW</button>
        <button class="btn btn-danger btn-sm" onclick="removeOutpost('${op.id}')">REMOVE</button>
      </div>
    </div>`;
  }).join('');
}

async function addOutpost(){
  if(!S.base){ toast('Not connected','warning'); return; }
  const name = document.getElementById('op-name').value.trim();
  const url = document.getElementById('op-url').value.trim();
  const port = document.getElementById('op-port').value.trim();
  const intervalSec = document.getElementById('op-interval').value.trim();
  if(!name || !url){ toast('Name and URL are required','warning'); return; }
  try{
    const r = await fetch(`${S.base}/api/outposts`,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-ha-token':CFG.AUTH_TOKEN},
      body:JSON.stringify({ name, url, port: port||null, intervalSec: intervalSec||15 }),
      signal:AbortSignal.timeout(8000),
    });
    const d = await r.json();
    if(!r.ok) throw new Error(d.error||'Failed to add outpost');
    toast(`Outpost '${name}' added`,'success');
    log(`Outpost '${name}' added — monitoring ${url}`,'success');
    document.getElementById('op-name').value='';
    document.getElementById('op-url').value='';
    document.getElementById('op-port').value='';
    document.getElementById('op-interval').value='15';
    setTimeout(refreshOutposts, 1500);
  }catch(e){ toast(e.message,'error'); }
}

async function removeOutpost(id){
  if(!S.base){ toast('Not connected','warning'); return; }
  if(!confirm('Remove this outpost? Monitoring will stop immediately.')) return;
  try{
    const r = await fetch(`${S.base}/api/outposts/${id}`,{
      method:'DELETE',
      headers:{'x-ha-token':CFG.AUTH_TOKEN},
      signal:AbortSignal.timeout(5000),
    });
    if(!r.ok) throw new Error((await r.json()).error||'Failed');
    toast('Outpost removed','success');
    if(_outpostDetailId===id) closeOutpostDetail();
    refreshOutposts();
  }catch(e){ toast(e.message,'error'); }
}

async function forceOutpostCheck(id){
  if(!S.base){ toast('Not connected','warning'); return; }
  try{
    toast('Running check...','warning');
    const r = await fetch(`${S.base}/api/outposts/${id}/check`,{
      method:'POST',
      headers:{'x-ha-token':CFG.AUTH_TOKEN},
      signal:AbortSignal.timeout(15000),
    });
    const d = await r.json();
    toast(`Check complete: ${d.status}`, d.status==='healthy'?'success':'warning');
    refreshOutposts();
    if(_outpostDetailId===id) openOutpostDetail(id);
  }catch(e){ toast(e.message,'error'); }
}

async function openOutpostDetail(id){
  if(!S.base){ toast('Not connected','warning'); return; }
  _outpostDetailId = id;
  const op = (S.outposts||[]).find(o=>o.id===id);
  const panel = document.getElementById('outpost-detail-panel');
  const nameEl = document.getElementById('outpost-detail-name');
  if(panel) panel.style.display='';
  if(nameEl) nameEl.textContent = op?.name || id;
  panel?.scrollIntoView({behavior:'smooth'});
  try{
    const r = await fetch(`${S.base}/api/outposts/${id}/history`,{
      headers:{'x-ha-token':CFG.AUTH_TOKEN},
      signal:AbortSignal.timeout(5000),
    });
    const d = await r.json();
    renderOutpostHistory(d.history||[]);
  }catch(e){ toast('Failed to load history: '+e.message,'error'); }
}

function renderOutpostHistory(history){
  const body = document.getElementById('outpost-detail-body');
  if(!body) return;
  if(!history.length){
    body.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text3)">No verification events yet.</div>';
    return;
  }
  body.innerHTML = history.map(ev=>{
    const ts = new Date(ev.ts).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const verdictBadge = ev.verdict ? `<span class="vlog-verdict ${ev.verdict}">${ev.verdict.replace(/_/g,' ')}</span>` : '';
    return `<div class="vlog-item">
      <span class="vlog-stage ${ev.stage}">${ev.stage.replace(/_/g,' ')}${verdictBadge}</span>
      <span class="vlog-detail">${escapeHtml(ev.detail||'')}</span>
      <span class="vlog-ts">${ts}</span>
    </div>`;
  }).join('');
}

function closeOutpostDetail(){
  _outpostDetailId = null;
  const panel = document.getElementById('outpost-detail-panel');
  if(panel) panel.style.display='none';
}
