// ═══ CHAOS ══════════════════════════════════════════════════════════════════

async function chaosKillDb(name){
  if(!S.base){ toast('Not connected','warning'); return; }
  const isLeader = S.patroni?.leader?.name === name;
  const msg = isLeader
    ? `Kill Patroni on '${name}' (CURRENT LEADER)?\n\nThis will trigger automatic leader election. A new primary will be elected in ~15s.`
    : `Kill Patroni on '${name}'?\n\nThis node is a replica. It will be removed from the cluster until Patroni restarts.`;
  if(!confirm(msg)) return;
  try{
    log(`DB Chaos: stopping Patroni on ${name}${isLeader?' (leader)':''}...`, 'warning');
    const r = await fetch(`${S.base}/api/chaos/kill-db/${name}`,{
      method:'POST',
      headers:{'x-ha-token':CFG.AUTH_TOKEN},
      signal:AbortSignal.timeout(10000),
    });
    const d = await r.json();
    if(!r.ok) throw new Error(d.error||'Failed');
    toast(`Patroni stopped on ${name} — watching for election`, 'warning');
    log(`DB Chaos: Patroni stopped on ${name} · election in ~15s`, 'warning');
    // Poll Patroni to show leader change
    setTimeout(()=>{ checkPatroni().catch(()=>{}); renderReplChaosButtons(); }, 5000);
    setTimeout(()=>{ checkPatroni().catch(()=>{}); renderReplChaosButtons(); }, 15000);
    setTimeout(()=>{ checkPatroni().catch(()=>{}); renderReplChaosButtons(); }, 25000);
  }catch(e){ toast(`DB kill failed: ${e.message}`, 'error'); }
}

async function chaosRestoreDb(name){
  if(!S.base){ toast('Not connected','warning'); return; }
  try{
    log(`DB Chaos: starting Patroni on ${name}...`, 'warning');
    const r = await fetch(`${S.base}/api/chaos/restore-db/${name}`,{
      method:'POST',
      headers:{'x-ha-token':CFG.AUTH_TOKEN},
      signal:AbortSignal.timeout(15000),
    });
    const d = await r.json();
    if(!r.ok) throw new Error(d.error||'Failed');
    toast(`Patroni restarted on ${name}`, 'success');
    log(`DB Chaos: Patroni restarted on ${name} · rejoining cluster`, 'success');
    setTimeout(()=>{ checkPatroni().catch(()=>{}); renderReplChaosButtons(); }, 5000);
    setTimeout(()=>{ checkPatroni().catch(()=>{}); renderReplChaosButtons(); checkRepl(); }, 15000);
  }catch(e){ toast(`DB restore failed: ${e.message}`, 'error'); }
}

async function chaosRestoreAllDb(){
  if(!S.base){ toast('Not connected','warning'); return; }
  try{
    const names = nodeNames();
    log(`DB Chaos: restoring Patroni on all nodes...`, 'warning');
    for(const name of names){
      await fetch(`${S.base}/api/chaos/restore-db/${name}`,{
        method:'POST',
        headers:{'x-ha-token':CFG.AUTH_TOKEN},
        signal:AbortSignal.timeout(15000),
      }).catch(()=>{});
    }
    toast('Restore sent to all DB nodes','success');
    log('DB Chaos: restore sent to all nodes','success');
    setTimeout(()=>{ checkPatroni().catch(()=>{}); renderReplChaosButtons(); checkRepl(); }, 8000);
  }catch(e){ toast(e.message,'error'); }
}

async function chaosKill(name){
  if(!S.base){ toast('Not connected','warning'); return; }
  if(!confirm(`Kill node '${name}'?\n\nThe app will be SIGKILLed. systemd will auto-restart it.`)) return;
  try{
    log(`Chaos: killing ${name}...`, 'warning');
    const r = await fetch(`${S.base}/api/chaos/kill/${name}`,{
      method:'POST',
      headers:{'x-ha-token':CFG.AUTH_TOKEN},
      signal:AbortSignal.timeout(CFG.CHAOS_TIMEOUT_MS),
    });
    const d = await r.json();
    if(!r.ok) throw new Error(d.error||'Kill failed');
    if(!S.chaosEvents) S.chaosEvents = {};
    S.chaosEvents[name] = { killedAt: Date.now(), recoveredAt: null };
    toast(`${name} killed — watching for recovery`, 'warning');
    log(`Chaos: ${name} killed · watching recovery`, 'warning');
    addEvidence(`chaos · kill · ${name}`, d);
    updateRecoveryList();
    pollNow();
    // Re-check Patroni after 5s and 15s to catch leader election
    setTimeout(()=>checkPatroni().catch(()=>{}), 5000);
    setTimeout(()=>checkPatroni().catch(()=>{}), 15000);
    setTimeout(()=>checkPatroni().catch(()=>{}), 30000);
  }catch(e){ toast(`Kill failed: ${e.message}`, 'error'); }
}

