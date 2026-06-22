#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="termifai-linux-builder"

build_for_arch() {
    local platform="$1"   # linux/amd64 or linux/arm64
    local arch="$2"        # x64 or arm64
    local img_tag="${IMAGE}:${arch}"
    local target_dir="${ROOT}/src-tauri/target-linux-${arch}"
    local out="${ROOT}/releases/linux/${arch}"

    echo ""
    echo "==> Ensuring builder image is up to date (${arch})..."
    docker build \
        --platform "$platform" \
        -f "${ROOT}/Dockerfile.linux" \
        -t "$img_tag" \
        "$ROOT"

    mkdir -p "$target_dir"

    echo "==> Building for ${platform} (${arch})..."
    docker run --rm \
        --platform "$platform" \
        -v "${ROOT}:/app" \
        -v "termifai-linux-${arch}-nm:/app/node_modules" \
        -v "${target_dir}:/build-target" \
        -v "termifai-cargo-registry:/root/.cargo/registry" \
        -v "termifai-cargo-git:/root/.cargo/git" \
        -e CARGO_TARGET_DIR=/build-target \
        -w /app \
        "$img_tag" \
        sh -c "
            set -e
            npm install
            npx tauri build --bundles deb
        "

    echo "==> Artifacts ready at releases/linux/${arch}/"
    mkdir -p "$out"
    if [ -d "${target_dir}/release/bundle" ]; then
        cp -r "${target_dir}/release/bundle/." "$out/"
    fi
}

build_for_arch "linux/amd64" "x64"
build_for_arch "linux/arm64" "arm64"

echo ""
echo "Done! Artifacts:"
ls -lhR "${ROOT}/releases/linux/" 2>/dev/null || true
