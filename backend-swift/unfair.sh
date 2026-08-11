#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  ./unfair.sh <host[:port]> <ipa-path> [output-path]

Examples:
  ./unfair.sh 192.168.2.122 /path/to/app.ipa
  ./unfair.sh 192.168.2.122:8080 /path/to/app.ipa ./output.ipa

Environment:
  UNFAIRD_POLL_INTERVAL  Seconds between ready checks. Default: 5
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

expand_path() {
  case "$1" in
    \~) printf '%s\n' "$HOME" ;;
    \~/*) printf '%s\n' "${HOME}/${1#\~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

base_url_for() {
  case "$1" in
    http://*|https://*) printf '%s\n' "${1%/}" ;;
    *:*) printf 'http://%s\n' "${1%/}" ;;
    *) printf 'http://%s:8080\n' "${1%/}" ;;
  esac
}

absolute_url() {
  local base_url="$1"
  local path="$2"

  case "$path" in
    http://*|https://*) printf '%s\n' "$path" ;;
    /*) printf '%s%s\n' "$base_url" "$path" ;;
    *) printf '%s/%s\n' "$base_url" "$path" ;;
  esac
}

json_value() {
  local file="$1"
  local path="$2"

  python3 - "$file" "$path" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)

for key in sys.argv[2].split("."):
    if not key:
        continue
    if isinstance(value, dict):
        value = value.get(key)
    else:
        value = None
    if value is None:
        break

if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print("")
else:
    print(value)
PY
}

json_log_value() {
  local file="$1"
  local path="$2"

  python3 - "$file" "$path" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)

for key in sys.argv[2].split("."):
    if not key:
        continue
    if isinstance(value, dict):
        value = value.get(key)
    else:
        value = None
    if value is None:
        break

if value is not None:
    print(value, end="")
PY
}

print_log_section() {
  local label="$1"
  local value="$2"

  [[ -n "$value" ]] || return 0
  printf '%s\n' "$label"
  printf '%s' "$value"
  case "$value" in
    *$'\n') ;;
    *) printf '\n' ;;
  esac
}

file_size() {
  if stat -f %z "$1" >/dev/null 2>&1; then
    stat -f %z "$1"
  else
    stat -c %s "$1"
  fi
}

http_success() {
  case "$1" in
    2*) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 64
fi

require_command curl
require_command python3

target="$1"
ipa_path="$(expand_path "$2")"
output_path="${3:-}"
poll_interval="${UNFAIRD_POLL_INTERVAL:-5}"

[[ -f "$ipa_path" ]] || die "ipa path does not exist: $ipa_path"
[[ "$ipa_path" == *.ipa ]] || die "ipa file required: $ipa_path"

base_url="$(base_url_for "$target")"
upload_url="${base_url}/api/v1/decrypt"

if [[ -z "$output_path" ]]; then
  ipa_name="$(basename "$ipa_path")"
  output_path="./${ipa_name%.ipa}-decrypted.ipa"
else
  output_path="$(expand_path "$output_path")"
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

upload_response="${tmp_dir}/upload.json"
ready_response="${tmp_dir}/ready.json"

echo "uploading: $ipa_path"
upload_code="$(
  curl -sS \
    -o "$upload_response" \
    -w '%{http_code}' \
    -F "ipa=@${ipa_path};filename=$(basename "$ipa_path")" \
    "$upload_url"
)"

if ! http_success "$upload_code"; then
  cat "$upload_response" >&2
  echo >&2
  die "upload failed with HTTP $upload_code"
fi

job_id="$(json_value "$upload_response" "queue.id")"
status="$(json_value "$upload_response" "queue.status")"
ready="$(json_value "$upload_response" "queue.ready")"
ready_url="$(json_value "$upload_response" "queue.ready_url")"
download_url="$(json_value "$upload_response" "queue.download_url")"

[[ -n "$job_id" ]] || die "upload response missing queue.id"
[[ -n "$ready_url" ]] || die "upload response missing queue.ready_url"
[[ -n "$download_url" ]] || die "upload response missing queue.download_url"

ready_endpoint="$(absolute_url "$base_url" "$ready_url")"
download_endpoint="$(absolute_url "$base_url" "$download_url")"

echo "queued: id=$job_id status=$status ready=$ready"

while [[ "$ready" != "true" ]]; do
  sleep "$poll_interval"

  ready_code="$(
    curl -sS \
      -o "$ready_response" \
      -w '%{http_code}' \
      "$ready_endpoint"
  )"

  if ! http_success "$ready_code"; then
    cat "$ready_response" >&2
    echo >&2
    die "ready check failed with HTTP $ready_code"
  fi

  status="$(json_value "$ready_response" "queue.status")"
  ready="$(json_value "$ready_response" "queue.ready")"
  error_message="$(json_value "$ready_response" "error")"
  exit_code="$(json_value "$ready_response" "exit.code")"
  stdout_log="$(json_log_value "$ready_response" "exit.stdout")"
  stderr_log="$(json_log_value "$ready_response" "exit.stderr")"

  echo "status: $status ready=$ready"

  if [[ "$status" == "failed" ]]; then
    print_log_section "--- stdout ---" "$stdout_log"
    print_log_section "--- stderr ---" "$stderr_log"
    [[ -n "$exit_code" ]] && echo "exit code: $exit_code" >&2
    [[ -n "$error_message" ]] && echo "error: $error_message" >&2
    die "decrypt job failed"
  fi
done

stdout_log="$(json_log_value "$ready_response" "exit.stdout")"
stderr_log="$(json_log_value "$ready_response" "exit.stderr")"
print_log_section "--- stdout ---" "$stdout_log"
print_log_section "--- stderr ---" "$stderr_log"

mkdir -p "$(dirname "$output_path")"
echo "downloading: $output_path"
download_code="$(
  curl -sS -L \
    -o "$output_path" \
    -w '%{http_code}' \
    "$download_endpoint"
)"

if ! http_success "$download_code"; then
  rm -f "$output_path"
  die "download failed with HTTP $download_code"
fi

echo "done: $output_path ($(file_size "$output_path") bytes)"
