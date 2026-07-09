#!/usr/bin/env bash
# Builds the termifaid sidecar and places it where Tauri's bundler
# expects external binaries: src-tauri/binaries/termifaid-<triple>[.exe]
# Usage: build-termifaid.sh [target-triple]   (defaults to the host triple)
set -euo pipefail

cd "$(dirname "$0")/../src-tauri"

TARGET="${1:-}"
if [ -n "$TARGET" ]; then
  cargo build --release -p termifaid --target "$TARGET"
  TRIPLE="$TARGET"
  BUILT="target/$TARGET/release/termifaid"
else
  cargo build --release -p termifaid
  TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
  BUILT="target/release/termifaid"
fi

EXT=""
case "$TRIPLE" in
  *windows*) EXT=".exe" ;;
esac

mkdir -p binaries
cp "${BUILT}${EXT}" "binaries/termifaid-${TRIPLE}${EXT}"
echo "sidecar ready: binaries/termifaid-${TRIPLE}${EXT}"
