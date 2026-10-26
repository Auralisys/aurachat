#!/usr/bin/env bash
# Builds AuraChat.app release, installs it in /Applications and relaunches it.
# Usage: desktop/scripts/install-prod.sh [--no-launch] [--skip-build]
set -euo pipefail
launch=1; build=1
for arg in "$@"; do
  case "$arg" in
    --no-launch) launch=0 ;;
    --skip-build) build=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
desktop="$(cd "$(dirname "$0")/.." && pwd)"
app="$desktop/src-tauri/target/release/bundle/macos/AuraChat.app"
target=/Applications/AuraChat.app

if [ "$build" = 1 ]; then
  node "$desktop/scripts/release.cjs"
fi
[ -d "$app" ] || { echo "AuraChat.app not found: run without --skip-build." >&2; exit 1; }

if pgrep -f "$target/Contents/MacOS/" >/dev/null; then
  osascript -e 'tell application id "dev.aurachat.desktop" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do pgrep -f "$target/Contents/MacOS/" >/dev/null || break; sleep 0.5; done
  pkill -f "$target/Contents/MacOS/" 2>/dev/null || true
fi

rm -rf "$target"
ditto "$app" "$target"
echo "Installed $target"
[ "$launch" = 1 ] && open "$target" && echo "AuraChat relaunched."
exit 0
