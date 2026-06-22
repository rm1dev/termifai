#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="nailyudha/tauri:latest"

# Cache the Windows SDK between builds (~3GB, avoids re-download each time)
XWIN_CACHE="${HOME}/.cache/xwin"
mkdir -p "$XWIN_CACHE"

echo "==> Building Windows x64 + arm64 installers (NSIS) in a single container..."
docker run --rm \
    -v "${ROOT}:/app" \
    -v "${XWIN_CACHE}:/root/.xwin-cache" \
    -w /app \
    "$IMAGE" \
    sh -c "
        set -e

        apt-get update -qq && apt-get install -y -qq nsis &&
        mise install rust@latest && mise use --global rust@latest &&
        rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc &&
        cargo install --locked cargo-xwin &&

        rm -rf node_modules &&
        bun install &&

        echo '--- Building x64 ---' &&
        bun tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis &&

        echo '--- Building arm64 ---' &&
        bun tauri build --runner cargo-xwin --target aarch64-pc-windows-msvc --bundles nsis
    "

echo ""
echo "==> Copying artifacts..."
for arch_pair in "x86_64-pc-windows-msvc:x64" "aarch64-pc-windows-msvc:arm64"; do
    target="${arch_pair%%:*}"
    arch="${arch_pair##*:}"
    out="${ROOT}/releases/windows/${arch}"
    mkdir -p "$out"
    bundle_dir="${ROOT}/src-tauri/target/${target}/release/bundle"
    if [ -d "$bundle_dir" ]; then
        cp -r "${bundle_dir}/." "$out/"
        echo "  releases/windows/${arch}/ done"
    fi
done

echo ""
echo "Done! Artifacts:"
ls -lhR "${ROOT}/releases/windows/"
