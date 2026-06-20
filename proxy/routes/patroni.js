const express = require('express');
const { execLocal } = require('../lib/ssh');
const { loadNodes } = require('../lib/nodes-store');

module.exports = function(app) {
  app.get('/api/patroni', async (req, res) => {
    const nodes = loadNodes();
    const results = await Promise.allSettled(
      Object.values(nodes).map(async node => {
        // For local node (127.0.0.1), use Patroni's actual listen IP from config
        // Patroni listens on Tailscale IP, not localhost
        let ip = node.tailscaleIp || node.sshHost || node.ip;
        if (ip === '127.0.0.1' || ip === 'localhost') ip = '100.78.158.68'; // Hetzner 1 Tailscale IP
        try {
          const r = await fetch(`http://${ip}:8008/health`, { signal: AbortSignal.timeout(3000) });
          const data = await r.json();
          return { name: node.name, label: node.label || node.name, ip, ...data, http_status: r.status };
        } catch(e) {
          return { name: node.name, label: node.label || node.name, ip, state: 'unreachable', error: e.message };
        }
      })
    );

    const members = results.map(r => r.status === 'fulfilled' ? r.value : { state: 'unreachable' });
    const leader = members.find(m => m.role === 'primary' || m.role === 'master');
    const replicas = members.filter(m => m.role === 'replica');

    res.json({
      ok: true,
      leader: leader ? { name: leader.name, label: leader.label, timeline: leader.timeline } : null,
      members,
      replicaCount: replicas.length,
      totalCount: members.length,
    });
  });


  app.post('/api/patroni/failover', async (req, res) => {
    try {
      const result = await execLocal(
        `patronictl -c /etc/patroni/config.yml failover synaptic-bastion --force 2>&1`
      );
      res.json({ ok: true, output: result });
    } catch(e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Item 5: Load test in worker thread to avoid blocking event loop
};
