const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { OUTPOSTS_FILE } = require('../config');
const { runSSH } = require('./ssh');
const { loadNodes } = require('./nodes-store');

// ═══════════════════════════════════════════════════════════════════════════
// OUTPOST — External Remote Monitoring
//
// Failure detection implements the Double Check Method (Naim, M.H. et al.,
// 2025, "Double Check Method: An Enhancement of Heartbeat Failure Detection
// by Fog Devices Through Socket and Port Engagement", SSRN 5099955).
//
// Pipeline when a heartbeat (HTTP) check fails:
//   1. TIME CHECK   — wait a debounce window and retry the heartbeat. If it
//                      recovers within the threshold, the failure is treated
//                      as a transient network blip (false positive) and is
//                      filtered out — no alert is raised.
//   2. SOCKET CHECK — if it has not recovered, open a raw TCP socket
//                      connection directly to the host:port, independent of
//                      the HTTP/application layer. This distinguishes a true
//                      outage (socket also fails) from an application-layer
//                      hang (socket connects, HTTP still fails).
//
// Only after both checks confirm trouble is the outpost marked DOWN /
// DEGRADED. This mirrors the paper's approach of reducing false-positive
// failure detection compared to single-shot heartbeat monitoring.
// ═══════════════════════════════════════════════════════════════════════════

const OUTPOST_DEBOUNCE_MS = 4000;   // time-check grace window before retry

const OUTPOST_SOCKET_TIMEOUT_MS = 5000;

const OUTPOST_HTTP_TIMEOUT_MS = 6000;

const OUTPOST_HISTORY_MAX = 50;     // verification events kept per outpost


function loadOutposts() {
  try { return JSON.parse(fs.readFileSync(OUTPOSTS_FILE, 'utf8')); }
  catch(_) { return {}; }
}

function saveOutposts(data) {
  fs.writeFileSync(OUTPOSTS_FILE, JSON.stringify(data, null, 2));
}

// Live in-memory state — not persisted (resets on proxy restart)

const outpostState = {}; // id -> { status, lastCheck, lastLatency, history:[], upCount, totalCount, verifying }


function ensureOutpostState(id) {
  if (!outpostState[id]) {
    outpostState[id] = {
      status: 'unknown',      // unknown | healthy | transient | degraded | down
      lastCheck: null,
      lastLatency: null,
      history: [],            // verification event log (most recent first)
      upCount: 0,
      totalCount: 0,
      verifying: false,
    };
  }
  return outpostState[id];
}


function pushOutpostEvent(id, event) {
  const st = ensureOutpostState(id);
  st.history.unshift({ ts: new Date().toISOString(), ...event });
  if (st.history.length > OUTPOST_HISTORY_MAX) st.history.length = OUTPOST_HISTORY_MAX;
}

// Single HTTP heartbeat attempt — resolves { ok, status, latencyMs, error }

function httpHeartbeat(target) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let u;
    try { u = new URL(target.url); } catch(e) { return resolve({ ok:false, error:'invalid URL' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search||''),
      timeout: OUTPOST_HTTP_TIMEOUT_MS,
      headers: { 'User-Agent': 'Synaptic-Bastion-Outpost/1.0' },
    }, res => {
      const latencyMs = Date.now() - t0;
      res.resume(); // drain
      resolve({ ok: res.statusCode < 500, status: res.statusCode, latencyMs });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok:false, error:'timeout', latencyMs: Date.now()-t0 }); });
    req.on('error', e => resolve({ ok:false, error: e.message, latencyMs: Date.now()-t0 }));
  });
}

// Raw TCP socket engagement check — independent of HTTP layer

