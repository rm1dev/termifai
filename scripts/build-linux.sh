#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="termifai-linux-builder"

build_for_platform() {
    local platform="$1"   # linux/amd64 or linux/arm64
    local arch="$2"        # x64 or arm64
    local tag="${IMAGE}:${arch}"
    local out="${ROOT}/releases/linux/${arch}"

    echo ""
    echo "==> Building for ${platform} (${arch})..."
    docker build \
        --platform "$platform" \
        -f Dockerfile.linux \
        -t "$tag" \
        "$ROOT"

    echo "==> Extracting artifacts to releases/linux/${arch}/"
    mkdir -p "$out"
    local container
    container=$(docker create --platform "$platform" "$tag")
    docker cp "$container:/app/src-tauri/target/release/bundle/." "$out/"
    docker rm "$container" > /dev/null
}

build_for_platform "linux/amd64" "x64"
build_for_platform "linux/arm64" "arm64"

echo ""
echo "Done! Artifacts:"
ls -lhR "${ROOT}/releases/linux/"