async function chaosRestoreAll(){
  if(!S.base){ toast('Not connected','warning'); return; }
  try{
    const names = nodeNames();
    for(const name of names){
      await fetch(`${S.base}/api/chaos/restore/${name}`,{
        method:'POST',
        headers:{'x-ha-token':CFG.AUTH_TOKEN},
        signal:AbortSignal.timeout(5000),
      }).catch(()=>{});
    }
    toast('Restore sent to all nodes','success');
    log('Chaos: force restore sent to all nodes','success');
    pollNow();
  }catch(e){ toast(e.message,'error'); }
}

// ═══ PATRONI ════════════════════════════════════════════════════════════════

async function checkPatroni(){
  if(!S.base){ toast('Not connected','warning'); return; }
  try{
    const d = await api('/api/patroni');
    S.patroni = d;
    renderPatroniPanel(d);
    renderNodeGridPatroni(d);
    // Update monitor page stat
    const leaderEl = document.getElementById('s-patroni-leader');
    const tlEl = document.getElementById('s-patroni-tl');
    if(leaderEl){ leaderEl.textContent = d.leader?.name || 'NONE'; leaderEl.className = d.leader ? 'stat-value sv-amber' : 'stat-value sv-red'; }
    if(tlEl) tlEl.textContent = `timeline ${d.leader?.timeline||'—'}`;
    const el = document.getElementById('patroni-updated');
    if(el) el.textContent = new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }catch(e){
    toast('Patroni check failed: '+e.message,'error');
  }
}

function renderPatroniPanel(d){
  const wrap = document.getElementById('patroni-panel-body');
  if(!wrap) return;
  if(!d?.members?.length){
    wrap.innerHTML='<div class="f-mono" style="font-size:11px;color:var(--text3)">No Patroni members found</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="roster-table" style="margin-bottom:8px">
      <thead>
        <tr>
          <th>NODE</th><th>ROLE</th><th>STATE</th><th>TIMELINE</th><th>LAG</th>
        </tr>
      </thead>
      <tbody>
        ${d.members.map(m=>{
          const isLeader = m.role==='primary' || m.role==='master';
          const roleColor = isLeader ? 'var(--blue)' : 'var(--text3)';
          const roleLabel = isLeader ? 'LEADER' : m.role==='replica' ? 'REPLICA' : '—';
          const stateColor = m.state==='running' ? 'var(--amber)' : m.state==='unreachable' ? 'var(--red)' : 'var(--text3)';
          const lag = m.xlog?.received_diff_bytes ?? m.xlog?.replayed_diff_bytes ?? null;
          return `<tr>
            <td>
              <div class="roster-node-name">${escapeHtml(m.name||'?')}</div>
              <div class="roster-label">${escapeHtml(m.label||m.ip||'')}</div>
            </td>
            <td><span style="font-size:9px;border:1px solid ${roleColor};color:${roleColor};padding:1px 6px;letter-spacing:.08em">${roleLabel}</span></td>
            <td style="font-family:var(--mono);color:${stateColor}">${escapeHtml(m.state||'unknown')}</td>
            <td style="font-family:var(--mono);color:var(--text2)">${m.timeline||'—'}</td>
            <td style="font-family:var(--mono)">${lag!==null?lag+'B':'<1ms'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <div style="font-size:10px;color:var(--text3);letter-spacing:.04em">
      Leader: <span style="color:var(--amber)">${escapeHtml(d.leader?.name||'NONE')}</span>
      · Timeline: <span style="color:var(--text2)">${d.leader?.timeline||'—'}</span>
      · Replicas: ${d.replicaCount}/${d.totalCount-1}
    </div>`;
}

function renderNodeGridPatroni(d){
  // Update node cards with Patroni role badges
  if(!d?.members) return;
  d.members.forEach(m=>{
    const card = document.getElementById('node-'+m.name);
    if(!card) return;
    const roleEl = card.querySelector('.patroni-role');
    const isLeader = m.role==='primary' || m.role==='master';
    const label = isLeader ? 'LEADER' : m.role==='replica' ? 'REPLICA' : m.state;
    const color = isLeader ? 'var(--blue)' : 'var(--text3)';
    if(roleEl){
      roleEl.textContent = label;
      roleEl.style.borderColor = color;
      roleEl.style.color = color;
    }
  });
}

async function triggerFailover(){
  if(!S.base){ toast('Not connected','warning'); return; }
  if(!confirm('Force Patroni failover?\n\nThis will promote a replica to primary. The current leader will become a replica.')) return;
  try{
    const r = await fetch(`${S.base}/api/patroni/failover`,{
      method:'POST',
      headers:{'x-ha-token':CFG.AUTH_TOKEN},
      signal:AbortSignal.timeout(30000),
    });
    const d = await r.json();
    if(d.ok){
      toast('Failover triggered','success');
      log('Patroni failover triggered: '+d.output,'warning');
      setTimeout(checkPatroni, 5000);
    } else {
      toast('Failover failed: '+d.error,'error');
    }
  }catch(e){ toast('Failover error: '+e.message,'error'); }
}
