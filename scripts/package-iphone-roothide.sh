#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="${0:A:h:h}"
BACKEND_DIR="${ROOT_DIR}/backend-swift"
CONTROL_FILE="${BACKEND_DIR}/control"
CONTROL_BACKUP="$(mktemp)"

cp "${CONTROL_FILE}" "${CONTROL_BACKUP}"
restore_control() {
  cp "${CONTROL_BACKUP}" "${CONTROL_FILE}"
  rm -f "${CONTROL_BACKUP}"
}
trap restore_control EXIT

sed -i '' \
  -e 's/^Architecture:.*/Architecture: iphoneos-arm64e/' \
  "${CONTROL_FILE}"

make -C "${BACKEND_DIR}" clean-package
make -C "${BACKEND_DIR}" package \
  FINALPACKAGE=1 \
  ASSPPWEB_DIR=.. \
  THEOS_PACKAGE_SCHEME=rootless \
  THEOS_PACKAGE_ARCH=iphoneos-arm64e

deb="$(ls -t "${BACKEND_DIR}"/debs/wiki.qaq.unfaird_*_iphoneos-arm64e.deb | head -n 1)"
echo "${deb}"