function socketCheck(host, port) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const socket = new net.Socket();
    let done = false;
    socket.setTimeout(OUTPOST_SOCKET_TIMEOUT_MS);
    socket.once('connect', () => {
      done = true;
      const latencyMs = Date.now() - t0;
      socket.destroy();
      resolve({ ok:true, latencyMs });
    });
    socket.once('timeout', () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok:false, error:'socket timeout', latencyMs: Date.now()-t0 });
    });
    socket.once('error', e => {
      if (done) return;
      done = true;
      resolve({ ok:false, error:e.message, latencyMs: Date.now()-t0 });
    });
    socket.connect(port, host);
  });
}

// ── Distributed quorum extension ─────────────────────────────────────────────
// Enhancement over Naim et al. (2025): the original method performs the
// socket check from a single fog device. Since this deployment already runs
// a multi-node HA cluster, we extend the socket check to run independently
// from EVERY cluster node ("fog devices" at the edge) and require quorum
// agreement before confirming a failure. This protects against a false DOWN
// caused by a single node's own localised network path, not the target.


function isSafeHostname(h) {
  return typeof h === 'string' && /^[a-zA-Z0-9.-]+$/.test(h) && h.length < 256;
}


async function socketCheckFromNode(node, host, port) {
  if (!isSafeHostname(host)) return { node: node.name, ok: false, error: 'unsafe hostname' };
  if (node.local) {
    const r = await socketCheck(host, port);
    return { node: node.name, ...r };
  }
  try {
    const cmd = `timeout 5 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null && echo OK || echo FAIL`;
    const out = await runSSH(node, cmd);
    return { node: node.name, ok: out.trim() === 'OK' };
  } catch(e) {
    return { node: node.name, ok: false, error: e.message };
  }
}

// Runs the socket check from every configured node in parallel and returns
// a quorum verdict: 'reachable' (all ok), 'unreachable' (none ok), or
// 'partial' (split result — ambiguous, needs another round).

async function quorumSocketCheck(host, port) {
  const nodes = Object.values(loadNodes());
  const results = await Promise.all(
    nodes.map(n => socketCheckFromNode(n, host, port).catch(e => ({ node: n.name, ok: false, error: e.message })))
  );
  const okCount = results.filter(r => r.ok).length;
  const total = results.length;
  const verdict = total === 0 ? 'unreachable'
    : okCount === total ? 'reachable'
    : okCount === 0 ? 'unreachable'
    : 'partial';
  return { results, okCount, total, verdict };
}

// Full Double Check verification pipeline — runs when a heartbeat fails

