#!/bin/bash
# Called by keepalived when this node loses MASTER state.
# Releases the Floating IP locally and reassigns it to the backup node via the Hetzner Cloud API.

# Prevent double-execution if multiple notify hooks fire close together
LOCK="/tmp/failover.lock"
[ -f "$LOCK" ] && exit 0
touch "$LOCK"
sleep 1
rm -f "$LOCK"

TOKEN="YOUR_HETZNER_API_TOKEN"
FLOATING_IP_ID="YOUR_FLOATING_IP_ID"
BACKUP_SERVER_ID="YOUR_BACKUP_SERVER_ID"
FLOATING_IP="YOUR_FLOATING_IP"

ip addr del "${FLOATING_IP}/32" dev eth0 2>/dev/null || true

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"server\": $BACKUP_SERVER_ID}" \
  "https://api.hetzner.cloud/v1/floating_ips/$FLOATING_IP_ID/actions/assign" \
  >> /var/log/keepalived-failover.log 2>&1

echo "$(date): Floating IP released, reassigned to backup" >> /var/log/keepalived-failover.log
