#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="${0:A:h:h}"

make -C "${ROOT_DIR}" build