async function runDoubleCheck(id, target, initialFailure) {
  const st = ensureOutpostState(id);
  st.verifying = true;
  const failureTime = Date.now();
  pushOutpostEvent(id, {
    stage: 'heartbeat_failed',
    detail: `Heartbeat failed: ${initialFailure.error || 'status ' + initialFailure.status}`,
  });

  // ── CHECK 1: TIME CHECK — debounce + retry ────────────────────────────
  await new Promise(r => setTimeout(r, OUTPOST_DEBOUNCE_MS));
  const retry = await httpHeartbeat(target);
  const recoveryTime = Date.now();
  const elapsedMs = recoveryTime - failureTime;

  if (retry.ok) {
    pushOutpostEvent(id, {
      stage: 'time_check',
      verdict: 'transient',
      detail: `Recovered within ${elapsedMs}ms (debounce ${OUTPOST_DEBOUNCE_MS}ms) — false positive filtered`,
    });
    st.status = 'transient';
    st.verifying = false;
    return { status: 'transient', latencyMs: retry.latencyMs };
  }

  pushOutpostEvent(id, {
    stage: 'time_check',
    verdict: 'still_failing',
    detail: `Did not recover after ${elapsedMs}ms — escalating to socket check`,
  });

  // ── CHECK 2: SOCKET CHECK — distributed quorum across cluster nodes ───
  let host, port;
  try {
    const u = new URL(target.url);
    host = u.hostname;
    port = target.port ? parseInt(target.port) : (u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch(_) { host = target.url; port = target.port || 80; }

  let quorum = await quorumSocketCheck(host, port);
  const summarise = q => q.results.map(r => `${r.node}:${r.ok?'OK':'FAIL'}`).join(' · ');

  if (quorum.verdict === 'partial') {
    // Ambiguous — single round of disagreement isn't enough to decide.
    // Extend the debounce and re-run once more before finalising.
    pushOutpostEvent(id, {
      stage: 'socket_check',
      verdict: 'ambiguous',
      detail: `Quorum split ${quorum.okCount}/${quorum.total} (${summarise(quorum)}) — re-checking once before deciding`,
    });
    await new Promise(r => setTimeout(r, OUTPOST_DEBOUNCE_MS * 2));
    quorum = await quorumSocketCheck(host, port);
  }

  if (quorum.verdict === 'reachable') {
    pushOutpostEvent(id, {
      stage: 'socket_check',
      verdict: 'degraded',
      detail: `Quorum ${quorum.okCount}/${quorum.total} reachable (${summarise(quorum)}) — network OK everywhere, application layer not responding`,
    });
    st.status = 'degraded';
  } else if (quorum.verdict === 'unreachable') {
    pushOutpostEvent(id, {
      stage: 'socket_check',
      verdict: 'down',
      detail: `Quorum ${quorum.okCount}/${quorum.total} reachable (${summarise(quorum)}) — confirmed outage from all vantage points`,
    });
    st.status = 'down';
  } else {
    // Still split after the second round — go with majority, flagged low-confidence
    const majorityOk = quorum.okCount > quorum.total / 2;
    pushOutpostEvent(id, {
      stage: 'socket_check',
      verdict: majorityOk ? 'degraded_low_confidence' : 'down_low_confidence',
      detail: `Still split ${quorum.okCount}/${quorum.total} after re-check (${summarise(quorum)}) — majority vote applied, low confidence`,
    });
    st.status = majorityOk ? 'degraded' : 'down';
  }

  st.verifying = false;
  return { status: st.status, latencyMs: null };
}

// Single monitoring cycle for one outpost

async function checkOutpost(id, target) {
  const st = ensureOutpostState(id);
  const result = await httpHeartbeat(target);
  st.lastCheck = new Date().toISOString();
  st.totalCount++;

  if (result.ok) {
    st.upCount++;
    st.status = 'healthy';
    st.lastLatency = result.latencyMs;
    pushOutpostEvent(id, { stage: 'heartbeat_ok', detail: `${result.status} · ${result.latencyMs}ms` });
    return;
  }

  // Heartbeat failed — run the Double Check pipeline before declaring trouble
  const verdict = await runDoubleCheck(id, target, result);
  st.lastLatency = verdict.latencyMs;
  if (verdict.status === 'transient') st.upCount++; // don't penalise filtered false positives
}

// Background scheduler — polls every outpost on its own interval

const outpostTimers = {};

function scheduleOutpost(id, target) {
  if (outpostTimers[id]) clearInterval(outpostTimers[id]);
  const intervalMs = Math.max(5000, (target.intervalSec || 15) * 1000);
  outpostTimers[id] = setInterval(() => {
    checkOutpost(id, target).catch(e => console.error(`[outpost ${id}]`, e.message));
  }, intervalMs);
  // Run an immediate first check
  checkOutpost(id, target).catch(e => console.error(`[outpost ${id}]`, e.message));
}

function unscheduleOutpost(id) {
  if (outpostTimers[id]) { clearInterval(outpostTimers[id]); delete outpostTimers[id]; }
  delete outpostState[id];
}

// Boot all saved outposts on proxy startup

function initOutposts() {
  const outposts = loadOutposts();
  Object.entries(outposts).forEach(([id, target]) => scheduleOutpost(id, target));
}

// ── Outpost API routes ───────────────────────────────────────────────────────

module.exports = { loadOutposts, saveOutposts, outpostState, ensureOutpostState, checkOutpost, scheduleOutpost, unscheduleOutpost, initOutposts };
