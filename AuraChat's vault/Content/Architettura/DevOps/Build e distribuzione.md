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

### Installazione locale Windows — 12 novembre 2026

Build **0.1.6** con il fumetto immediato e la preparazione asincrona dell'invio
installata in `%LOCALAPPDATA%\AuraChat\aurachat.exe`. App riaperta e processo
rispondente; `DirectML.dll` presente. Nessun incremento di versione o upload
di una release: l'aggiornamento riguarda solo questo computer.

La ricevuta `desktop/src-tauri/target/release/updater/build-receipt.json` e stata
validata contro sorgenti, installer e firma con
`node desktop\scripts\release.cjs --skip-build`, senza ricompilare o pubblicare.
Fingerprint dei sorgenti desktop:
`683d9faffb04a097b9ee9a73d09fc506de7f7d7e9f20d205a4630a76004ad701`.

SHA-256 verificati dopo l'installazione:
- Installer `AuraChat_0.1.6_x64-setup.exe`:
  `a8ec01c97027268e416c32c5f61459cbe74d6bf3f218a1e5c9474262486ec31a`.
- Eseguibile installato, senza normalizzazione:
  `8aedb6278ded9cfb1baf2d5e624528080665b6814e7c199c7c3864709ac02544`.
- Build ed eseguibile installato, normalizzando il marcatore Tauri come nello
  script: entrambi
  `d5c2140cd043c3322cf511992898621362fe1475b22eeef09376f230c0ba396d`.

La sola data del file o il numero 0.1.6 non identificano questa build: il
confronto normalizzato conferma che l'app installata contiene il nuovo binario.
Le regressioni `background-chats.cjs` e `history-save.cjs` sono passate con
servizi nativi simulati; nessun invio reale al provider dalla Prod durante
questa verifica. Dettagli del comportamento in [[Desktop gateway - Tauri]].

### Installazione locale Windows — cronologia riusata, 12 novembre 2026

Seconda build **0.1.6** dello stesso giorno, con il rendering incrementale della
cronologia all'invio, installata con `install-prod.ps1 -SkipBuild` dopo aver
controllato che l'app non avesse turni in corso. App riaperta e chat lunga
riaperta senza errori; l'agente non ha inviato messaggi, l'utente ha poi provato
un invio reale con esito positivo. Nessun incremento di versione o upload.

Se `ORT_LIB_PATH` punta a un `onnxruntime.dll` esterno (lo eredita per esempio un
processo avviato dall'app GitHub Copilot), `ort-sys` fallisce il link: va rimossa
dall'ambiente della build.

Ricevuta validata con `node desktop\scripts\release.cjs --skip-build`.
Fingerprint dei sorgenti desktop:
`97864356567b41c811b5244e1f906cc238290d016bd7baf5a869408da62fec83`.

SHA-256 verificati dopo l'installazione:
- Installer `AuraChat_0.1.6_x64-setup.exe`:
  `0e1f5cf78ea08ecd4d1139144a7ac53637be9a97d74d3f18a230744929144083`.
- Eseguibile installato, senza normalizzazione:
  `2c61a77cb1702f2c6627dac5fca4c7dd0093a03ac003b32f69f8c95e6b74cbed`.

## Limiti

La firma dell'updater non sostituisce la firma del sistema operativo: su Windows
puo comparire SmartScreen ("Ulteriori informazioni →
Esegui comunque"), su macOS serve tasto destro → Apri al primo avvio. Firma
Authenticode, Developer ID e notarizzazione Apple non sono configurate.
Versionamento e pubblicazione seguono `desktop/RELEASING.md`; una reinstallazione
locale non incrementa la versione e non distribuisce un aggiornamento agli
altri dispositivi. Vedi [[Problemi noti]].
