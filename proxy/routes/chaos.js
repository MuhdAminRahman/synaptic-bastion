const express = require('express');
const axios = require('axios');
const { execLocal, runSSH } = require('../lib/ssh');
const { loadNodes } = require('../lib/nodes-store');
const { acquireChaoLock, releaseChaosLock } = require('../lib/chaos-lock');

module.exports = function(app) {
  app.post('/api/chaos/kill-db/:name', async (req, res) => {
    const nodes = loadNodes();
    const node = nodes[req.params.name];
    if (!node) return res.status(404).json({ error: 'Node not found' });
    try {
      const result = await runSSH(node, 'systemctl stop patroni 2>&1 && echo "patroni stopped"');
      res.json({ ok: true, node: req.params.name, output: result });
    } catch(e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });


  app.post('/api/chaos/restore-db/:name', async (req, res) => {
    const nodes = loadNodes();
    const node = nodes[req.params.name];
    if (!node) return res.status(404).json({ error: 'Node not found' });
    try {
      const result = await runSSH(node, 'systemctl start patroni 2>&1 && echo "patroni started"');
      res.json({ ok: true, node: req.params.name, output: result });
    } catch(e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Raw node health pass-through (for browser demo) ─────────────────────────

  app.post('/api/chaos/kill-verify/:name', async (req, res) => {
    const node = loadNodes()[req.params.name];
    if (!node) return res.status(404).json({ error: 'Node not found' });
    if (!acquireChaoLock(node.name)) return res.status(409).json({ error: `Kill already in progress for '${node.name}'` });
    try {
      const killCmd = node.os==='macos' ? `pkill -9 -f /opt/ha-app/app || true` : `sudo kill -9 $(pgrep -x app) || true`;
      const waitMs = node.local ? 12000 : node.os==='macos' ? 1500 : 2000;
      const pidCmd = node.os==='macos' ? 'pgrep -f /opt/ha-app/app | head -1' : 'pgrep -x app | head -1';
      if (node.local) {
        const pb = await execLocal('pgrep -x app | head -1');
        if (!pb) { releaseChaosLock(node.name); return res.json({ ok:false, error: 'app not found' }); }
        await execLocal(`kill -9 ${pb}`);
        await new Promise(r => setTimeout(r, waitMs));
        const pa = await execLocal('pgrep -x app | head -1');
        releaseChaosLock(node.name);
        return res.json({ ok:true, node: node.name, pidBefore:pb, pidAfter:pa||'(none)', recovered:!!pa&&pa!==pb, recoveryMs:waitMs });
      }
      const pb = await runSSH(node, pidCmd, false);
      await runSSH(node, killCmd, false);
      await new Promise(r => setTimeout(r, waitMs));
      const pa = await runSSH(node, pidCmd, false);
      releaseChaosLock(node.name);
      res.json({ ok:true, node: node.name, pidBefore:pb||'(none)', pidAfter:pa||'(none)', recovered:!!pa&&pa!==pb, recoveryMs:waitMs });
    } catch(e) { releaseChaosLock(node.name); res.status(500).json({ ok:false, node: node.name, error: e.message }); }
  });


  app.post('/api/chaos/kill/:name', async (req, res) => {
    const node = loadNodes()[req.params.name];
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const killCmd = node.os==='macos' ? `pkill -9 -f /opt/ha-app/app || true` : `sudo kill -9 $(pgrep -x app) || true`;
    try {
      const out = node.local ? await execLocal(killCmd.replace('sudo ','')) : await runSSH(node, killCmd, false);
      res.json({ ok:true, node: node.name, cmd: killCmd, stdout: out });
    } catch(e) { res.status(500).json({ ok:false, node: node.name, error: e.message }); }
  });


  app.post('/api/chaos/restore/:name', async (req, res) => {
    const node = loadNodes()[req.params.name];
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const cmd = node.os==='macos' ? `launchctl load ~/Library/LaunchAgents/com.ha-app.plist || true` : `sudo systemctl start ha-app`;
    try {
      const out = node.local ? await execLocal('sudo systemctl start ha-app') : await runSSH(node, cmd, false);
      res.json({ ok:true, node: node.name, cmd, stdout: out });
    } catch(e) { res.status(500).json({ ok:false, node: node.name, error: e.message }); }
  });

  // Serve app.cpp template for manual recompile
};
