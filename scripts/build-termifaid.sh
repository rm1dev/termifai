#!/usr/bin/env bash
# Builds the Termifaid sidecar and places it where Tauri's bundler
# expects external binaries: src-tauri/binaries/Termifaid-<triple>[.exe]
# Usage: build-termifaid.sh [target-triple]   (defaults to the host triple)
set -euo pipefail

cd "$(dirname "$0")/../src-tauri"

TARGET="${1:-}"

# Cross-compiling *-windows-msvc from macOS/Linux needs cargo-xwin —
# native Windows link.exe is not available here.
cargo_build() {
  local -a cmd=(cargo build --release -p Termifaid)
  local t="${1:-}"
  if [ -n "$t" ] && [[ "$t" == *-windows-msvc ]] && ! command -v link.exe >/dev/null 2>&1; then
    if ! command -v cargo-xwin >/dev/null 2>&1; then
      echo "error: cargo-xwin is required to cross-compile $t (install: cargo install --locked cargo-xwin)" >&2
      exit 1
    fi
    # Ensure llvm tools (clang-cl / lld-link) are on PATH
    if [ -d /opt/homebrew/opt/llvm/bin ]; then
      export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
    elif [ -d /usr/local/opt/llvm/bin ]; then
      export PATH="/usr/local/opt/llvm/bin:$PATH"
    fi
    cmd=(cargo xwin build --release -p Termifaid)
  fi
  if [ -n "$t" ]; then
    "${cmd[@]}" --target "$t"
  else
    "${cmd[@]}"
  fi
}

if [ -n "$TARGET" ]; then
  cargo_build "$TARGET"
  TRIPLE="$TARGET"
  BUILT="target/$TARGET/release/Termifaid"
else
  cargo_build
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
