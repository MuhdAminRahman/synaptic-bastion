const chaosLocks = {};

function acquireChaoLock(name) {
  if (chaosLocks[name]) return false;
  chaosLocks[name] = true;
  return true;
}

function releaseChaosLock(name) { delete chaosLocks[name]; }

// ── Helpers ───────────────────────────────────────────────────────────────────
// Item 4: execLocal with proper error handling

module.exports = { acquireChaoLock, releaseChaosLock };
