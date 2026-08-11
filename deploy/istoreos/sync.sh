#!/usr/bin/env bash
# Sync the private-platform app code to the iStoreOS router and restart the container.
#
# Layout on the router (see docker-compose.yml):
#   /opt/asspp-platform/
#     docker-compose.yml        host
#     config.router.json        host, mounted read-only as /app/config.router.json
#     private-platform/         host, mounted as /app  <-- this is what we sync
#
# Runtime state (data/, node_modules/, local configs) is never touched.
#
# Override defaults via env vars:
#   ROUTER_HOST / ROUTER_USER / ROUTER_SSH_PORT / ROUTER_HTTP_PORT / DEPLOY_DIR / PLATFORM_SOURCE
set -euo pipefail

ROUTER_HOST="${ROUTER_HOST:-192.168.100.1}"
ROUTER_USER="${ROUTER_USER:-root}"
ROUTER_SSH_PORT="${ROUTER_SSH_PORT:-22}"
ROUTER_HTTP_PORT="${ROUTER_HTTP_PORT:-8080}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/asspp-platform}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ -n "${PLATFORM_SOURCE:-}" ]]; then
  LOCAL_PLATFORM="$PLATFORM_SOURCE"
elif [[ -f "$WORKSPACE/private-platform/admin-system.mjs" ]]; then
  LOCAL_PLATFORM="$WORKSPACE/private-platform"
else
  LOCAL_PLATFORM="$WORKSPACE/asspp-work/AssppJailbroken/private-platform"
fi

SSH_OPTS=(-o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o BatchMode=yes)
REMOTE="$ROUTER_USER@$ROUTER_HOST"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; }

# --- preflight: source must exist and parse ---------------------------------
[[ -f "$LOCAL_PLATFORM/server.mjs" ]] || { err "server.mjs not found at $LOCAL_PLATFORM"; exit 1; }
[[ -f "$LOCAL_PLATFORM/admin-system.mjs" && -f "$LOCAL_PLATFORM/device-scheduling-policy.mjs" ]] || {
  err "refusing to deploy legacy platform source: integrated admin modules are missing at $LOCAL_PLATFORM"
  exit 1
}
log "checking local syntax (node --check)"
( cd "$LOCAL_PLATFORM" && npm run check && npm test ) || { err "local checks failed, aborting"; exit 1; }

# --- preflight: reachability ------------------------------------------------
log "probing $ROUTER_HOST:$ROUTER_SSH_PORT (ssh)"
if ! ssh "${SSH_OPTS[@]}" -p "$ROUTER_SSH_PORT" "$REMOTE" \
     'echo ok' >/dev/null 2>&1; then
  err "cannot reach $REMOTE on port $ROUTER_SSH_PORT"
  err "if you are not on the LAN, set ROUTER_HOST to the public host and ROUTER_SSH_PORT accordingly"
  exit 2
fi

# --- sync app code (state / local config excluded) --------------------------
log "rsync app code -> $REMOTE:$DEPLOY_DIR/private-platform/"
rsync -avz --delete \
  --exclude 'data/' \
  --exclude 'node_modules/' \
  --exclude '.DS_Store' \
  --exclude 'config.local.json' \
  --exclude 'config.json' \
  -e "ssh ${SSH_OPTS[*]} -p $ROUTER_SSH_PORT" \
  "$LOCAL_PLATFORM/" \
  "$REMOTE:$DEPLOY_DIR/private-platform/"

# --- restart container so node picks up the new code ------------------------
log "restarting container on the router"
ssh "${SSH_OPTS[@]}" -p "$ROUTER_SSH_PORT" "$REMOTE" \
  "cd $DEPLOY_DIR && docker compose up -d --force-recreate asspp-platform"

# --- health check -----------------------------------------------------------
log "health check http://$ROUTER_HOST:$ROUTER_HTTP_PORT/api/health"
code=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  code="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://$ROUTER_HOST:$ROUTER_HTTP_PORT/api/health" || true)"
  [[ "$code" == "200" ]] && break
  sleep 1
done
if [[ "$code" == "200" ]]; then
  log "\033[1;32mdone\033[0m - platform is up (HTTP 200)"
else
  err "health check returned HTTP $code (container may still be starting; retry shortly)"
  exit 3
fi
