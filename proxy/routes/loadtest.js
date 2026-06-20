const express = require('express');
const axios = require('axios');
const { Worker } = require('worker_threads');

module.exports = function(app) {
  app.get('/api/loadtest', (req, res) => {
    const n = parseInt(req.query.n)||100;
    const c = parseInt(req.query.c)||10;
    const reqPath = req.query.path || '/health';
    const workerCode = `
      const { parentPort, workerData } = require('worker_threads');
      const http = require('http');
      const { n, c, path } = workerData;
      let sent=0, ok=0, fail=0;
      const lats = [];
      function req() {
        return new Promise(resolve => {
          const t0 = Date.now();
          const r = http.get('http://127.0.0.1:80'+path, res => {
            res.resume();
            res.on('end', () => { ok++; lats.push(Date.now()-t0); resolve(); });
          });
          r.on('error', () => { fail++; resolve(); });
          r.setTimeout(5000, () => { fail++; r.destroy(); resolve(); });
        });
      }
      async function worker() { while(sent++ < n/c) await req(); }
      Promise.all(Array.from({length:c}, worker)).then(() => {
        lats.sort((a,b)=>a-b);
        const total=ok+fail;
        const avgLat=ok?Math.round(lats.reduce((a,b)=>a+b,0)/ok):0;
        parentPort.postMessage({
          total, ok, fail, concurrency:c, path,
          successRate: Math.round((ok/total)*100),
          avgLatency: avgLat,
          p50: lats[Math.floor(lats.length*.50)]||0,
          p95: lats[Math.floor(lats.length*.95)]||0,
          p99: lats[Math.floor(lats.length*.99)]||0,
          reqPerSec: avgLat>0?Math.round(1000/avgLat*c):0
        });
      });
    `;
    const { Worker } = require('worker_threads');
    const w = new Worker(workerCode, { eval: true, workerData: { n, c, path: reqPath } });
    w.once('message', result => res.json(result));
    w.once('error', e => res.status(500).json({ error: e.message }));
  });

};
