# Runbook: release e aggiornamenti desktop

Seguire questo runbook ogni volta che viene chiesto di preparare o pubblicare una
nuova versione. Il monorepo contiene anche `mobile/`: questo flusso riguarda solo
`desktop/`, non modifica la versione Flutter e non pubblica APK o IPA.

## Stato e prerequisiti

- Versione iniziale con updater: **0.1.1**.
- Compilazione locale Windows sul PC Windows; compilazione locale macOS sul Mac.
  Nessuna GitHub Action e nessun servizio di compilazione a pagamento.
- Rust, Cargo, Tauri CLI 2 e Node.js 18+ sul computer di compilazione; Xcode e
  Command Line Tools sul Mac. Per pubblicare serve anche GitHub CLI.
- La destinazione e `Auralisys/aurachat`, configurata in
  `src-tauri/tauri.conf.json`; lo script ricava da li il repository.
- La visibilita del repository non viene mai modificata dagli script.
- Il repository e stato reso pubblico dall'utente. L'app scarica senza login
  GitHub e non necessita di Git, GitHub Desktop o `gh` sui computer destinatari.
  Renderlo nuovamente privato interromperebbe gli aggiornamenti anonimi.
- Per pubblicare, lo script prova credenziali CLI e Git gia disponibili senza
  aprire prompt o salvare token nei sorgenti. L'account CLI/Git disponibile
  iniziale aveva `push: false`. L'utente ha poi autorizzato `Auralisys`, che ha
  accesso in scrittura. Un `GH_TOKEN` di Copilot puo dare precedenza al vecchio
  account: il publisher prova anche il login `gh` salvato senza tale override.

## Flusso concordato: Windows prima, poi pull e uno script sul Mac

### Ogni nuova versione su Windows

L'agente prepara versione, modifiche e build firmata, segue i controlli sotto e
fa commit. **Il push dei sorgenti resta all'utente con GitHub Desktop**.
Dopo il push, l'agente pubblica Windows oppure l'utente esegue dalla root:

```powershell
powershell -ExecutionPolicy Bypass -File desktop\scripts\publish-windows.ps1
```

Lo script usa il login GitHub autorizzato, ricompila e firma, pubblica installer,
firma e `latest.json`, e copia l'installer sul Desktop. Non fa commit/push e non
incrementa la versione: questi passaggi devono essere gia completati.
La release e il tag vengono fissati al commit pubblicato. Non eseguire nuovamente
per sostituire un installer della stessa versione: incrementare prima la versione.

### Ogni nuova versione sul Mac

Dopo la conferma che Windows e stato pubblicato, fare **pull** in GitHub Desktop.
Dalla root del repository eseguire un solo comando:

```bash
bash desktop/scripts/release-macos.command
```

Lo script:

1. Controlla strumenti Apple, Node, Rust/Cargo, CMake, Tauri e GitHub CLI.
   Propone esplicitamente le installazioni mancanti: non esegue installazioni
   nascoste. L'installazione Apple puo richiedere di rilanciare lo script.
2. Usa il login `gh` salvato (senza token di sessione Copilot), oppure guida
   all'autorizzazione nel browser; verifica i permessi sul repository.
3. Legge la versione dal checkout dopo il pull e richiede che esista gia la
   corrispondente release Windows pubblica con manifest.
4. Risolve il commit del tag remoto e lo compila in un clone locale temporaneo,
   senza cambiare branch, modificare file, fare stash o aggiornare il checkout
   dell'utente. Anche se il pull include script/documenti successivi alla release,
   il codice compilato rimane esattamente quello pubblicato per Windows.
5. Verifica la chiave locale; al primo uso permette di importare i file gia
   trasferiti in modo sicuro. Non genera una nuova identita di firma.
6. Costruisce app, archivio updater firmato e DMG per l'architettura del Mac.
   Node e Rust devono avere architettura coerente; non genera automaticamente
   anche il pacchetto per l'altra architettura.
7. Carica il DMG, poi pubblica archivio/firma e unisce la piattaforma Mac al JSON
   Windows della stessa versione. Non sovrascrive pacchetti diversi.
8. Copia il DMG sul Desktop e comunica l'esito. Un secondo avvio dopo una
   pubblicazione gia conclusa segnala che la piattaforma e gia presente.

La cartella temporanea viene stampata e conservata, anche in caso di errore, per
non perdere pacchetti/log utili al recupero. Non pubblicare contemporaneamente da
Windows e Mac. Se un upload si interrompe lasciando asset parziali, ispezionare
la release: non cancellare o sostituire automaticamente pacchetti gia distribuiti.

### Preparazione iniziale del Mac: limite non eliminabile con un pull

Un pull trasferisce i sorgenti pubblici, **non credenziali o chiavi private**.
Una sola volta occorre:

- autorizzare nel browser GitHub CLI con un account che puo pubblicare;
- accettare le installazioni degli strumenti mancanti e le eventuali richieste
  di macOS; se ci sono gia, lo script non li reinstalla;
