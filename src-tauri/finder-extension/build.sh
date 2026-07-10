#!/bin/bash
# Builds TermifaiFinder.appex (FinderSync extension) without Xcode, using swiftc.
# Output: src-tauri/finder-extension/build/TermifaiFinder.appex
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$DIR/build"
APPEX="$BUILD_DIR/TermifaiFinder.appex"
ARCH="${TERMIFAI_FINDER_ARCH:-$(uname -m)}"

rm -rf "$APPEX"
mkdir -p "$APPEX/Contents/MacOS"

swiftc -O \
    -parse-as-library \
    -application-extension \
    -module-name TermifaiFinder \
    -target "$ARCH-apple-macos11.0" \
    -framework Cocoa \
    -framework FinderSync \
    -Xlinker -e -Xlinker _NSExtensionMain \
    -o "$APPEX/Contents/MacOS/TermifaiFinder" \
    "$DIR/FinderSync.swift"

cp "$DIR/Info.plist" "$APPEX/Contents/Info.plist"

mkdir -p "$APPEX/Contents/Resources"
cp "$DIR/../icons/128x128.png" "$APPEX/Contents/Resources/MenuIcon.png"

codesign --force --sign - \
    --entitlements "$DIR/TermifaiFinder.entitlements" \
    --options runtime \
    "$APPEX"

echo "Built: $APPEX"
