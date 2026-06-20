const express = require('express');
const axios = require('axios');
const { runSSH } = require('../lib/ssh');
const { loadNodes, probeNode, saveNodes } = require('../lib/nodes-store');
const { updateNginxUpstream } = require('../lib/nginx');

module.exports = function(app) {
  app.get('/api/config/nodes', (req, res) => res.json(loadNodes()));


  app.post('/api/config/nodes', async (req, res) => {
    const { name, label, ip, appPort, sshHost, sshPort, sshUser, role, db, os, serviceType, local } = req.body;
    if (!name || !ip) return res.status(400).json({ error: 'name and ip required' });
    const nodes = loadNodes();
    if (nodes[name]) return res.status(409).json({ error: `Node '${name}' already exists` });
    nodes[name] = { name, label: label||name, ip, appPort: parseInt(appPort)||8080, sshHost: sshHost||ip, sshPort: parseInt(sshPort)||22, sshUser: sshUser||'root', role: role||'app', db: db||'replica', os: os||'linux', serviceType: serviceType||'systemd', local: !!local, addedAt: new Date().toISOString() };
    saveNodes(nodes);
    try { await updateNginxUpstream(); } catch(e) { console.warn('Nginx update skipped:', e.message); }
    res.json({ ok: true, node: nodes[name] });
  });


  app.put('/api/config/nodes/:name', async (req, res) => {
    const nodes = loadNodes();
    if (!nodes[req.params.name]) return res.status(404).json({ error: 'Node not found' });
    nodes[req.params.name] = { ...nodes[req.params.name], ...req.body, name: req.params.name };
    saveNodes(nodes);
    try { await updateNginxUpstream(); } catch(e) {}
    res.json({ ok: true, node: nodes[req.params.name] });
  });


  app.delete('/api/config/nodes/:name', async (req, res) => {
    const nodes = loadNodes();
    if (!nodes[req.params.name]) return res.status(404).json({ error: 'Node not found' });
    delete nodes[req.params.name];
    saveNodes(nodes);
    try { await updateNginxUpstream(); } catch(e) {}
    res.json({ ok: true });
  });


  app.get('/api/nodes', async (req, res) => {
    const nodes = loadNodes();
    const results = await Promise.all(Object.values(nodes).map(n => probeNode(n)));
    res.json({ ts: Date.now(), nodes: results });
  });


  app.get('/api/node/:name', async (req, res) => {
    const node = loadNodes()[req.params.name];
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const reqPath = req.query.path || '/health';
    const url = `http://${node.local ? '127.0.0.1' : node.ip}:${node.appPort}${reqPath}`;
    const t0 = Date.now();
    try {
      const r = await axios.get(url, { timeout: 4000 });
      res.json({ name: node.name, status: 'online', latency: Date.now()-t0, httpStatus: r.status, body: r.data, ...node });
    } catch(e) {
      res.json({ name: node.name, status: 'offline', latency: null, error: e.message, ...node });
    }
  });


  app.get('/api/node/:name/data', async (req, res) => {
    const node = loadNodes()[req.params.name];
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const url = `http://${node.local ? '127.0.0.1' : node.ip}:${node.appPort}/data`;
    const t0 = Date.now();
    try {
      const r = await axios.get(url, { timeout: 4000 });
      res.json({ name: node.name, status: 'online', latency: Date.now()-t0, httpStatus: r.status, body: r.data, ...node });
    } catch(e) {
      res.json({ name: node.name, status: 'offline', latency: null, error: e.message, ...node });
    }
  });


  app.get('/api/lb', async (req, res) => {
    const count = parseInt(req.query.n)||8;
    const reqPath = req.query.path || '/health';
    const results = [];
    for (let i = 0; i < count; i++) {
      const t0 = Date.now();
      try {
        const r = await axios.get(`http://127.0.0.1:80${reqPath}`, { timeout: 4000 });
        results.push({ ok: true, latency: Date.now()-t0, body: r.data });
      } catch(e) { results.push({ ok: false, latency: Date.now()-t0, error: e.message }); }
    }
    const servers = [...new Set(results.filter(r => r.ok && r.body?.server).map(r => r.body.server))];
    const ok = results.filter(r => r.ok).length;
    const avgLat = ok ? Math.round(results.filter(r=>r.ok).reduce((a,b)=>a+b.latency,0)/ok) : 0;
    const lats = results.filter(r=>r.ok).map(r=>r.latency).sort((a,b)=>a-b);
    const p50 = lats[Math.floor(lats.length*0.50)]||0;
    const p95 = lats[Math.floor(lats.length*0.95)]||0;
    res.json({ total: count, ok, failed: count-ok, avgLatency: avgLat, p50, p95, backends: servers, results });
  });

  // ── DB chaos — kills Patroni on a node to trigger leader election ───────────

  app.get('/api/node/:name/live', async (req, res) => {
    const nodes = loadNodes();
    const node = nodes[req.params.name];
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const ip = node.ip === '127.0.0.1' ? '127.0.0.1' : node.ip;
    try {
      const r = await fetch(`http://${ip}:${node.appPort||8080}/health`, {
        signal: AbortSignal.timeout(4000)
      });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch(e) {
      res.status(503).json({ status: 'unreachable', error: e.message, node: req.params.name });
    }
  });


  app.get('/api/node/:name/metrics', async (req, res) => {
    const node = loadNodes()[req.params.name];
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const os = node.os || 'linux';
    const cmds = os !== 'macos' ? {
      cpu:    `top -bn2 -d0.5 | grep '%Cpu' | tail -1 | awk '{print 100-$8}'`,
      mem:    `free -m | awk '/Mem/{print $2" "$3" "$7}'`,
      disk:   `df -h / | awk 'NR==2{print $2" "$3" "$4" "$5}'`,
      load:   `cat /proc/loadavg | awk '{print $1" "$2" "$3}'`,
      uptime: `cat /proc/uptime | awk '{print int($1)}'`,
      osStr:  `uname -srm`,
      host:   `hostname`,
      pid:    `pgrep -x app | head -1`,
      conns:  `ss -tn | grep -c ESTAB || echo 0`,
    } : {
      cpu:    `top -l2 -n0 | grep 'CPU usage' | tail -1 | awk '{print $3}' | tr -d '%'`,
      mem:    `vm_stat | awk '/Pages active/{a=$3}/Pages wired/{w=$4}/Pages free/{f=$3}END{p=4096;printf "%d %d %d",int((a+w+f)*p/1048576),int((a+w)*p/1048576),int(f*p/1048576)}'`,
      disk:   `df -h / | awk 'NR==2{print $2" "$3" "$4" "$5}'`,
      load:   `sysctl -n vm.loadavg | awk '{print $2" "$3" "$4}'`,
      uptime: `sysctl kern.boottime | awk '{print $4}' | tr -d ','`,
      osStr:  `sw_vers -productName && sw_vers -productVersion && uname -m`,
      host:   `scutil --get ComputerName 2>/dev/null || hostname`,
      pid:    `pgrep -f /opt/ha-app/app | head -1`,
      conns:  `netstat -an | grep ESTABLISHED | wc -l | tr -d ' '`,
    };
    try {
      const run = cmd => runSSH(node, cmd);
      // Run sequentially for remote nodes to avoid SSH connection overload
      const cmdKeys = Object.keys(cmds);
      const cmdVals = Object.values(cmds);
      const results = [];
      for (const cmd of cmdVals) {
        try { results.push(await run(cmd)); }
        catch(e) { results.push(''); }
      }
      const [cpu,mem,disk,load,uptime,osStr,host,pid,conns] = results;
      const [mt,mu,mf] = mem.split(' ').map(Number);
      const [dt,du,df,dp] = disk.split(' ');
      const [l1,l5,l15] = load.split(' ').map(parseFloat);
      const pidNum = parseInt(pid)||null;
      let ac=0,am=0,ar=0;
      if (pidNum) {
        const ps = await run(`ps -p ${pidNum} -o %cpu -o %mem -o rss 2>/dev/null | tail -1 || echo "0 0 0"`);
        const pts = ps.trim().split(/\s+/);
        ac=parseFloat(pts[0])||0; am=parseFloat(pts[1])||0; ar=parseInt(pts[2])||0;
      }
      const uptimeNum = parseInt(uptime)||0;
      res.json({
        ok:true, node: node.name, hostname: host, os: osStr.replace(/\n/g,' '), role: node.role, db: node.db,
        uptime_s: os==='macos' && uptimeNum>1000000000 ? Math.floor(Date.now()/1000)-uptimeNum : uptimeNum,
        cpu:{ usage_pct: Math.round(parseFloat(cpu)*10)/10 },
        memory:{ total_mb: mt||0, used_mb: mu||0, free_mb: mf||0 },
        disk:{ total:dt, used:du, free:df, pct:dp },
        load:{ load1:l1||0, load5:l5||0, load15:l15||0 },
        app:{ pid: pidNum, cpu_pct: ac, mem_pct: am, rss_kb: ar, running: !!pidNum },
        network:{ established_connections: parseInt(conns)||0 },
      });
    } catch(e) { res.status(500).json({ ok:false, node: node.name, error: e.message }); }
  });

};
