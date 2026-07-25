#!/usr/bin/env bash
# Cross-compile Termifai for Windows ARM64 (aarch64-pc-windows-msvc) from macOS/Linux.
# Needs: rustup target, cargo-xwin, llvm (clang-cl/lld-link), nsis
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="aarch64-pc-windows-msvc"

if ! command -v cargo-xwin >/dev/null 2>&1; then
  echo "error: cargo-xwin is required (install: cargo install --locked cargo-xwin)" >&2
  exit 1
fi

# Put llvm first on PATH so clang-cl / lld-link resolve correctly
if [ -d /opt/homebrew/opt/llvm/bin ]; then
  export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
elif [ -d /usr/local/opt/llvm/bin ]; then
  export PATH="/usr/local/opt/llvm/bin:$PATH"
fi

if ! command -v clang-cl >/dev/null 2>&1; then
  echo "error: clang-cl not found; install llvm (e.g. brew install llvm) and ensure it is on PATH" >&2
  exit 1
fi

# The ring crate builds for aarch64-windows with the GNU clang driver,
# but cargo-xwin injects clang-cl-style /imsvc flags into CFLAGS.
# This shim rewrites each /imsvc to -isystem.
if [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
  REAL_CLANG=/opt/homebrew/opt/llvm/bin/clang
elif [ -x /usr/local/opt/llvm/bin/clang ]; then
  REAL_CLANG=/usr/local/opt/llvm/bin/clang
else
  REAL_CLANG="$(command -v clang)"
fi

SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/termifai-xwin-clang.XXXXXX")"
cleanup() { rm -rf "$SHIM_DIR"; }
trap cleanup EXIT

cat >"$SHIM_DIR/clang" <<EOF
#!/usr/bin/env bash
args=()
for a in "\$@"; do
  if [ "\$a" = "/imsvc" ]; then
    args+=("-isystem")
  else
    args+=("\$a")
  fi
done
exec "${REAL_CLANG}" "\${args[@]}"
EOF
chmod +x "$SHIM_DIR/clang"
export PATH="$SHIM_DIR:$PATH"

bash "$ROOT/scripts/build-termifaid.sh" "$TARGET"
cd "$ROOT"
exec tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis
