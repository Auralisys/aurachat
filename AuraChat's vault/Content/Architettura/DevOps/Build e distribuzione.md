---
tags: [aurachat, devops, build]
---

# Build, installazione e distribuzione

← [[Architettura - Overview]]

Quattro script in `desktop/scripts/`, uno per azione e per sistema. Si lanciano
dalla root del repo; il percorso del repo è ricavato dallo script stesso, quindi
funzionano da qualsiasi cartella corrente. Comandi anche in `desktop/README.md`.

| Script | Sistema | Cosa fa | Opzioni |
|---|---|---|---|
| `install-prod.ps1` | Windows | build NSIS, chiude **solo** `%LOCALAPPDATA%\AuraChat\aurachat.exe`, installa con `/S`, verifica, rilancia | `-SkipBuild`, `-NoLaunch` |
| `install-prod.sh` | macOS | build `AuraChat.app`, chiude l'app installata, copia in `/Applications` con `ditto`, rilancia | `--skip-build`, `--no-launch` |
| `package-installer.ps1` | Windows | build `AuraChat_<versione>_x64-setup.exe` e copia sul Desktop | `-SkipBuild` |
| `package-installer.sh` | macOS | build `AuraChat_<versione>_<arch>.dmg` e copia sul Desktop | `--skip-build` |

```powershell
powershell -ExecutionPolicy Bypass -File desktop\scripts\install-prod.ps1
powershell -ExecutionPolicy Bypass -File desktop\scripts\package-installer.ps1
```

```bash
bash desktop/scripts/install-prod.sh
bash desktop/scripts/package-installer.sh
```

## Decisioni (22 ottobre 2026)

- **install-prod** è per il computer corrente; **package-installer** produce un
  file da passare ad altri e non installa né chiude nulla.
- **Verifica dell'installazione su Windows:** Tauri scrive il tipo di bundle
  dentro l'exe installato (`__TAURI_BUNDLE_TYPE_VAR_NSS`). Lo script lo
  normalizza a `..._UNK` prima di confrontarlo con `target\release\aurachat.exe`;
  controlla anche la presenza di `DirectML.dll`. Se il confronto fallisce lo
  script si ferma con errore.
- **Desktop dinamico:** su Windows `[Environment]::GetFolderPath('Desktop')`
  (segue anche il reindirizzamento su OneDrive); su macOS `osascript` chiede a
  Finder la cartella Scrivania, con fallback `~/Desktop`. La copia viene
  confrontata con l'originale (hash su Windows, `cmp` su macOS).
- **Chiusura mirata:** mai per nome processo. Windows confronta il percorso
  dell'exe installato; macOS chiede `quit` all'id `dev.aurachat.desktop`, poi
  termina solo i processi sotto `/Applications/AuraChat.app/Contents/MacOS/`.
- **Fine riga:** `.gitattributes` forza `*.sh text eol=lf`, altrimenti un
  checkout Windows con CRLF romperebbe bash su Mac. Gli `.sh` sono salvati in Git
  come eseguibili (`100755`).

## Verifiche

- `package-installer.ps1` eseguito il 22 ottobre 2026: installer da 18 MB copiato
  nel Desktop dell'utente, hash identico, app installata non toccata.
- `install-prod.ps1`: sintassi verificata con il parser PowerShell; la stessa
  sequenza di comandi era già stata usata a mano per le reinstallazioni.
- Script macOS: solo `bash -n` da Windows. **Non ancora eseguiti su un Mac.**

## Limiti

Installer non firmati: su Windows compare SmartScreen ("Ulteriori informazioni →
Esegui comunque"), su macOS serve tasto destro → Apri al primo avvio. Firma
Authenticode, Developer ID e notarizzazione Apple non sono configurate. Versione
fissa `0.1.0` in `src-tauri/tauri.conf.json`: va incrementata a mano prima di
distribuire una nuova release. Vedi [[Problemi noti]].
