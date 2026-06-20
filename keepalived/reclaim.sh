#!/bin/bash
# Called by keepalived when this (primary) node regains MASTER state.
# Reassigns the Floating IP back and re-adds it to the local interface.

TOKEN="YOUR_HETZNER_API_TOKEN"
FLOATING_IP_ID="YOUR_FLOATING_IP_ID"
PRIMARY_SERVER_ID="YOUR_PRIMARY_SERVER_ID"
FLOATING_IP="YOUR_FLOATING_IP"

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"server\": $PRIMARY_SERVER_ID}" \
  "https://api.hetzner.cloud/v1/floating_ips/$FLOATING_IP_ID/actions/assign" \
  >> /var/log/keepalived-failover.log 2>&1

sleep 3
ip addr add "${FLOATING_IP}/32" dev eth0 2>/dev/null || true

echo "$(date): Floating IP reclaimed" >> /var/log/keepalived-failover.log
