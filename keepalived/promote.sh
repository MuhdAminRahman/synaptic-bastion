#!/bin/bash
# Called by keepalived on the backup node when it assumes MASTER state.
# Claims the Floating IP and binds it locally.

TOKEN="YOUR_HETZNER_API_TOKEN"
FLOATING_IP_ID="YOUR_FLOATING_IP_ID"
BACKUP_SERVER_ID="YOUR_BACKUP_SERVER_ID"
FLOATING_IP="YOUR_FLOATING_IP"

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"server\": $BACKUP_SERVER_ID}" \
  "https://api.hetzner.cloud/v1/floating_ips/$FLOATING_IP_ID/actions/assign" \
  >> /var/log/keepalived-failover.log 2>&1

ip addr add "${FLOATING_IP}/32" dev eth0 2>/dev/null || true

echo "$(date): Backup node promoted — Floating IP claimed" >> /var/log/keepalived-failover.log
