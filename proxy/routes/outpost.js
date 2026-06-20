const express = require('express');
const crypto = require('crypto');
const { checkOutpost, ensureOutpostState, loadOutposts, outpostState, saveOutposts, scheduleOutpost, unscheduleOutpost } = require('../lib/outpost-engine');

module.exports = function(app) {
  app.get('/api/outposts', (req, res) => {
    const outposts = loadOutposts();
    const result = Object.entries(outposts).map(([id, target]) => {
      const st = ensureOutpostState(id);
      return {
        id, ...target,
        status: st.status,
        lastCheck: st.lastCheck,
        lastLatency: st.lastLatency,
        uptimePct: st.totalCount ? Math.round((st.upCount/st.totalCount)*1000)/10 : null,
        totalChecks: st.totalCount,
        verifying: st.verifying,
      };
    });
    res.json({ ok: true, outposts: result });
  });


  app.post('/api/outposts', (req, res) => {
    const { name, url, port, intervalSec } = req.body;
    if (!name || !url) return res.status(400).json({ ok:false, error:'name and url are required' });
    try { new URL(url); } catch(_) { return res.status(400).json({ ok:false, error:'invalid URL — include http:// or https://' }); }

    const outposts = loadOutposts();
    const id = 'op_' + crypto.randomBytes(6).toString('hex');
    const target = {
      name, url,
      port: port ? parseInt(port) : null,
      intervalSec: intervalSec ? parseInt(intervalSec) : 15,
      createdAt: new Date().toISOString(),
    };
    outposts[id] = target;
    saveOutposts(outposts);
    scheduleOutpost(id, target);
    res.json({ ok: true, id, outpost: target });
  });


  app.delete('/api/outposts/:id', (req, res) => {
    const outposts = loadOutposts();
    if (!outposts[req.params.id]) return res.status(404).json({ ok:false, error:'Outpost not found' });
    delete outposts[req.params.id];
    saveOutposts(outposts);
    unscheduleOutpost(req.params.id);
    res.json({ ok: true });
  });


  app.get('/api/outposts/:id/history', (req, res) => {
    const st = outpostState[req.params.id];
    if (!st) return res.status(404).json({ ok:false, error:'Outpost not found' });
    res.json({ ok: true, history: st.history });
  });


  app.post('/api/outposts/:id/check', async (req, res) => {
    const outposts = loadOutposts();
    const target = outposts[req.params.id];
    if (!target) return res.status(404).json({ ok:false, error:'Outpost not found' });
    await checkOutpost(req.params.id, target);
    const st = ensureOutpostState(req.params.id);
    res.json({ ok: true, status: st.status, lastLatency: st.lastLatency, history: st.history.slice(0,5) });
  });

  // ── Patroni cluster status ─────────────────────────────────────────────────
};
