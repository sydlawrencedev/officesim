#!/usr/bin/env bash
# Builds OfficeSim for Mac: the app, ad-hoc signed (no Apple Developer ID yet), and a DMG of it
# with an Applications shortcut. The DMG is made with hdiutil rather than Tauri's DMG bundler,
# which needs to script Finder to lay out its window.
#
#   scripts/release.sh            # this Mac's architecture
#   scripts/release.sh universal  # Apple silicon and Intel in one app
set -euo pipefail

cd "$(dirname "$0")/.."
target=()
if [[ "${1:-}" == "universal" ]]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  target=(--target universal-apple-darwin)
fi

# The system audio helper: a small Swift program that taps what the Mac is playing, so the DJ
# booth can react to it. A web page can't hear the system, so this does it natively.
triple="${target[1]:-}"
out="src-tauri/target/${triple:+$triple/}release"
mkdir -p "$out"
echo "Building the audio helper"
swiftc -O -o "$out/officesim-audio" src-tauri/sources/audio-capture.swift

# Tauri's build puts the app's resources in place; the helper goes beside the app's binary, where
# the app looks for it.
pnpm tauri build --bundles app ${target[@]+"${target[@]}"}

bundle="$out/bundle"
app="$bundle/macos/OfficeSim.app"
version=$(node -p 'require("./src-tauri/tauri.conf.json").version')
arch=$([[ -n "$triple" ]] && echo universal || uname -m)
dmg="$bundle/OfficeSim_${version}_${arch}.dmg"

# The helper needs to be signed with the app, and it's inside the app bundle.
cp "$out/officesim-audio" "$app/Contents/MacOS/officesim-audio"
codesign -f -s - "$app/Contents/MacOS/officesim-audio" >/dev/null
codesign -f -s - "$app" >/dev/null

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
cp -R "$app" "$staging/"
ln -s /Applications "$staging/Applications"
rm -f "$dmg"
hdiutil create -volname "OfficeSim" -srcfolder "$staging" -ov -format UDZO "$dmg" >/dev/null

echo "Built $app"
echo "Built $dmg"
