#!/usr/bin/env bash
# Builds the Termifaid sidecar and places it where Tauri's bundler
# expects external binaries: src-tauri/binaries/Termifaid-<triple>[.exe]
# Usage: build-termifaid.sh [target-triple]   (defaults to the host triple)
set -euo pipefail

cd "$(dirname "$0")/../src-tauri"

TARGET="${1:-}"
if [ -n "$TARGET" ]; then
  cargo build --release -p Termifaid --target "$TARGET"
  TRIPLE="$TARGET"
  BUILT="target/$TARGET/release/Termifaid"
else
  cargo build --release -p Termifaid
  TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
  BUILT="target/release/Termifaid"
fi

EXT=""
case "$TRIPLE" in
  *windows*) EXT=".exe" ;;
esac

mkdir -p binaries
cp "${BUILT}${EXT}" "binaries/com.termifai-${TRIPLE}${EXT}"
echo "sidecar ready: binaries/com.termifai-${TRIPLE}${EXT}"
