#!/bin/bash

set -euo pipefail

usage() {
    echo "Usage: $0 --variant iphone8|iphone11|iphone15 PACKAGE.deb" >&2
    exit 64
}

variant=""
if [[ "${1:-}" == "--variant" ]]; then
    variant="${2:-}"
    shift 2
fi
[[ -n "$variant" && $# -eq 1 ]] || usage

deb="$1"
[[ -f "$deb" ]] || { echo "DEB not found: $deb" >&2; exit 66; }

script_dir="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_dir/.." && pwd)"
manifest_tool="${RELEASE_MANIFEST_TOOL:-$repository_root/scripts/release-manifest.mjs}"
profile_environment="$(node "$manifest_tool" env "$variant")"
eval "$profile_environment"

dpkg_deb="${DPKG_DEB:-dpkg-deb}"
lipo="${LIPO:-$(xcrun --find lipo 2>/dev/null || command -v lipo || true)}"
vtool="${VTOOL:-$(xcrun --find vtool 2>/dev/null || command -v vtool || true)}"
otool="${OTOOL:-$(xcrun --find otool 2>/dev/null || command -v otool || true)}"

[[ -x "$lipo" ]] || { echo "lipo unavailable" >&2; exit 69; }
[[ -x "$vtool" || -x "$otool" ]] || { echo "vtool/otool unavailable" >&2; exit 69; }

actual_version="$($dpkg_deb -f "$deb" Version)"
[[ "$actual_version" == "$RELEASE_VERSION" ]] || {
    echo "DEB version mismatch: expected $RELEASE_VERSION, got $actual_version" >&2
    exit 1
}

actual_deb_architecture="$($dpkg_deb -f "$deb" Architecture)"
[[ "$actual_deb_architecture" == "$DEB_ARCHITECTURE" ]] || {
    echo "DEB architecture mismatch: expected $DEB_ARCHITECTURE, got $actual_deb_architecture" >&2
    exit 1
}

audit_root="$(mktemp -d "${TMPDIR:-/tmp}/asspp-deb-audit.XXXXXX")"
cleanup() { rm -rf "$audit_root"; }
trap cleanup EXIT
$dpkg_deb -x "$deb" "$audit_root"

find_payload_file() {
    local basename="$1"
    find "$audit_root" -type f -path "*/usr/local/lib/unfaird/$basename" -print -quit
}

assert_architecture() {
    local binary="$1"
    local label="$2"
    local architecture_info
    architecture_info="$($lipo -info "$binary")"
    grep -Eq "(^|[^[:alnum:]_])${MACH_O_ARCH}([^[:alnum:]_]|$)" <<< "$architecture_info" || {
        echo "$label Mach-O architecture mismatch: expected $MACH_O_ARCH; $architecture_info" >&2
        exit 1
    }
    echo "$label Mach-O architecture: $MACH_O_ARCH"
}

daemon="$(find_payload_file UnfairDaemon)"
[[ -n "$daemon" ]] || { echo "UnfairDaemon missing from DEB" >&2; exit 1; }
assert_architecture "$daemon" UnfairDaemon

build_info=""
if [[ -x "$vtool" ]]; then build_info="$($vtool -show-build "$daemon" 2>/dev/null || true)"; fi
actual_min_ios="$(awk '$1 == "minos" { print $2; exit }' <<< "$build_info")"
if [[ -z "$actual_min_ios" && -x "$otool" ]]; then
    load_commands="$($otool -l "$daemon")"
    actual_min_ios="$(awk '/cmd LC_VERSION_MIN_IPHONEOS/ { found=1; next } found && $1 == "version" { print $2; exit }' <<< "$load_commands")"
fi
[[ -n "$actual_min_ios" ]] || { echo "UnfairDaemon minimum iOS unavailable" >&2; exit 1; }
IFS=. read -r actual_major actual_minor _ <<< "$actual_min_ios"
actual_min_ios="${actual_major}.${actual_minor:-0}"
[[ "$actual_min_ios" == "$MIN_IOS" ]] || {
    echo "UnfairDaemon minimum iOS mismatch: expected $MIN_IOS, got $actual_min_ios" >&2
    exit 1
}
echo "UnfairDaemon minimum iOS: $actual_min_ios"

if [[ "$DEVICE_PROFILE" == "taurine" ]]; then
    for asset in UnfairRuntimeRunner UnfairRuntimeDumper.dylib; do
        binary="$(find_payload_file "$asset")"
        [[ -n "$binary" ]] || { echo "Taurine runtime asset missing: $asset" >&2; exit 1; }
        assert_architecture "$binary" "$asset"
    done
fi

echo "device architecture: $DEVICE_ARCHITECTURE"
echo "DEB audit passed: $DEVICE_VARIANT $RELEASE_VERSION ($DEB_ARCHITECTURE)"
