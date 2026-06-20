const express = require('express');
const { execLocal } = require('../lib/ssh');

module.exports = function(app) {
  app.get('/api/logs', async (req, res) => {
    const n = Math.min(parseInt(req.query.n)||100, 500);
    try {
      const out = await execLocal(`tail -n ${n} /var/log/nginx/access.log 2>/dev/null`);
      const lines = out.split('\n').filter(Boolean).map(line => {
        const m = line.match(/^(\S+).*\[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d+) (\d+)/);
        if (m) return { ip:m[1],time:m[2],method:m[3],path:m[4],status:parseInt(m[5]),bytes:parseInt(m[6]) };
        return null;
      }).filter(l => l && ['/health','/data','/lb-status'].some(p => l.path.startsWith(p)));
      res.json({ ok:true, lines: lines.slice(0,30).reverse(), count: lines.length });
    } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
  });

};
