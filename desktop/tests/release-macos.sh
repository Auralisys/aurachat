#!/bin/bash
# Portable orchestration test: all Apple/build/GitHub operations are mocked.
set -euo pipefail
script="$(cd "$(dirname "$0")/../scripts" && pwd)/release-macos.command"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/aurachat-mac-test.XXXXXX")"
export FIXTURE="$fixture" REAL_NODE="$(command -v node)"
mkdir -p "$fixture/bin" "$fixture/repo/desktop/scripts" "$fixture/repo/desktop/src-tauri" \
  "$fixture/template/desktop/scripts" "$fixture/template/desktop/src-tauri" \
  "$fixture/home/Desktop" "$fixture/tmp" "$fixture/import"
cp "$script" "$fixture/repo/desktop/scripts/"
printf '{"version":"0.1.1","plugins":{"updater":{"pubkey":"test-public-key"}}}\n' \
  > "$fixture/repo/desktop/src-tauri/tauri.conf.json"
cp "$fixture/repo/desktop/src-tauri/tauri.conf.json" "$fixture/template/desktop/src-tauri/"
printf 'test-private-key-not-a-real-secret\n' > "$fixture/import/updater.key"
printf 'test-public-key\n' > "$fixture/import/updater.key.pub"
cat > "$fixture/manifest.json" <<'JSON'
{"version":"0.1.1","platforms":{"windows-x86_64":{"signature":"test","url":"https://example.invalid/windows.exe"}}}
JSON
cat > "$fixture/template/desktop/scripts/release.cjs" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
const fixture = process.env.FIXTURE;
const key = fs.readFileSync(path.join(process.env.HOME, '.tauri/AuraChat/updater.key'), 'utf8');
assert.equal(key.trim(), 'test-private-key-not-a-real-secret');
fs.appendFileSync(path.join(fixture, 'trace'), process.argv.includes('--publish') ? 'publish\n' : 'build\n');
const output = path.resolve('desktop/src-tauri/target/release/bundle/dmg');
fs.mkdirSync(output, {recursive: true});
fs.writeFileSync(path.join(output, 'AuraChat_0.1.1_aarch64.dmg'), 'test-dmg');
NODE
cat > "$fixture/bin/node" <<'SH'
#!/bin/bash
if [[ "${1:-}" == -p && "${2:-}" == *'"darwin-"'* ]]; then
  echo darwin-aarch64
else
  if command -v cygpath >/dev/null 2>&1; then
    export FIXTURE="$(cygpath -w "$FIXTURE")" HOME="$(cygpath -w "$HOME")"
  fi
  exec "$REAL_NODE" "$@"
fi
SH
cat > "$fixture/bin/uname" <<'SH'
#!/bin/bash
echo Darwin
SH
cat > "$fixture/bin/rustc" <<'SH'
#!/bin/bash
echo 'host: aarch64-apple-darwin'
SH
cat > "$fixture/bin/cargo" <<'SH'
#!/bin/bash
echo 'tauri-cli 2.12.3'
SH
cat > "$fixture/bin/xcode-select" <<'SH'
#!/bin/bash
exit 0
SH
cp "$fixture/bin/xcode-select" "$fixture/bin/cmake"
cat > "$fixture/bin/osascript" <<'SH'
#!/bin/bash
echo "$HOME/Desktop/"
SH
cat > "$fixture/bin/git" <<'SH'
#!/bin/bash
if [[ "$1" == clone ]]; then
  cp -R "$FIXTURE/template" "${@: -1}"
  echo clone >> "$FIXTURE/trace"
elif [[ "$*" == *' checkout '* ]]; then
  echo "checkout:${@: -1}" >> "$FIXTURE/trace"
fi
exit 0
SH
cat > "$fixture/bin/gh" <<'SH'
#!/bin/bash
set -eu
case "$1 $2" in
  'auth status') exit 0 ;;
  'api repos/Auralisys/aurachat')
    echo true ;;
  'api repos/Auralisys/aurachat/commits/v0.1.1')
    printf '%040d\n' 1 ;;
  'release view')
    if [[ "$*" == *isDraft* ]]; then echo false; else echo ''; fi ;;
  'release download')
    destination=''
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == --dir ]]; then destination="$2"; break; fi
      shift
    done
    cp "$FIXTURE/manifest.json" "$destination/latest.json" ;;
  'release upload') echo upload-dmg >> "$FIXTURE/trace" ;;
  *) echo "Unexpected gh command: $*" >&2; exit 1 ;;
esac
SH
chmod +x "$fixture/bin/"*
export HOME="$fixture/home" TMPDIR="$fixture/tmp" PATH="$fixture/bin:$PATH"
export GH_TOKEN=wrong-session GITHUB_TOKEN=wrong-session
printf '%s\n' "$fixture/import/updater.key" | /bin/bash "$fixture/repo/desktop/scripts/release-macos.command"
printf 'clone\ncheckout:%040d\nbuild\nupload-dmg\npublish\n' 1 > "$fixture/expected"
cmp "$fixture/expected" "$fixture/trace"
[[ "$(cat "$HOME/Desktop/AuraChat_0.1.1_aarch64.dmg")" == test-dmg ]]
[[ "$(cat "$HOME/.tauri/AuraChat/updater.key.pub")" == test-public-key ]]
cat > "$fixture/manifest.json" <<'JSON'
{"version":"0.1.1","platforms":{"windows-x86_64":{},"darwin-aarch64":{}}}
JSON
/bin/bash "$fixture/repo/desktop/scripts/release-macos.command"
cmp "$fixture/expected" "$fixture/trace"
cat > "$fixture/manifest.json" <<'JSON'
{"version":"0.1.1","platforms":{"windows-x86_64":{}}}
JSON
export HOME="$fixture/other-home"
mkdir -p "$HOME"
printf 'wrong-public-key\n' > "$fixture/import/updater.key.pub"
if printf '%s\n' "$fixture/import/updater.key" | /bin/bash "$fixture/repo/desktop/scripts/release-macos.command" \
    > "$fixture/wrong-key.log" 2>&1; then
  echo 'Expected mismatched signing key to stop publication.' >&2
  exit 1
fi
grep -q 'Chiave pubblica diversa' "$fixture/wrong-key.log"
[[ "$(grep -c '^publish$' "$fixture/trace")" == 1 ]]
printf 'PASS: Mac key import, pinned-source clone, build/upload/publish order, Desktop copy and repeat-run safety.\n'
printf 'Mock fixtures: %s\n' "$fixture"