- trasferire da Windows `%USERPROFILE%\.tauri\AuraChat\updater.key` e
  `updater.key.pub` attraverso un canale sicuro sotto il controllo dell'utente
  (per esempio un supporto personale protetto), mai nel repository pubblico,
  nelle release o nella chat. Lo script chiede il percorso locale della chiave
  trasferita e la importa in `$HOME/.tauri/AuraChat/` con permessi restrittivi.

Poi normalmente bastano **pull + script**. La prima installazione dell'app sul
Mac rimane manuale dal DMG; le successive versioni usano l'updater. La firma
ad hoc non elimina le protezioni Gatekeeper: l'agente non le aggira.
Non dichiarare il primo Mac operativo prima di una build/installazione reale.

## Chiave di firma: preservarla

La chiave privata e **fuori dal repository**, nella home dell'utente:
`.tauri/AuraChat/updater.key`; accanto si trova `updater.key.pub`.
Su Windows la directory si risolve da `%USERPROFILE%`, sul Mac da `$HOME`.
La chiave pubblica e incorporata in `tauri.conf.json`.

Non stampare, committare, allegare alle release o rigenerare la chiave privata.
Farne un backup sicuro. Per compilare sul Mac occorre trasferire **la stessa
chiave** con un canale sicuro, oppure usare `TAURI_SIGNING_PRIVATE_KEY` e
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` nell'ambiente. Nessuno script copia
automaticamente il segreto sul cloud. Perdere la chiave interrompe la catena
di aggiornamento delle installazioni esistenti.

La firma Tauri e gratuita ma non sostituisce Authenticode/SmartScreen su Windows
o Developer ID/notarizzazione su macOS. La configurazione Mac usa firma ad hoc:
Gatekeeper e l'installazione/riapertura su un Mac reale vanno verificati.

## Preparare una versione

1. Leggere stato Git e modifiche dell'utente; non cambiare branch e non
   interrompere app o chat in corso. Per istruzione dell'utente, al termine
   preparare sempre un commit delle sole modifiche del lavoro completato, con
   trailer `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`.
   Il push resta manuale a cura dell'utente: non eseguirlo automaticamente.
2. Eseguire i test relativi alle modifiche e quelli dell'updater:
   `node desktop/tests/release.cjs`, `node desktop/tests/release-publish.cjs`
   e `node desktop/tests/updates.cjs`
   (quest'ultimo richiede il runtime Playwright gia usato dagli altri test UI).
   `bash desktop/tests/release-macos.sh` verifica l'orchestrazione Mac con
   strumenti simulati (importazione chiave, commit del tag, ordine degli upload,
   seconda esecuzione e rifiuto di una chiave pubblica diversa).
   Su Windows i test nativi usano `desktop/tests/run-native.ps1`.
3. Per incrementare patch e costruire localmente:

   ```powershell
   node desktop\scripts\release.cjs --bump patch
   ```

   Usare `minor` o `major` solo se richiesto dal tipo di release. Lo script
   aggiorna insieme la versione Tauri e Cargo; Cargo aggiorna il lockfile.
   Non incrementare nuovamente sul Mac: usare gli stessi sorgenti/versione.
4. I risultati sono in `desktop/src-tauri/target/release/updater/`:
   installer/archivio, firma `.sig` e **`latest.json` generato dai file reali**.
   Non scrivere firme o URL di asset inesistenti a mano nel repository.
5. Gli script `package-installer` e `install-prod` riusano la build firmata.
   `--skip-build` (script Node) o `-SkipBuild` (PowerShell) riusano gli artefatti;
   non usarli dopo modifiche ai sorgenti. Non cambiare versione a un vecchio file.

### Branding dell'installer Windows

NSIS usa esplicitamente `icons/windows/icon.ico` per installer e disinstaller,
le bitmap `assets/installer/header.bmp` e `sidebar.bmp`, editore Auralisys e
lingua di sistema italiana/inglese. Rimangono i controlli nativi Windows:
non e un installer HTML e non necessita di runtime aggiuntivi per il branding.
Le bitmap sono versionate; per rigenerarle dal logo esistente su Windows:

```powershell
powershell -ExecutionPolicy Bypass -File desktop\scripts\generate-installer-assets.ps1
```

La generazione usa System.Drawing di Windows, senza pacchetti da installare.
Una modifica al branding richiede una nuova build e firma dell'installer.

## Pubblicare, solo su richiesta esplicita

L'aggiornamento delle app installate richiede una release remota: una build locale
o un normale push da GitHub Desktop non pubblicano i pacchetti.

1. Committare/pushare i sorgenti con il flusso scelto dall'utente, inclusi versione
   e lockfile. GitHub Desktop va bene. Lo script di release non fa commit o push
   e rifiuta una pubblicazione con working tree sporco. Non combinare `--bump`
   e `--publish`: il versionamento deve essere incluso nel commit pubblicato.
2. Dopo una build verificata, dalla root:

   ```powershell
   node desktop\scripts\release.cjs --skip-build --publish
   ```

3. Lo script verifica prima l'accesso in scrittura; crea una release draft
   `v<versione>` sul commit corrente, carica installer e firma, genera il JSON
   con URL pubblici GitHub reali, pubblica e rilegge il JSON remoto per verificarlo.
   Una ricevuta locale verifica versione, sorgenti e hash degli artefatti:
   `--skip-build` rifiuta pacchetti obsoleti o modificati.
4. Sul Mac, usare lo stesso commit, versione e chiave; eseguire prima
   `node desktop/scripts/release.cjs`, poi lo stesso comando con
   `--skip-build --publish`. Il JSON viene unito a quello Windows della stessa
   release; non si devono conservare piattaforme appartenenti ad altre versioni.
5. Pubblicare le piattaforme **in sequenza**, mai contemporaneamente: il JSON
   condiviso non ha un lock distribuito. Non sostituire binari di una piattaforma
   gia pubblicata; incrementare la versione per correggerli.
6. Intel Mac e Apple Silicon richiedono pacchetti distinti; produrre ciascuno
   sulla relativa architettura con questo flusso. Una piattaforma non ancora
   caricata viene segnalata dall'updater, non sostituita con un pacchetto diverso.

Se una pubblicazione fallisce dopo il caricamento del binario, fermarsi e
ispezionare il draft/manifest: lo script rifiuta sovrascritture automatiche.
Non dichiarare riuscita una pubblicazione non verificata.

## Comportamento dell'app e verifica finale

Il controllo avviene a ogni avvio del processo, prima del login/ripristino e
dell'esecuzione delle richieste remote. Nessun aggiornamento viene avviato a meta
di una conversazione. Una nuova versione viene scaricata e installata
automaticamente con dialogo modale non chiudibile da Escape o clic esterno.
Un errore di download/firma/installazione mantiene il blocco e offre Riprova.
Windows usa NSIS `/UPDATE` e `/NS`: non ricrea collegamenti Desktop/Start menu;
il programma di installazione riavvia l'app. macOS riavvia dopo l'installazione.

Se non e possibile controllare gli aggiornamenti (offline, autenticazione,
GitHub non disponibile), l'errore resta visibile con Riprova e la possibilita
esplicita di continuare con la versione corrente per questa sessione. Non viene
mostrato falsamente "sei aggiornato".

La prima versione con updater deve essere installata una volta su ciascun
computer. Verificare poi un passaggio reale da versione precedente a successiva
su Windows e macOS: versione finale, avvio, login/dati preservati, firme rifiutate
se alterate, nessun nuovo collegamento. Test UI con backend simulato e build
locale non sostituiscono questa prova di distribuzione.

### Verifica iniziale della 0.1.1

Build Windows NSIS firmata prodotta, JSON generato e ricevuta di build verificata;
test dedicati del manifest e del dialogo IT/EN completati, incluso errore di
firma simulato, Riprova, blocco Escape e ripristino offline. Test nativo del
gate di avvio completato. Controllato il template NSIS effettivamente generato:
`/UPDATE` e `/NS` saltano la creazione dei collegamenti.

I test UI legacy `ui-smoke.cjs` e `chat-progress.cjs` non risultano verdi:
i mock non gestiscono `refresh_data`; lo smoke contiene anche aspettative sul
vecchio input del compositore. Questi test non sono stati modificati come parte
dell'updater. Non considerare questa verifica una suite completa verde.

La release Windows **v0.1.1**, commit
`b6144cd9ff3887f6d46bb1081609b077887bdcd2`, e stata pubblicata su GitHub con
installer, firma e `latest.json`. L'endpoint anonimo non richiede login.
Durante la prima pubblicazione sono emersi consistenza ritardata del draft e
URL temporanei `untagged-...`: il publisher ora attende il draft e genera URL
canonici del tag, non quelli temporanei. Il draft iniziale e stato completato
senza sostituire binari gia pubblicati.

Restano da eseguire sul Mac la preparazione iniziale, build, pubblicazione e il
ciclo reale di installazione/aggiornamento: nessun host macOS e disponibile
in questa sessione Windows. I controlli statici non sostituiscono tale prova.

## Controlli sulla pubblicazione del repository

L'utente ha reso pubblico il repository durante l'implementazione; questa
visibilita e stata verificata tramite API. Il vault Obsidian e tracciato come
parte del monorepo. Sono presenti
riferimenti personali nella cronologia; quelli identificati nei documenti
attuali sono stati sostituiti con riferimenti relativi/generici. Questo non li
rimuove dai vecchi commit. Il `.pyc` locale prima tracciato e stato rimosso dalla
copia corrente e ignorato, ma rimane nella storia.

Le icone in `desktop/ui/assets/icons/provenance.json` dichiarano estrazione da
un'applicazione di terzi: verificare diritti e licenze prima di ridistribuirle
pubblicamente. Le configurazioni Firebase client sono identificativi pubblici,
non credenziali amministrative, ma vanno comunque verificate regole e restrizioni
del progetto. Non e stata eseguita una certificazione completa dell'intera storia
Git, dei binari o delle immagini.

Nessuna cronologia Git e stata riscritta e nessuna credenziale e stata ruotata.
Se si vogliono rimuovere anche i vecchi riferimenti, pianificare separatamente
la riscrittura della storia e il coordinamento di tutti i cloni, con
autorizzazione esplicita prima di qualsiasi force push.
