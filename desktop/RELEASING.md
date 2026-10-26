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
  durante l'implementazione ha `push: false`: il repository e leggibile, ma
  nessuna release remota puo essere pubblicata con tale account.

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
   `node desktop/tests/release.cjs` e `node desktop/tests/updates.cjs`
   (quest'ultimo richiede il runtime Playwright gia usato dagli altri test UI).
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

Restano bloccati la pubblicazione remota (account disponibile con `push: false`)
e il ciclo reale di aggiornamento/installazione su Mac (nessun host macOS
disponibile da questa sessione). L'endpoint pubblico del manifest risponde 404
finche non viene pubblicata la prima release con `latest.json`.

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
