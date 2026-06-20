const express = require('express');
const axios = require('axios');
const { runSSH } = require('../lib/ssh');
const { loadNodes } = require('../lib/nodes-store');

module.exports = function(app) {
  app.get('/api/replication', async (req, res) => {
    const nodes = loadNodes();
    // Find current Patroni leader dynamically — avoids stale master config after failover
    let master = null;
    for (const node of Object.values(nodes)) {
      const ip = node.tailscaleIp || node.sshHost || node.ip;
      try {
        const r = await fetch(`http://${ip}:8008/health`, { signal: AbortSignal.timeout(2000) });
        const d = await r.json();
        if (d.role === 'primary' || d.role === 'master') { master = node; break; }
      } catch(_) {}
    }
    // Fallback to static config
    if (!master) master = Object.values(nodes).find(n => n.db === 'master');
    if (!master) return res.status(404).json({ ok: false, error: 'No master node found' });
    try {
      const run = cmd => runSSH(master, cmd);
      const [stat, lag, slots] = await Promise.all([
        run(`sudo -u postgres psql -t -A -F'|' -c "SELECT client_addr,state,write_lag,flush_lag,replay_lag FROM pg_stat_replication;"`),
        run(`sudo -u postgres psql -t -A -c "SELECT COALESCE(ROUND(EXTRACT(EPOCH FROM replay_lag)*1000),0) FROM pg_stat_replication LIMIT 1;"`),
        run(`sudo -u postgres psql -t -A -F'|' -c "SELECT slot_name,active,restart_lsn FROM pg_replication_slots;"`),
      ]);
      const rows = stat.trim().split('\n').filter(Boolean).map(r => {
        const [client_addr,state,write_lag,flush_lag,replay_lag] = r.split('|');
        return { client_addr, state, write_lag, flush_lag, replay_lag };
      });
      const lagMs = parseFloat(lag.trim());
      const slotRows = slots.trim().split('\n').filter(Boolean).map(r => {
        const [slot_name, active, restart_lsn] = r.split('|');
        return { slot_name, active: active==='t', restart_lsn };
      });
      res.json({ ok:true, masterNode: master.name, replicating: rows.length>0, replicas: rows, lagMs: isNaN(lagMs)?null:Math.round(lagMs), slots: slotRows });
    } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
  });

};
