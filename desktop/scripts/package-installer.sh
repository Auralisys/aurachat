#!/usr/bin/env bash
# Builds the distributable AuraChat macOS DMG and copies it to the user's Desktop.
# Usage: desktop/scripts/package-installer.sh [--skip-build]
set -euo pipefail
build=1
for arg in "$@"; do
  case "$arg" in
    --skip-build) build=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
desktop="$(cd "$(dirname "$0")/.." && pwd)"
bundle="$desktop/src-tauri/target/release/bundle/dmg"

if [ "$build" = 1 ]; then
  (cd "$desktop" && npm exec --yes --package @tauri-apps/cli@2 -- tauri build --bundles dmg)
fi
dmg="$(ls -t "$bundle"/AuraChat_*.dmg 2>/dev/null | head -n 1 || true)"
[ -n "$dmg" ] || { echo "DMG not found: run without --skip-build." >&2; exit 1; }

# Ask Finder for the real Desktop folder; fall back to ~/Desktop.
target_dir="$(osascript -e 'POSIX path of (path to desktop folder)' 2>/dev/null || echo "$HOME/Desktop/")"
target="${target_dir%/}/$(basename "$dmg")"
cp -f "$dmg" "$target"
cmp -s "$dmg" "$target" || { echo "Copied DMG does not match the build." >&2; exit 1; }
echo "Installer ready: $target ($(du -h "$target" | cut -f1))"
