const fs = require('fs');
const { execLocal } = require('./ssh');
const { loadNodes } = require('./nodes-store');

async function updateNginxUpstream() {
  const nodes = loadNodes();
  const entries = Object.values(nodes).filter(n => !n.local);
  const localNode = Object.values(nodes).find(n => n.local);

  let upstream = 'upstream ha_backends {\n';
  // Local (Hetzner) always gets higher weight as it's always available
  if (localNode) upstream += `    server 127.0.0.1:${localNode.appPort} weight=2;\n`;
  entries.forEach(n => {
    upstream += `    server ${n.ip}:${n.appPort} weight=1;\n`;
  });
  upstream += '    keepalive 32;\n}\n';

  const conf = `${upstream}
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Health check — no rate limit, skip 503 backends (DB down)
    location = /health {
        proxy_pass http://ha_backends;
        proxy_next_upstream error timeout http_500 http_502 http_503 http_504;
        proxy_next_upstream_tries 3;
        access_log off;
    }

    location / {
        limit_req zone=app burst=50 nodelay;
        proxy_pass http://ha_backends;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_connect_timeout 5s;
        proxy_send_timeout 10s;
        proxy_read_timeout 10s;
        proxy_next_upstream error timeout http_500 http_502 http_503 http_504;
        proxy_next_upstream_tries 3;
        proxy_next_upstream_timeout 10s;
    }
}`;

  fs.writeFileSync('/etc/nginx/conf.d/ha-upstream.conf', conf);
  await execLocal('nginx -t && systemctl reload nginx');
  console.log(`[Nginx] Upstream updated: ${Object.keys(nodes).join(', ')}`);
}

// ── Provisioning ──────────────────────────────────────────────────────────────

module.exports = { updateNginxUpstream };
