// ═══ CHART ═══
let chart;
function initChart(){
  const ctx=document.getElementById('latChart')?.getContext('2d');
  if(!ctx) return;
  if(chart) chart.destroy();
  const empty=Array(HIST).fill(null);
  const names=nodeNames();
  chart=new Chart(ctx,{
    type:'line',
    data:{
      labels:Array(HIST).fill(''),
      datasets:names.map((n,i)=>({
        label:S.nodeConfig[n]?.label||n,
        data:[...empty],
        borderColor:CFG.CHART_COLORS[i]||'#888',
        backgroundColor:(CFG.CHART_COLORS[i]||'#888')+'22',
        borderWidth:1.5,
        pointRadius:0,
        tension:0.4,
      }))
    },
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      scales:{
        x:{display:false},
        y:{min:0,grid:{color:'#ffffff08'},ticks:{color:CFG.CHART_TICK_COLOR,font:{size:10},callback:v=>v+'ms'}}
      },
      plugins:{legend:{labels:{color:CFG.CHART_TICK_COLOR,font:{size:11},boxWidth:12}}}
    }
  });
  // Init hist arrays for all nodes
  names.forEach(n=>{ if(!S.hist[n]) S.hist[n]=[]; });
}

// ═══ LOG ═══
function log(msg,type='info'){
  const list=document.getElementById('log-list');
  const el=document.createElement('div');
  el.className='log-entry '+type;
  // Use textContent for msg to prevent XSS from error messages
  const ts_span=document.createElement('span');
  ts_span.className='log-ts';
  ts_span.textContent=ts();
  const msg_span=document.createElement('span');
  msg_span.textContent=String(msg);
  el.appendChild(ts_span);
  el.appendChild(msg_span);
  list.prepend(el);
  while(list.children.length>CFG.LOG_MAX) list.removeChild(list.lastChild);
}
function clearLog(){ document.getElementById('log-list').innerHTML=''; }

// ═══ TOAST ═══
function toast(msg,type='info'){
  const c=document.getElementById('toasts');
  const t=document.createElement('div');
  t.className='toast '+type; t.textContent=msg;
  c.appendChild(t); setTimeout(()=>t.remove(),CFG.TOAST_MS);
}

// ═══ EVIDENCE PANEL ═══
let evCounter = 0;

function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function syntaxHighlight(obj) {
  const json = escapeHtml(JSON.stringify(obj, null, 2));
  return json.replace(/(&quot;(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\&])*&quot;(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, match => {
    if (match.startsWith('&quot;')) {
      if (/:$/.test(match)) return `<span style="color:var(--cyan)">${match}</span>`;
      return `<span style="color:var(--green)">${match}</span>`;
    }
    if (/true|false/.test(match)) return `<span style="color:var(--amber)">${match}</span>`;
    if (/null/.test(match)) return `<span style="color:var(--red)">${match}</span>`;
    return `<span style="color:var(--blue)">${match}</span>`;
  });
}

function addEvidence(label, data){
  const wrap=document.getElementById('evidence-list');
  if(!wrap) return; // evidence panel not in DOM
  const empty=wrap.querySelector('.empty-state');
  if(empty) empty.remove();

  const entry=document.createElement('div');
  entry.className='ev-entry';
  const idx = ++evCounter;
  const highlighted = syntaxHighlight(data);
  // Compute a summary line from the data for quick scanning
  let summary = '';
  if(data && typeof data === 'object'){
    if(data.status) summary = `status:${data.status}`;
    else if(data.ok !== undefined) summary = `ok:${data.ok}`;
    else if(data.nodes) summary = `nodes:${data.nodes.length}`;
    else if(Array.isArray(data)) summary = `${data.length} items`;
  }
  const lineCount = JSON.stringify(data,null,2).split('\n').length;
  const bodyHeight = Math.min(500, Math.max(140, lineCount * 20));
  entry.innerHTML=`
    <div class="ev-header" data-idx="${idx}" onclick="toggleEv(this)">
      <span class="ev-badge live">LIVE</span>
      <span class="ev-label">${escapeHtml(String(label))}</span>
      ${summary ? `<span style="font-family:var(--mono);font-size:10px;color:var(--text2);flex-shrink:0">${summary}</span>` : ''}
      <span class="ev-ts">${ts()}</span>
      <span class="ev-chevron" style="color:var(--text3);font-family:var(--mono);font-size:12px;margin-left:4px">▾</span>
    </div>
    <div class="ev-body open" data-idx="${idx}" >${highlighted}</div>`;
  // Set body height after render
  const evBody = entry.querySelector('.ev-body');
  if(evBody) evBody.style.minHeight = bodyHeight + 'px';
  wrap.prepend(entry);
  while(wrap.children.length>CFG.EVIDENCE_MAX) wrap.removeChild(wrap.lastChild);
}
function toggleEv(header){
  const idx = header.dataset.idx;
  const body = header.parentElement.querySelector(`.ev-body[data-idx="${idx}"]`);
  if(!body) return;
  body.classList.toggle('open');
  const chevron = header.querySelector('.ev-chevron');
  if(chevron) chevron.textContent = body.classList.contains('open') ? '▾' : '▸';
}
function expandAllEvidence(){
  document.querySelectorAll('.ev-body').forEach(b=>{
    b.classList.add('open');
    const chevron=b.previousElementSibling?.querySelector('.ev-chevron');
    if(chevron) chevron.textContent='▾';
  });
}
function collapseAllEvidence(){
  document.querySelectorAll('.ev-body').forEach(b=>{
    b.classList.remove('open');
    const chevron=b.previousElementSibling?.querySelector('.ev-chevron');
    if(chevron) chevron.textContent='▸';
  });
}
function clearEvidence(){
  document.getElementById('evidence-list').innerHTML='<div class="empty-state">No evidence yet — run tests or probe nodes to see live API responses here.</div>';
}
