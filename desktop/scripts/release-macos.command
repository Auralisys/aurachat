#!/bin/bash
# Run after pulling: bash desktop/scripts/release-macos.command
set -euo pipefail

fail() { printf '\nERRORE: %s\n' "$*" >&2; exit 1; }
confirm() {
  local answer
  read -r -p "$1 [s/N] " answer
  case "$answer" in s|S|y|Y) return 0 ;; *) fail "Operazione annullata. Nessuna pubblicazione eseguita." ;; esac
}
[[ "$(uname -s)" == Darwin ]] || fail "Questo script va eseguito sul Mac."
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"
root="$(cd "$(dirname "$0")/../.." && pwd)"
repo="Auralisys/aurachat"

if ! xcode-select -p >/dev/null 2>&1; then
  confirm "Servono gli strumenti Apple. Aprire l'installazione dei Command Line Tools?"
  xcode-select --install
  fail "Completa l'installazione Apple, poi rilancia questo stesso script."
fi

ensure_brew() {
  if ! command -v brew >/dev/null 2>&1; then
    confirm "Installare Homebrew dal progetto ufficiale per preparare gli strumenti di build?"
    local installer
    installer="$(mktemp "${TMPDIR:-/tmp}/aurachat-homebrew.XXXXXX")"
    curl --fail --show-error --location --proto '=https' \
      https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$installer"
    /bin/bash "$installer"
    rm -f "$installer"
    command -v brew >/dev/null 2>&1 || fail "Homebrew non disponibile. Controlla l'installazione e rilancia."
  fi
}
for tool in node gh cargo cmake; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    ensure_brew
    formula="$tool"
    [[ "$tool" != cargo ]] || formula=rust
    confirm "Installare $formula con Homebrew?"
    brew install "$formula"
  fi
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) process.exit(1)' \
  || fail "Serve Node.js 18 o successivo. Aggiornalo e rilancia."
if ! cargo tauri --version >/dev/null 2>&1; then
  confirm "Installare Tauri CLI 2.12.3 tramite Cargo?"
  cargo install tauri-cli --version 2.12.3 --locked
fi
cargo tauri --version | grep -Eq '^tauri-cli 2\.' || fail "Serve Tauri CLI versione 2."

# A Copilot session token must not override the account authorized by the user.
unset GH_TOKEN GITHUB_TOKEN
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  printf '\nAutorizza GitHub nel browser con un account che puo pubblicare nel repository.\n'
  gh auth login --hostname github.com --git-protocol https --web
fi
[[ "$(gh api "repos/$repo" --jq '.permissions.push')" == true ]] \
  || fail "L'account GitHub attivo non puo pubblicare in $repo. Usa gh auth switch o gh auth login."

version="$(node -p 'require(process.argv[1]).version' "$root/desktop/src-tauri/tauri.conf.json")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Versione non valida."
tag="v$version"
[[ "$(gh release view "$tag" --repo "$repo" --json isDraft --jq .isDraft)" == false ]] \
  || fail "Pubblica prima la release Windows $tag."
source_commit="$(gh api "repos/$repo/commits/$tag" --jq .sha)"
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || fail "Commit della release non valido."

work="$(mktemp -d "${TMPDIR:-/tmp}/aurachat-release.XXXXXX")"
printf '\nCartella di lavoro (conservata anche in caso di errore): %s\n' "$work"
gh release download "$tag" --repo "$repo" --pattern latest.json --dir "$work"
target="$(node -p '"darwin-" + ({arm64:"aarch64",x64:"x86_64"}[process.arch] || "unsupported")')"
[[ "$target" != darwin-unsupported ]] || fail "Architettura Mac non supportata."
rust_host="$(rustc -vV | sed -n 's/^host: //p')"
[[ "$rust_host" == "${target#darwin-}-apple-darwin" ]] \
  || fail "Node e Rust usano architetture diverse. Usa entrambi nativi oppure entrambi Intel/Rosetta."
