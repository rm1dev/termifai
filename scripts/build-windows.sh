#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="nailyudha/tauri:latest"
TARGET="x86_64-pc-windows-msvc"
OUT="${ROOT}/releases/windows"

# Cache the Windows SDK between builds (~3GB, avoids re-download each time)
XWIN_CACHE="${HOME}/.cache/xwin"
mkdir -p "$XWIN_CACHE"

echo "==> Building Windows x64 installer (NSIS) via Docker..."
docker run --rm \
    -v "${ROOT}:/app" \
    -v "${XWIN_CACHE}:/root/.xwin-cache" \
    -w /app \
    "$IMAGE" \
    sh -c "
        apt-get update -qq && apt-get install -y -qq nsis &&
        mise install rust@latest && mise use --global rust@latest &&
        rustup target add x86_64-pc-windows-msvc &&
        cargo install --locked cargo-xwin &&
        rm -rf node_modules &&
        bun install &&
        bun tauri build --runner cargo-xwin --target ${TARGET} --bundles nsis
    "

echo ""
echo "==> Copying artifacts to releases/windows/"
mkdir -p "$OUT"
BUNDLE_DIR="${ROOT}/src-tauri/target/${TARGET}/release/bundle"
if [ -d "$BUNDLE_DIR" ]; then
    cp -r "${BUNDLE_DIR}/." "$OUT/"
else
    echo "Warning: bundle dir not found, copying raw .exe"
    cp "${ROOT}/src-tauri/target/${TARGET}/release/termifai.exe" "$OUT/"
fi

echo ""
echo "Done! Artifacts:"
ls -lhR "$OUT"
