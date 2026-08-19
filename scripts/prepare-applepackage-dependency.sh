#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${REPOSITORY_ROOT}/backend-swift"
MIN_IOS="15.0"
RESOLVE_DEPENDENCIES=1

while (($# > 0)); do
  case "$1" in
    --backend-dir)
      BACKEND_DIR="$(cd "$2" && pwd)"
      shift 2
      ;;
    --min-ios)
      MIN_IOS="$2"
      shift 2
      ;;
    --no-resolve)
      RESOLVE_DEPENDENCIES=0
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${MIN_IOS}" ]]; then
  echo "--min-ios is required" >&2
  exit 2
fi

# ApplePackage is a local package in release checkouts. Older workspaces used
# a SwiftPM checkout path, so support both layouts for reproducible builds.
if [[ -f "${BACKEND_DIR}/vendor/ApplePackage/Package.swift" ]]; then
  CHECKOUT_DIR="${BACKEND_DIR}/vendor/ApplePackage"
else
  CHECKOUT_DIR="${BACKEND_DIR}/.build/checkouts/ApplePackage"
fi
PACKAGE_FILE="${CHECKOUT_DIR}/Package.swift"

if [[ "${RESOLVE_DEPENDENCIES}" == "1" ]]; then
  swift package --package-path "${BACKEND_DIR}" resolve
fi

if [[ ! -f "${PACKAGE_FILE}" ]]; then
  echo "ApplePackage checkout missing after dependency resolution: ${CHECKOUT_DIR}" >&2
  exit 1
fi

apply_patch_once() {
  local patch_file="$1"
  local already_applied_marker="$2"
  local label="$3"

  if grep -Fq "${already_applied_marker}" "${PACKAGE_FILE}" \
      "${CHECKOUT_DIR}/Sources/ApplePackage/Commands/Authenticate.swift" \
      "${CHECKOUT_DIR}/Sources/ApplePackage/Supplement/Logger.swift"; then
    echo "${label} already applied"
    return
  fi

  if git -C "${CHECKOUT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! git -C "${CHECKOUT_DIR}" apply --check "${patch_file}"; then
      echo "${label} no longer applies cleanly" >&2
      exit 1
    fi
    git -C "${CHECKOUT_DIR}" apply "${patch_file}"
  else
    if ! (cd "${CHECKOUT_DIR}" && patch --dry-run -p1 < "${patch_file}" >/dev/null); then
      echo "${label} no longer applies cleanly" >&2
      exit 1
    fi
    (cd "${CHECKOUT_DIR}" && patch -p1 < "${patch_file}" >/dev/null)
  fi
  echo "Applied ${label}"
}

if grep -Fq 'private static let legacyAuthEndpoint' \
    "${CHECKOUT_DIR}/Sources/ApplePackage/Commands/Authenticate.swift"; then
  echo 'ApplePackage runtime fixes already applied'
elif grep -Fq 'nativeAuthEndpoint' \
    "${CHECKOUT_DIR}/Sources/ApplePackage/Commands/Authenticate.swift" \
    && grep -Fq 'gatewayResponse' \
    "${CHECKOUT_DIR}/Sources/ApplePackage/Commands/Authenticate.swift"; then
  echo 'ApplePackage runtime fixes already present in vendor snapshot'
else
  apply_patch_once \
    "${REPOSITORY_ROOT}/patches/applepackage-runtime-fixes.patch" \
    'private static let legacyAuthEndpoint' \
    'ApplePackage runtime fixes'
fi

if [[ "${MIN_IOS}" == "14.0" ]]; then
  apply_patch_once \
    "${REPOSITORY_ROOT}/patches/applepackage-ios14.patch" \
    '.iOS(.v14)' \
    'ApplePackage iOS 14 compatibility patch'
  grep -Fq '.iOS(.v14)' "${PACKAGE_FILE}"
fi

if ! grep -Fq 'private static let legacyAuthEndpoint' \
    "${CHECKOUT_DIR}/Sources/ApplePackage/Commands/Authenticate.swift" \
    && ! (grep -Fq 'nativeAuthEndpoint' \
      "${CHECKOUT_DIR}/Sources/ApplePackage/Commands/Authenticate.swift" \
      && grep -Fq 'gatewayResponse' \
      "${CHECKOUT_DIR}/Sources/ApplePackage/Commands/Authenticate.swift"); then
  echo 'ApplePackage authentication fallback is missing' >&2
  exit 1
fi