node - "$work/latest.json" "$version" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (manifest.version !== process.argv[3] || !manifest.platforms?.['windows-x86_64']) {
  throw new Error('La release deve contenere prima il manifest e il pacchetto Windows della stessa versione.');
}
NODE
if node - "$work/latest.json" "$target" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.exit(manifest.platforms[process.argv[3]] ? 0 : 1);
NODE
then
  printf '\n%s e gia pubblicato per %s. Nessun binario sostituito.\n' "$tag" "$target"
  exit 0
fi

# Build the immutable Windows release commit, not newer/uncommitted files after pull.
if ! git -C "$root" cat-file -e "$source_commit^{commit}" 2>/dev/null; then
  git -C "$root" fetch --no-tags origin "refs/tags/$tag"
fi
git clone --quiet --no-hardlinks --no-checkout "$root" "$work/source"
git -C "$work/source" checkout --quiet --detach "$source_commit"
source="$work/source"
[[ "$(node -p 'require(process.argv[1]).version' "$source/desktop/src-tauri/tauri.conf.json")" == "$version" ]] \
  || fail "La versione del tag non coincide con quella richiesta."

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  key="$HOME/.tauri/AuraChat/updater.key"
  if [[ ! -f "$key" ]]; then
    printf '\nPrima configurazione: trasferisci in modo sicuro updater.key e updater.key.pub da Windows.\n'
    printf 'Non inserirle nel repository, in una release o nella chat.\n'
    read -r -p "Percorso completo della chiave privata gia trasferita sul Mac: " import_key
    [[ -f "$import_key" && -f "$import_key.pub" ]] \
      || fail "Servono entrambi i file updater.key e updater.key.pub."
    expected="$(node -p 'require(process.argv[1]).plugins.updater.pubkey' "$source/desktop/src-tauri/tauri.conf.json")"
    [[ "$(cat "$import_key.pub")" == "$expected" ]] || fail "Chiave pubblica diversa da quella dell'app."
    mkdir -p "$(dirname "$key")"
    chmod 700 "$(dirname "$key")"
    install -m 600 "$import_key" "$key"
    install -m 600 "$import_key.pub" "$key.pub"
  fi
fi

cd "$source"
node desktop/scripts/release.cjs

dmg_dir="$source/desktop/src-tauri/target/release/bundle/dmg"
shopt -s nullglob
dmgs=("$dmg_dir"/AuraChat_*.dmg)
[[ "${#dmgs[@]}" == 1 ]] || fail "Atteso un solo DMG prodotto dalla build."
dmg_name="$(basename "${dmgs[0]}")"
existing_dmg="$(gh release view "$tag" --repo "$repo" --json assets --jq ".assets[] | select(.name == \"$dmg_name\") | .name")"
if [[ -n "$existing_dmg" ]]; then
  mkdir "$work/previous-dmg"
  gh release download "$tag" --repo "$repo" --pattern "$dmg_name" --dir "$work/previous-dmg"
  cmp -s "${dmgs[0]}" "$work/previous-dmg/$dmg_name" \
    || fail "Esiste gia un DMG diverso: non viene sovrascritto. Controlla la release prima di continuare."
else
  gh release upload "$tag" "${dmgs[0]}" --repo "$repo"
fi
# Upload latest.json last, merging the existing Windows platform.
node desktop/scripts/release.cjs --skip-build --publish
desktop_dir="$(osascript -e 'POSIX path of (path to desktop folder)')"
cp -f "${dmgs[0]}" "$desktop_dir"
cmp -s "${dmgs[0]}" "${desktop_dir%/}/$(basename "${dmgs[0]}")" \
  || fail "La copia del DMG sul Desktop non coincide con la build."
printf '\nRelease Mac pubblicata: https://github.com/%s/releases/tag/%s\n' "$repo" "$tag"
printf 'Installer sul Desktop: %s\n' "$(basename "${dmgs[0]}")"
printf "Installa questa prima versione sul Mac se non dispone ancora dell'updater.\n"
