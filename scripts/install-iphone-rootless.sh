#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="${0:A:h:h}"
DEVICE_HOST="${DEVICE_HOST:-root@192.168.2.122}"
HEALTH_URL="${ASSPPWEB_HEALTH_URL:-http://${DEVICE_HOST#*@}:8080/health}"

log() {
  printf '%s\n' "$*" >&2
}

if [[ $# -gt 0 ]]; then
  DEB_PATH="$1"
else
  package_output="$(make -C "${ROOT_DIR}" build)"
  printf '%s\n' "${package_output}"
  DEB_PATH="$(printf '%s\n' "${package_output}" | tail -n 1)"
fi

if [[ ! -f "${DEB_PATH}" ]]; then
  log "package missing: ${DEB_PATH}"
  exit 1
fi

REMOTE_DEB="/var/tmp/${DEB_PATH:t}"
log "Uploading ${DEB_PATH} to ${DEVICE_HOST}:${REMOTE_DEB}"
scp "${DEB_PATH}" "${DEVICE_HOST}:${REMOTE_DEB}"

log "Installing package on ${DEVICE_HOST}"
ssh "${DEVICE_HOST}" "apt install -y '${REMOTE_DEB}'"

log "Launchd status"
ssh "${DEVICE_HOST}" "launchctl print system/wiki.qaq.unfaird | grep -E 'state =|pid =|runs =|--port|8080'"

log "HTTP check ${HEALTH_URL}"
curl -fsS "${HEALTH_URL}"
