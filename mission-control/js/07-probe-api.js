// ═══ PROBE ═══
async function quickProbe(name,path){
  if(!S.base){ toast('Not connected','warning'); return; }
  try{
    const r=await fetch(`${S.base}/api/node/${name}?path=${encodeURIComponent(path)}`,{signal:AbortSignal.timeout(CFG.POLL_TIMEOUT_MS),headers:{'x-ha-token':CFG.AUTH_TOKEN}});
    const d=await r.json();
    log(`${name} ${path} → ${d.httpStatus} (${d.latency}ms)`,d.status==='online'?'success':'error');
    const po=document.getElementById('probe-out'); if(po) po.textContent=JSON.stringify(d,null,2);
    addEvidence(`probe: ${name} ${path}`, d);
  }catch(e){ log(`${name} ${path} → error: ${e.message}`,'error'); }
}
async function manualProbe(){
  const name=document.getElementById('probe-node').value;
  const path=document.getElementById('probe-path').value||'/health';
  try{ await quickProbe(name,path); }
  catch(e){ log('Probe error: '+e.message,'error'); toast('Probe failed: '+e.message,'error'); }
}

// ═══ API HELPER ═══
async function api(path, opts={}){
  if(!S.base) throw new Error('not connected');
  const r=await fetch(S.base+path,{
    signal:AbortSignal.timeout(CFG.POLL_TIMEOUT_MS),
    headers:{'x-ha-token':CFG.AUTH_TOKEN},
    ...opts
  });
  return r.json();
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
