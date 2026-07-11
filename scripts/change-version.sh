#!/usr/bin/env bash
# Script to update the version of Termifai in all configuration files.
# Usage: ./scripts/change-version.sh <new-version>

set -euo pipefail

NEW_VERSION="${1:-}"

if [ -z "$NEW_VERSION" ]; then
  echo "Usage: $0 <new-version>"
  exit 1
fi

# Semver validation
if [[ ! "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$NEW_VERSION' is not a valid semver version (e.g. 1.0.0 or 1.2.3-beta.1)"
  exit 1
fi

echo "Updating project version to $NEW_VERSION..."

# Update JSON files
perl -pi -e 's/"version":\s*"[^"]*"/"version": "'"$NEW_VERSION"'"/g' package.json src-tauri/tauri.conf.json
echo "Updated package.json and src-tauri/tauri.conf.json"

# Update AppShell.tsx UI version representation
perl -pi -e 's/v\d+(\.\d+)*(-[a-zA-Z0-9.]+)?/v'"$NEW_VERSION"'/g' src/components/app/AppShell.tsx
echo "Updated AppShell.tsx UI version"

# Update finder-extension Info.plist
perl -0777 -pi -e 's/(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/${1}'"$NEW_VERSION"'${2}/g' src-tauri/finder-extension/Info.plist
perl -0777 -pi -e 's/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/${1}'"$NEW_VERSION"'${2}/g' src-tauri/finder-extension/Info.plist
echo "Updated src-tauri/finder-extension/Info.plist"

# Update Cargo.toml files (using perl's multiline mode to update version under [package] only)
perl -0777 -pi -e 's/(\[package\].*?\bversion\s*=\s*")[^"]+(")/${1}'"$NEW_VERSION"'${2}/s' src-tauri/Cargo.toml
perl -0777 -pi -e 's/(\[package\].*?\bversion\s*=\s*")[^"]+(")/${1}'"$NEW_VERSION"'${2}/s' src-tauri/crates/termifai-core/Cargo.toml
perl -0777 -pi -e 's/(\[package\].*?\bversion\s*=\s*")[^"]+(")/${1}'"$NEW_VERSION"'${2}/s' src-tauri/crates/termifaid/Cargo.toml
echo "Updated Cargo.toml files"

echo "Version update complete!"
