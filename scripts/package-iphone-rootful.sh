#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="${0:A:h:h}"
BACKEND_DIR="${ROOT_DIR}/backend-swift"
CONTROL_FILE="${BACKEND_DIR}/control"
CONTROL_BACKUP="$(mktemp)"
CONTROL_NEXT="$(mktemp)"
THEOS_DIR="${THEOS:-${ROOT_DIR:h}/theos}"

cleanup() {
  cp "${CONTROL_BACKUP}" "${CONTROL_FILE}"
  rm -f "${CONTROL_BACKUP}" "${CONTROL_NEXT}"
}
trap cleanup EXIT INT TERM

cp "${CONTROL_FILE}" "${CONTROL_BACKUP}"

awk '
  /^Architecture:/ {
    print "Architecture: iphoneos-arm"
    next
  }
  /^Depends:/ {
    print "Depends: firmware (>= 14.0)"
    next
  }
  { print }
' "${CONTROL_BACKUP}" > "${CONTROL_NEXT}"
cp "${CONTROL_NEXT}" "${CONTROL_FILE}"

make -C "${BACKEND_DIR}" clean-package THEOS="${THEOS_DIR}"
make -C "${BACKEND_DIR}" package \
  FINALPACKAGE=1 \
  THEOS="${THEOS_DIR}" \
  THEOS_PACKAGE_SCHEME= \
  ASSPPWEB_DIR="${ROOT_DIR}"

PACKAGE_PATH="$(find "${BACKEND_DIR}/debs" -maxdepth 1 -type f -name 'wiki.qaq.unfaird_*_iphoneos-arm.deb' -print | sort | tail -n 1)"
if [[ -z "${PACKAGE_PATH}" || ! -f "${PACKAGE_PATH}" ]]; then
  print -u2 "rootful package was not generated"
  exit 1
fi

print -r -- "${PACKAGE_PATH}"
