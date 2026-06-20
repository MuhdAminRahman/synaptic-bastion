const express = require('express');
const cors = require('cors');

const { PORT, AUTH_TOKEN } = require('./config');
const { loadNodes } = require('./lib/nodes-store');
const outpostEngine = require('./lib/outpost-engine');

const app = express();

app.use(cors());
app.use(express.json());

// ── Auth ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (req.path.match(/^\/api\/node\/[^/]+\/live$/)) return next(); // public demo endpoint
  const token = req.headers['x-ha-token'] || req.query.token;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// ── Mount routes ─────────────────────────────────────────────────────────────
require('./routes/health')(app);
require('./routes/nodes')(app);
require('./routes/provisioning')(app);
require('./routes/chaos')(app);
require('./routes/outpost')(app);
require('./routes/patroni')(app);
require('./routes/loadtest')(app);
require('./routes/replication')(app);
require('./routes/logs')(app);
require('./routes/misc')(app);

// ── Start background services ────────────────────────────────────────────────
outpostEngine.initOutposts();

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`HA Proxy v3 running on port ${PORT}`);
  const nodes = loadNodes();
  console.log(`Loaded ${Object.keys(nodes).length} nodes: ${Object.keys(nodes).join(', ')}`);
});
