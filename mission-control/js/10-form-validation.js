// ═══ FORM VALIDATION ════════════════════════════════════════════════════════

const FIELD_RULES = {
  'an-name': {
    required: true,
    validate(v) {
      if (!v) return { type:'error', msg:'Node ID is required' };
      if (!/^[a-z0-9_-]+$/.test(v)) return { type:'error', msg:'Only lowercase letters, numbers, hyphens, underscores' };
      if (v.length > 24) return { type:'error', msg:'Max 24 characters' };
      if (S.nodeConfig[v] && !window._editingNode) return { type:'error', msg:`Node '${v}' already exists` };
      return { type:'ok', msg:'✓ Available' };
    }
  },
  'an-label': {
    validate(v) {
      if (!v) return { type:'warn', msg:'Label will default to Node ID' };
      return { type:'ok', msg:'' };
    }
  },
  'an-ip': {
    required: true,
    validate(v) {
      if (!v) return { type:'error', msg:'IP address is required' };
      const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (!ipv4.test(v)) return { type:'error', msg:'Enter a valid IPv4 address' };
      const parts = v.split('.').map(Number);
      if (parts.some(p => p > 255)) return { type:'error', msg:'Invalid IP — octets must be 0-255' };
      if (v.startsWith('127.') && !window._editingNode) return { type:'warn', msg:'Loopback IP — use for local node only' };
      if (v.startsWith('100.')) return { type:'ok', msg:'✓ Tailscale IP detected' };
      return { type:'ok', msg:'✓ Public IP' };
    }
  },
  'an-sshuser': {
    validate(v) {
      if (!v) return { type:'warn', msg:'Defaults to root' };
      if (v === 'root') return { type:'ok', msg:'✓ Root access — full provisioning available' };
      return { type:'warn', msg:'Non-root user — ensure sudo NOPASSWD is configured' };
    }
  },
  'an-sshpass': {
    validate(v) {
      if (!v) return { type:'warn', msg:'Key auth will be tried first. Required if key not yet installed.' };
      if (v.length < 6) return { type:'warn', msg:'Password seems short' };
      return { type:'ok', msg:'✓ Password provided — will be used for initial key deployment only' };
    }
  },
  'an-dbhost': {
    validate(v) {
      const dbRole = document.getElementById('an-db')?.value;
      if (dbRole === 'replica' && !v) return { type:'error', msg:'Master IP required for replica setup' };
      if (dbRole === 'master' && v) return { type:'warn', msg:'DB host ignored for master role' };
      if (v && !/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return { type:'error', msg:'Enter a valid IPv4 address' };
      if (v && v.startsWith('100.')) return { type:'ok', msg:'✓ Tailscale IP — replication will use VPN' };
      if (!v && dbRole !== 'replica') return { type:'ok', msg:'' };
      return { type:'ok', msg:'' };
    }
  },
};

function validateField(id) {
  const el = document.getElementById(id);
  const msgEl = document.getElementById('msg-' + id);
  if (!el) return true;
  const rule = FIELD_RULES[id];
  if (!rule) return true;
  const v = el.value.trim();
  const result = rule.validate(v);
  if (!result) return true;
  // Apply styles
  el.classList.remove('field-error', 'field-ok');
  if (result.type === 'error') el.classList.add('field-error');
  else if (result.type === 'ok' && v) el.classList.add('field-ok');
  if (msgEl) {
    msgEl.textContent = result.msg || '';
    msgEl.className = 'field-msg ' + (result.type || '');
  }
  return result.type !== 'error';
}

function validateAllFields() {
  const fields = Object.keys(FIELD_RULES);
  let valid = true;
  const errors = [];
  fields.forEach(id => {
    const ok = validateField(id);
    if (!ok) {
      const el = document.getElementById(id);
      const rule = FIELD_RULES[id];
      if (rule.required || (el && el.value.trim())) {
        valid = false;
        const result = rule.validate(el?.value?.trim() || '');
        if (result?.type === 'error') errors.push(result.msg);
      }
    }
  });
  // Extra cross-field validations
  const name = document.getElementById('an-name')?.value.trim();
  const ip = document.getElementById('an-ip')?.value.trim();
  const dbRole = document.getElementById('an-db')?.value;
  const dbHost = document.getElementById('an-dbhost')?.value.trim();
  const sshUser = document.getElementById('an-sshuser')?.value.trim() || 'root';
  const sshPass = document.getElementById('an-sshpass')?.value;
  if (!name) errors.push('Node ID is required');
  if (!ip) errors.push('IP address is required');
  if (dbRole === 'replica' && !dbHost) errors.push('DB host (master Tailscale IP) is required for replica');
  // Check if any existing node has same IP
  const existingWithIp = Object.values(S.nodeConfig).find(n => n.ip === ip && n.name !== window._editingNode);
  if (existingWithIp) errors.push(`IP ${ip} is already used by node '${existingWithIp.name}'`);
  const banner = document.getElementById('form-error-banner');
  if (errors.length) {
    if (banner) { banner.style.display=''; banner.innerHTML = '✗ ' + errors.join('<br>✗ '); }
    valid = false;
  } else {
    if (banner) banner.style.display='none';
  }
  return valid;
}

function onDbRoleChange() {
  validateField('an-dbhost');
  const dbRole = document.getElementById('an-db')?.value;
  const dbSection = document.getElementById('an-dbhost')?.closest('.form-section');
  if (!dbSection) return;
  if (dbRole === 'replica') {
    dbSection.classList.add('section-warn');
    dbSection.classList.remove('section-error');
  } else if (dbRole === 'none') {
    dbSection.classList.remove('section-warn', 'section-error');
  } else {
    dbSection.classList.remove('section-warn', 'section-error');
  }
}
