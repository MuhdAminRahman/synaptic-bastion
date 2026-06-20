// ═══ CLOCK ═══
setInterval(()=>{
  const d=new Date();
  document.getElementById('clock').textContent=`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
},1000);

// Keyboard shortcuts — 1-5 for nav, R to refresh, E to export
document.addEventListener('keydown', e=>{
  // Skip if typing in an input
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA') return;
  const navMap = {'1':'monitor','2':'tests','3':'nodes','4':'loadtest','5':'replication','6':'cluster','7':'outpost'};
  if(navMap[e.key]){
    const pill = document.querySelector(`[aria-controls="page-${navMap[e.key]}"]`);
    if(pill){ showPage(navMap[e.key], pill); e.preventDefault(); }
  }
  if(e.key==='r'||e.key==='R'){
    if(!e.ctrlKey && !e.metaKey){
      pollNow();
      toast('Polling...','info');
      e.preventDefault();
    }
  }
  if(e.key==='e'||e.key==='E'){
    if(!e.ctrlKey && !e.metaKey && Object.keys(S.testRes).length>0){
      exportResults(); e.preventDefault();
    }
  }
});
function p(n){return String(n).padStart(2,'0')}
function ts(){const d=new Date();return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`}

// ═══ NAV ═══
// ═══ SETTINGS — THEME & TEXT SCALE ═══════════════════════════════════════════

const THEME_NAMES = ['bos','stealth-ops','unsc-tactical','desert-storm','naval-command','nato-digital'];
const SCALE_NAMES = ['sm','md','lg'];

function applyTheme(name){
  if(!THEME_NAMES.includes(name)) return;
  if(name === 'bos') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', name);
  localStorage.setItem('sb_theme', name);
  document.querySelectorAll('.theme-swatch').forEach(el=>{
    el.classList.toggle('active', el.dataset.theme === name);
  });
}

function applyScale(name){
  if(!SCALE_NAMES.includes(name)) return;
  document.documentElement.setAttribute('data-scale', name);
  localStorage.setItem('sb_scale', name);
  document.querySelectorAll('.scale-btn').forEach(el=>{
    el.classList.toggle('active', el.dataset.scale === name);
  });
}

function openSettings(){
  document.getElementById('settings-overlay')?.classList.add('open');
}
function closeSettings(){
  document.getElementById('settings-overlay')?.classList.remove('open');
}

// Restore saved preferences immediately (runs on every load, before connect)
(function initSettings(){
  const savedTheme = localStorage.getItem('sb_theme') || 'bos';
  const savedScale = localStorage.getItem('sb_scale') || 'md';
  if(savedTheme !== 'bos') document.documentElement.setAttribute('data-theme', savedTheme);
  document.documentElement.setAttribute('data-scale', savedScale);
  // Mark active swatches once DOM is ready
  document.addEventListener('DOMContentLoaded', ()=>{
    document.querySelectorAll('.theme-swatch').forEach(el=>{
      el.classList.toggle('active', el.dataset.theme === savedTheme);
    });
    document.querySelectorAll('.scale-btn').forEach(el=>{
      el.classList.toggle('active', el.dataset.scale === savedScale);
    });
  });
})();

function toggleSidebar(){
  document.getElementById('sidebar')?.classList.toggle('open');
}
function closeSidebar(){
  document.getElementById('sidebar')?.classList.remove('open');
}

function showPage(id,el){
  document.querySelectorAll('.page').forEach(pg=>pg.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  document.querySelectorAll('.side-item').forEach(pg=>{
    pg.classList.remove('active');
    pg.setAttribute('aria-selected','false');
  });
  if(el){
    el.classList.add('active');
    el.setAttribute('aria-selected','true');
  }
  closeSidebar(); // auto-close mobile drawer after navigating
  // Auto-check replication when navigating to that page
  if(id==='replication' && S.base){
    renderReplChaosButtons();
    if(S.patroni) renderNodeGridPatroni(S.patroni);
    checkPatroni().catch(()=>{});
    checkRepl();
    checkPatroni();
  }
  if(id==='cluster' && S.base) refreshClusterPage();
  if(id==='outpost' && S.base){
    refreshOutposts();
    if(_outpostPollTimer) clearInterval(_outpostPollTimer);
    _outpostPollTimer = setInterval(refreshOutposts, 8000);
  } else if(_outpostPollTimer){
    clearInterval(_outpostPollTimer);
    _outpostPollTimer = null;
  }
  if(id==='nodes' && S.base){
    refreshAllMetrics(false);
    // Start auto-refresh while on nodes page
    if(S.metricsTimer) clearInterval(S.metricsTimer);
    S.metricsTimer = setInterval(()=>refreshAllMetrics(false), 60000);
  } else {
    // Stop auto-refresh when leaving nodes page
    if(S.metricsTimer){ clearInterval(S.metricsTimer); S.metricsTimer=null; }
  }
}
