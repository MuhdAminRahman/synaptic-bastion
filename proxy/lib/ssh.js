const { NodeSSH } = require('node-ssh');
const { exec, execFile } = require('child_process');
const { KEY_PATH } = require('../config');

const sshPool = {};
const SSH_IDLE_TIMEOUT = 60000; // close idle connections after 60s


async function getSSH(node) {
  const key = `${node.sshHost}:${node.sshPort}:${node.sshUser}`;
  const entry = sshPool[key];

  if (entry && entry.ssh.isConnected()) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => closeSSH(key), SSH_IDLE_TIMEOUT);
    return entry.ssh;
  }

  // Create new connection
  const ssh = new NodeSSH();
  await ssh.connect({
    host: node.sshHost,
    port: node.sshPort || 22,
    username: node.sshUser,
    privateKeyPath: KEY_PATH,
    readyTimeout: 15000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
  });

  sshPool[key] = {
    ssh,
    idleTimer: setTimeout(() => closeSSH(key), SSH_IDLE_TIMEOUT),
  };
  console.log(`[SSH pool] Connected: ${key}`);
  return ssh;
}


function closeSSH(key) {
  const entry = sshPool[key];
  if (entry) {
    clearTimeout(entry.idleTimer);
    try { entry.ssh.dispose(); } catch(_) {}
    delete sshPool[key];
    console.log(`[SSH pool] Closed idle: ${key}`);
  }
}

// Close all pool connections on SIGTERM
process.on('SIGTERM', () => {
  Object.keys(sshPool).forEach(closeSSH);
  process.exit(0);
});


async function sshConnect(node, password = null) {
  const cfg = {
    host: node.sshHost,
    port: node.sshPort || 22,
    username: node.sshUser,
    readyTimeout: 10000,
  };
  const ssh = new NodeSSH();
  if (!password) {
    try {
      await ssh.connect({ ...cfg, privateKeyPath: KEY_PATH });
      return { ssh, method: 'key' };
    } catch(e) { throw new Error(`Key auth failed: ${e.message}`); }
  }
  await ssh.connect({ ...cfg, password });
  return { ssh, method: 'password' };
}

// ── Chaos lock (Item 3) ───────────────────────────────────────────────────────

function execLocal(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: opts.timeout || 30000, ...opts }, (err, stdout, stderr) => {
      if (err && opts.strict) return reject(new Error(stderr || err.message));
      resolve((stdout || '').trim());
    });
  });
}


async function runSSH(node, cmd, usePool = true) {
  if (node.local) return execLocal(cmd);
  if (usePool) {
    try {
      const ssh = await getSSH(node);
      const result = await ssh.execCommand(cmd);
      return result.stdout.trim();
    } catch(e) {
      // Pool connection may have died — remove and retry once
      const key = `${node.sshHost}:${node.sshPort}:${node.sshUser}`;
      closeSSH(key);
      const ssh = await getSSH(node);
      const result = await ssh.execCommand(cmd);
      return result.stdout.trim();
    }
  }
  const { ssh } = await sshConnect(node);
  const result = await ssh.execCommand(cmd);
  ssh.dispose();
  return result.stdout.trim();
}


module.exports = { getSSH, closeSSH, sshConnect, execLocal, runSSH };
