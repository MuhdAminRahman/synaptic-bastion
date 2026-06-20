const fs = require('fs');
const axios = require('axios');
const { NODES_FILE } = require('../config');

function loadNodes() {
  try {
    if (fs.existsSync(NODES_FILE)) return JSON.parse(fs.readFileSync(NODES_FILE, 'utf8'));
  } catch(e) { console.error('Failed to load nodes.json:', e.message); }
  return {};
}

function saveNodes(nodes) { fs.writeFileSync(NODES_FILE, JSON.stringify(nodes, null, 2)); }

// ── SSH connection pool ────────────────────────────────────────────────────────
// Item 1: Reuse SSH connections instead of opening a new one per request

async function probeNode(node) {
  const url = `http://${node.local ? '127.0.0.1' : node.ip}:${node.appPort}/health`;
  const t0 = Date.now();
  try {
    const res = await axios.get(url, { timeout: 4000 });
    return { name: node.name, status: 'online', latency: Date.now()-t0, httpStatus: res.status, body: res.data, ...node };
  } catch(e) {
    return { name: node.name, status: 'offline', latency: null, httpStatus: e.response?.status||null, error: e.message, ...node };
  }
}

// ── C++ app template ──────────────────────────────────────────────────────────

module.exports = { loadNodes, saveNodes, probeNode };
