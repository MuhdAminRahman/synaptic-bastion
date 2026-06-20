const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JOBS_DIR, KEY_PUB_PATH } = require('../config');
const { sshConnect } = require('./ssh');
const { loadNodes, saveNodes } = require('./nodes-store');
const { getAppCpp, getDockerfile, getLaunchctlPlist, getSystemdService } = require('./templates');
const { updateNginxUpstream } = require('./nginx');

function saveJob(id, data) {
  fs.writeFileSync(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

function loadJob(id) {
  const f = path.join(JOBS_DIR, `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

function jobStep(id, step, status, detail = '') {
  const job = loadJob(id);
  if (!job) return;
  const existing = job.steps.find(s => s.step === step);
  if (existing) { existing.status = status; existing.detail = detail; existing.updatedAt = Date.now(); }
  else job.steps.push({ step, status, detail, startedAt: Date.now() });
  saveJob(id, job);
  console.log(`[JOB ${id}] ${step}: ${status} ${detail}`);
}


async function runProvision(jobId) {
  const job = loadJob(jobId);
  const { nodeData } = job;
  const { name, label, ip, sshHost, sshPort, sshUser, sshPassword,
          appPort, role, db, serviceType } = nodeData;
  let ssh = null;
  let tailscaleIp = null;

  try {
    // ── STEP 1: SSH ──────────────────────────────────────────────────────
    jobStep(jobId, 'ssh', 'running', `Connecting to ${sshHost}:${sshPort} as ${sshUser}`);
    const nodeForSSH = { sshHost, sshPort: parseInt(sshPort)||22, sshUser, local: false };
    let authMethod = 'key';
    try {
      const r = await sshConnect(nodeForSSH);
      ssh = r.ssh; authMethod = 'key';
      jobStep(jobId, 'ssh', 'done', 'Connected via key');
    } catch(e) {
      if (!sshPassword) throw new Error(`Key auth failed and no password provided: ${e.message}`);
      const r = await sshConnect(nodeForSSH, sshPassword);
      ssh = r.ssh; authMethod = 'password';
      jobStep(jobId, 'ssh', 'done', 'Connected via password');
    }

    // ── STEP 2: Copy SSH key ─────────────────────────────────────────────
    if (authMethod === 'password') {
      jobStep(jobId, 'ssh_key', 'running', 'Installing HA SSH key');
      const pubKey = fs.readFileSync(KEY_PUB_PATH, 'utf8').trim();
      await ssh.execCommand(`mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qF '${pubKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pubKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`);
      ssh.dispose();
      const r = await sshConnect(nodeForSSH);
      ssh = r.ssh;
      jobStep(jobId, 'ssh_key', 'done', 'Key installed, reconnected via key');
    } else {
      jobStep(jobId, 'ssh_key', 'done', 'Key already installed');
    }

    // ── STEP 3: Detect OS ────────────────────────────────────────────────
    jobStep(jobId, 'os_detect', 'running', 'Detecting OS');
    const uname = (await ssh.execCommand('uname -s')).stdout.trim();
    const procVer = (await ssh.execCommand('cat /proc/version 2>/dev/null || echo ""')).stdout.toLowerCase();
    let os = 'linux';
    if (uname.includes('Darwin')) os = 'macos';
    else if (procVer.includes('microsoft') || procVer.includes('wsl')) os = 'wsl2';
    nodeData.os = os;
    jobStep(jobId, 'os_detect', 'done', `Detected: ${os}`);

    // ── STEP 4: Install dependencies ────────────────────────────────────
    jobStep(jobId, 'deps', 'running', 'Installing build dependencies');
    if (os === 'macos') {
      const brew = (await ssh.execCommand('which brew')).stdout.trim();
      if (!brew) throw new Error('Homebrew not found — install it first');
      await ssh.execCommand('brew install libpqxx postgresql 2>/dev/null || true');
    } else {
      await ssh.execCommand('apt-get update -qq 2>/dev/null && apt-get install -y g++ libpqxx-dev libpq-dev build-essential curl 2>/dev/null || true');
    }
    jobStep(jobId, 'deps', 'done', 'Dependencies installed');

    // ── STEP 5: Tailscale ────────────────────────────────────────────────
    jobStep(jobId, 'tailscale', 'running', 'Checking Tailscale status');

    // Check if already installed and connected
    const tsStatus = await ssh.execCommand('tailscale status --json 2>/dev/null || echo ""');
    let tsJson = null;
    try { tsJson = JSON.parse(tsStatus.stdout); } catch(_) {}

    if (tsJson?.BackendState === 'Running') {
      // Already connected — just get the IP
      const tsIp = (await ssh.execCommand('tailscale ip -4 2>/dev/null')).stdout.trim();
      if (tsIp) {
        tailscaleIp = tsIp;
        nodeData.ip = tsIp;
        nodeData.sshHost = tsIp;
        jobStep(jobId, 'tailscale', 'done', `Already connected — IP: ${tsIp}`);
      } else {
        jobStep(jobId, 'tailscale', 'done', 'Connected but no IPv4 — using public IP');
      }
    } else {
      // Install Tailscale
      jobStep(jobId, 'tailscale', 'running', 'Installing Tailscale...');
      await ssh.execCommand('curl -fsSL https://tailscale.com/install.sh | sh 2>/dev/null || true');

      // Start tailscale — get auth URL
      jobStep(jobId, 'tailscale', 'running', 'Starting Tailscale — generating auth URL...');
      const tsUp = await ssh.execCommand('tailscale up --auth-key="" 2>&1 || tailscale up 2>&1');
      const authUrlMatch = (tsUp.stdout + tsUp.stderr).match(/https:\/\/login\.tailscale\.com\/\S+/);

      if (authUrlMatch) {
        const authUrl = authUrlMatch[0];
        // Write auth URL to job so frontend can display it
        const j = loadJob(jobId);
        j.tailscaleAuthUrl = authUrl;
        j.awaitingTailscaleAuth = true;
        saveJob(jobId, j);
        jobStep(jobId, 'tailscale', 'running', `AUTH REQUIRED — visit: ${authUrl}`);

        // Poll for up to 5 minutes
        let connected = false;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const check = await ssh.execCommand('tailscale status --json 2>/dev/null || echo ""');
          let checkJson = null;
          try { checkJson = JSON.parse(check.stdout); } catch(_) {}
          if (checkJson?.BackendState === 'Running') {
            const tsIp = (await ssh.execCommand('tailscale ip -4 2>/dev/null')).stdout.trim();
            if (tsIp) {
              tailscaleIp = tsIp;
              nodeData.ip = tsIp;
              nodeData.sshHost = tsIp;
              const j2 = loadJob(jobId);
              j2.awaitingTailscaleAuth = false;
              j2.tailscaleIp = tsIp;
              saveJob(jobId, j2);
              connected = true;
              jobStep(jobId, 'tailscale', 'done', `Connected — Tailscale IP: ${tsIp}`);
              break;
            }
          }
          jobStep(jobId, 'tailscale', 'running', `Waiting for auth... (${(i+1)*5}s)`);
        }
        if (!connected) throw new Error('Tailscale auth timed out after 5 minutes');
      } else {
        // Might have connected without needing auth (pre-auth key or already authed)
        await new Promise(r => setTimeout(r, 2000));
        const tsIp = (await ssh.execCommand('tailscale ip -4 2>/dev/null')).stdout.trim();
        if (tsIp) {
          tailscaleIp = tsIp;
          nodeData.ip = tsIp;
          nodeData.sshHost = tsIp;
          jobStep(jobId, 'tailscale', 'done', `Connected — IP: ${tsIp}`);
        } else {
          jobStep(jobId, 'tailscale', 'done', 'Installed — no IP yet, using public IP');
        }
      }
    }

    // ── STEP 6: Deploy source ────────────────────────────────────────────
    jobStep(jobId, 'deploy', 'running', 'Writing app source to /opt/ha-app/app.cpp');
    await ssh.execCommand('mkdir -p /opt/ha-app && chmod 777 /opt/ha-app');
    const dbHost = nodeData.dbHost || 'localhost';
    const dbPass = nodeData.dbPass || 'secure-password-here';
    const src = getAppCpp(name, parseInt(appPort)||8080, dbHost, dbPass);
    await ssh.execCommand(`cat > /opt/ha-app/app.cpp << 'APPSRC'
${src}
APPSRC`);
    jobStep(jobId, 'deploy', 'done', 'Source written');

    // ── STEP 7: Compile ──────────────────────────────────────────────────
    jobStep(jobId, 'compile', 'running', 'Compiling C++ app');
    let res;
    if (os === 'macos') {
      res = await ssh.execCommand(
        `cd /opt/ha-app && HB=/opt/homebrew && ` +
        `PQLIB=$(ls -d $HB/Cellar/libpq/*/lib 2>/dev/null | head -1 || echo $HB/lib) && ` +
        `PQINC=$(ls -d $HB/Cellar/libpq/*/include 2>/dev/null | head -1 || echo $HB/include) && ` +
        `clang++ -std=c++17 -O2 app.cpp -I$HB/include -I$PQINC -L$HB/lib -L$PQLIB -lpqxx -lpq -o app 2>&1`
      );
    } else {
      res = await ssh.execCommand('cd /opt/ha-app && (g++-13 -std=c++17 -O2 app.cpp -lpqxx -lpq -o app 2>/dev/null || g++ -std=c++17 -O2 app.cpp -lpqxx -lpq -o app) 2>&1');
    }
    if ((res.stdout||'').includes('error:')) throw new Error(`Compile error: ${res.stdout.slice(0,200)}`);
    jobStep(jobId, 'compile', 'done', 'Binary compiled');

    // ── STEP 8: Service ──────────────────────────────────────────────────
    const svcType = serviceType || (os === 'macos' ? 'launchctl' : 'systemd');
    jobStep(jobId, 'service', 'running', `Setting up ${svcType} service`);
    if (svcType === 'docker') {
      await ssh.execCommand(`cat > /opt/ha-app/Dockerfile << 'DFILE'
${getDockerfile(parseInt(appPort)||8080)}
DFILE`);
      await ssh.execCommand('cd /opt/ha-app && docker build -t ha-app . 2>&1');
      await ssh.execCommand(`docker rm -f ha-app 2>/dev/null; docker run -d --name ha-app --restart unless-stopped -p ${appPort||8080}:${appPort||8080} ha-app`);
    } else if (svcType === 'launchctl') {
      await ssh.execCommand(`cat > ~/Library/LaunchAgents/com.ha-app.plist << 'PLIST'
${getLaunchctlPlist()}
PLIST`);
      await ssh.execCommand('launchctl unload ~/Library/LaunchAgents/com.ha-app.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/com.ha-app.plist');
    } else {
      await ssh.execCommand(`bash -c "cat > /etc/systemd/system/ha-app.service << 'UNIT'
${getSystemdService(name)}
UNIT"`);
      await ssh.execCommand('systemctl daemon-reload && systemctl enable ha-app && systemctl restart ha-app');
    }
    jobStep(jobId, 'service', 'done', `${svcType} service started`);

    // ── STEP 9: PostgreSQL setup ─────────────────────────────────────────
    if (db === 'master' || db === 'replica') {
      jobStep(jobId, 'postgres', 'running', `Setting up PostgreSQL as ${db}`);

      // Install PostgreSQL if not present
      const pgVer = (await ssh.execCommand('pg_lsclusters 2>/dev/null | grep "18" | wc -l')).stdout.trim();
      if (pgVer === '0') {
        jobStep(jobId, 'postgres', 'running', 'Installing PostgreSQL 18...');
        await ssh.execCommand('apt-get install -y postgresql-18 2>/dev/null || true');
      }

      if (db === 'master') {
        jobStep(jobId, 'postgres', 'running', 'Configuring PostgreSQL master');

        // Create users and DB
        await ssh.execCommand(`sudo -u postgres psql -c "CREATE USER appuser WITH PASSWORD '${dbPass}' REPLICATION;" 2>/dev/null || true`);
        await ssh.execCommand(`sudo -u postgres psql -c "CREATE DATABASE appdb OWNER appuser;" 2>/dev/null || true`);
        await ssh.execCommand(`sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE appdb TO appuser;" 2>/dev/null || true`);

        // WAL config
        await ssh.execCommand(`sudo -u postgres psql -c "ALTER SYSTEM SET wal_level = 'replica';" 2>/dev/null || true`);
        await ssh.execCommand(`sudo -u postgres psql -c "ALTER SYSTEM SET max_wal_senders = 10;" 2>/dev/null || true`);
        await ssh.execCommand(`sudo -u postgres psql -c "ALTER SYSTEM SET max_replication_slots = 10;" 2>/dev/null || true`);
        await ssh.execCommand(`sudo -u postgres psql -c "ALTER SYSTEM SET max_slot_wal_keep_size = '1GB';" 2>/dev/null || true`);
        await ssh.execCommand(`sudo -u postgres psql -c "ALTER ROLE appuser CONNECTION LIMIT 20;" 2>/dev/null || true`);

        // listen_addresses — use Tailscale IP if available
        const listenIp = tailscaleIp || (await ssh.execCommand('tailscale ip -4 2>/dev/null')).stdout.trim() || 'localhost';
        await ssh.execCommand(`sed -i "s/#listen_addresses = 'localhost'/listen_addresses = 'localhost,${listenIp}'/" /etc/postgresql/18/main/postgresql.conf`);
        await ssh.execCommand(`sed -i "s/listen_addresses = 'localhost'/listen_addresses = 'localhost,${listenIp}'/" /etc/postgresql/18/main/postgresql.conf 2>/dev/null || true`);

        // pg_hba.conf — allow Tailscale subnet
        await ssh.execCommand(`echo "host replication appuser 100.0.0.0/8 scram-sha-256" >> /etc/postgresql/18/main/pg_hba.conf`);
        await ssh.execCommand(`echo "host all appuser 100.0.0.0/8 scram-sha-256" >> /etc/postgresql/18/main/pg_hba.conf`);

        await ssh.execCommand('systemctl restart postgresql@18-main');
        await new Promise(r => setTimeout(r, 2000));

        const pgCheck = (await ssh.execCommand('sudo -u postgres psql -c "SELECT pg_is_in_recovery();" 2>/dev/null')).stdout;
        jobStep(jobId, 'postgres', 'done', `Master configured · is_recovery: ${pgCheck.includes('f') ? 'false ✓' : 'unknown'}`);

      } else if (db === 'replica') {
        // Replica — need master Tailscale IP (dbHost)
        if (!dbHost || dbHost === 'localhost') throw new Error('DB host (master Tailscale IP) is required for replica setup');

        jobStep(jobId, 'postgres', 'running', `Taking base backup from master at ${dbHost}`);

        await ssh.execCommand('systemctl stop postgresql@18-main 2>/dev/null || true');
        await ssh.execCommand('rm -rf /var/lib/postgresql/18/main && mkdir -p /var/lib/postgresql/18/main && chown postgres:postgres /var/lib/postgresql/18/main && chmod 700 /var/lib/postgresql/18/main');

        // pg_basebackup with password via env
        const pgbRes = await ssh.execCommand(
          `PGPASSWORD='${dbPass}' sudo -u postgres pg_basebackup ` +
          `-h ${dbHost} -p 5432 -U appuser ` +
          `-D /var/lib/postgresql/18/main ` +
          `-Xstream -P -R 2>&1`
        );
        if (pgbRes.stdout.includes('error') || pgbRes.stderr.includes('error')) {
          throw new Error(`pg_basebackup failed: ${pgbRes.stdout||pgbRes.stderr}`);
        }

        // Ensure postgresql.conf has data_directory set
        await ssh.execCommand(`echo "data_directory = '/var/lib/postgresql/18/main'" >> /etc/postgresql/18/main/postgresql.conf`);

        await ssh.execCommand('pg_ctlcluster 18 main start 2>/dev/null || systemctl start postgresql@18-main');
        await new Promise(r => setTimeout(r, 3000));

        const recoveryCheck = (await ssh.execCommand('sudo -u postgres psql -c "SELECT pg_is_in_recovery();" 2>/dev/null')).stdout;
        if (!recoveryCheck.includes('t')) throw new Error('Replica did not enter recovery mode');
        jobStep(jobId, 'postgres', 'done', `Replica streaming from ${dbHost}`);
      }
    } else {
      jobStep(jobId, 'postgres', 'done', 'DB role: none — skipped');
    }

    // ── STEP 10: Health check ────────────────────────────────────────────
    jobStep(jobId, 'health', 'running', `Checking app health on port ${appPort||8080}`);
    await new Promise(r => setTimeout(r, 3000));
    const hc = await ssh.execCommand(`curl -sf http://localhost:${appPort||8080}/health 2>&1`);
    if (!hc.stdout.includes('healthy')) throw new Error(`Health check failed: ${hc.stdout||hc.stderr}`);
    jobStep(jobId, 'health', 'done', `App healthy · ${hc.stdout.slice(0,60)}`);

    // ── STEP 11: Register ────────────────────────────────────────────────
    jobStep(jobId, 'register', 'running', 'Registering node and updating Nginx');
    const nodes = loadNodes();
    nodes[name] = {
      name, label: label||name,
      ip: nodeData.ip || ip,
      appPort: parseInt(appPort)||8080,
      sshHost: nodeData.sshHost || sshHost || ip,
      sshPort: parseInt(sshPort)||22, sshUser,
      role, db, os: nodeData.os, serviceType: svcType,
      tailscaleIp: tailscaleIp || null,
      local: false, addedAt: new Date().toISOString(),
    };
    saveNodes(nodes);
    try { await updateNginxUpstream(); } catch(e) { console.warn('Nginx update failed:', e.message); }
    jobStep(jobId, 'register', 'done', `Node '${name}' registered · Nginx updated`);

    ssh.dispose();
    const finalJob = loadJob(jobId);
    finalJob.status = 'done';
    finalJob.tailscaleIp = tailscaleIp;
    saveJob(jobId, finalJob);

  } catch(e) {
    const j = loadJob(jobId);
    const failing = j?.steps.findLast(s => s.status === 'running');
    if (failing) jobStep(jobId, failing.step, 'error', e.message);
    const j2 = loadJob(jobId);
    j2.status = 'error'; j2.error = e.message;
    saveJob(jobId, j2);
    if (ssh) try { ssh.dispose(); } catch(_) {}
    console.error(`[JOB ${jobId}] FAILED:`, e.message);
  }
}


// ── Routes ────────────────────────────────────────────────────────────────────

module.exports = { saveJob, loadJob, jobStep, runProvision };
