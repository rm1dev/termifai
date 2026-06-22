#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="termifai-windows-builder"

# Persistent caches (survive between builds)
XWIN_CACHE="${HOME}/.cache/xwin"
mkdir -p "$XWIN_CACHE"

# Build base image — only reruns when Dockerfile.windows changes
echo "==> Ensuring builder image is up to date..."
docker build -f "${ROOT}/Dockerfile.windows" -t "$IMAGE" "$ROOT"

# src-tauri/target-win is mounted so Rust incremental builds work across runs
mkdir -p "${ROOT}/src-tauri/target-win"

echo "==> Building Windows x64 + arm64 installers (NSIS)..."
docker run --rm \
    -v "${ROOT}:/app" \
    -v "termifai-win-nm:/app/node_modules" \
    -v "${XWIN_CACHE}:/root/.xwin-cache" \
    -v "termifai-cargo-registry:/root/.cargo/registry" \
    -v "termifai-cargo-git:/root/.cargo/git" \
    -e CARGO_TARGET_DIR=/app/src-tauri/target-win \
    -w /app \
    "$IMAGE" \
    sh -c "
        set -e
        npm install

        echo '--- Building x64 ---'
        npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis

        echo '--- Building arm64 ---'
        npx tauri build --runner cargo-xwin --target aarch64-pc-windows-msvc --bundles nsis
    "

echo ""
echo "==> Copying artifacts..."
for arch_pair in "x86_64-pc-windows-msvc:x64" "aarch64-pc-windows-msvc:arm64"; do
    target="${arch_pair%%:*}"
    arch="${arch_pair##*:}"
    out="${ROOT}/releases/windows/${arch}"
    mkdir -p "$out"
    bundle_dir="${ROOT}/src-tauri/target-win/${target}/release/bundle"
    if [ -d "$bundle_dir" ]; then
        cp -r "${bundle_dir}/." "$out/"
        echo "  releases/windows/${arch}/ done"
    fi
done

echo ""
echo "Done! Artifacts:"
ls -lhR "${ROOT}/releases/windows/" 2>/dev/null || true
