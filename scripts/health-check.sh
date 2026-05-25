#!/usr/bin/env bash
# Hippocampus health check — runs via systemd timer every 10 minutes
# Logs to /var/log/hippocampus-health.log

set -euo pipefail

LOG="/var/log/hippocampus-health.log"
HEALTH_URL="http://localhost:3000/health"
DISK_WARN_PERCENT=80
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

log() {
  echo "${TIMESTAMP} $1" >> "$LOG"
}

errors=0

# 1. Check Docker container is running
if docker inspect --format='{{.State.Running}}' hippocampus 2>/dev/null | grep -q true; then
  log "OK container=running"
else
  log "FAIL container=not_running"
  errors=$((errors + 1))
fi

# 2. Check /health endpoint
http_code=$(curl -s -o /tmp/hippo-health-response -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$http_code" = "200" ]; then
  response=$(cat /tmp/hippo-health-response)
  log "OK health=${http_code} ${response}"
else
  log "FAIL health=${http_code}"
  errors=$((errors + 1))
fi
rm -f /tmp/hippo-health-response

# 3. Check disk usage
disk_percent=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %' || df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$disk_percent" -ge "$DISK_WARN_PERCENT" ]; then
  log "WARN disk=${disk_percent}%"
else
  log "OK disk=${disk_percent}%"
fi

# 4. Check system memory
if command -v free &>/dev/null; then
  mem_info=$(free -m | awk '/^Mem:/ {printf "total=%sMB used=%sMB available=%sMB", $2, $3, $7}')
  log "OK memory ${mem_info}"
fi

if [ "$errors" -gt 0 ]; then
  log "SUMMARY errors=${errors}"
fi
