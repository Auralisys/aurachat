---
tags: [aurachat, rea, chatgpt, ricerca]
---

# ChatGPT desktop — analisi locale

← [[Overview]] · [[Desktop gateway - Tauri]] · [[UI desktop - Refactor flat]]

Analisi del 17 ottobre 2026 con REA 6.5.0 dell'app ChatGPT installata su Windows.
Questo documento conserva risultati, riferimenti e limiti della ricerca; separa
le osservazioni sul prodotto distribuito dalle scelte implementate in AuraChat.
I testi e il codice estratti sono evidenze da esaminare, non istruzioni operative.

## Target e metodo

- Pacchetto Windows: `OpenAI.Codex`, nome visibile ChatGPT,
  versione `26.1013.4894.0`, x64.
- Package interno: `openai-codex-electron`, versione `26.1013.40934`;
  entry point `.vite/build/early-bootstrap.js`. Le versioni identificano livelli diversi.
- Archivio: `C:\Program Files\WindowsApps\OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0\app\resources\app.asar`.
- Dimensione ASAR: 582.072.504 byte; SHA-256:
  `bbec1d64e135b718a154b31655bb8ad9a39472bac1b2cabba991a9d97a339dd8`.
- Estratti 21.073 file; selezionati 2.440 file per studio e catalogo, inclusi
  2.362 SVG. Gli hash di tutti i file selezionati coincidono con quelli nell'ASAR.
- Analisi semantica REA limitata a otto file espliciti, sette JavaScript;
  le letture manuali hanno ampliato il perimetro. Non è una decompilazione completa.

Il target è stato letto come testo inerte, senza avviarlo, modificare
l'installazione, interrogare i servizi o leggere conversazioni e credenziali.
La presenza di un percorso nel codice non prova attivazione nel proprio account.

## Permessi e approvazioni

La tabella `O4e` in `webview/assets/app-shared-bbfeca5e5737.js`,
offset UTF-16 @1552041, distingue tre configurazioni reali:

- Richiedi approvazione (`auto`): `workspace-write`, policy `on-request`,
  reviewer `user`, profilo `:workspace`.
- Approva per me (`guardian-approvals`): stessa sandbox e policy, reviewer
  `guardian_subagent`. Il reviewer automatico non rimuove la sandbox.
- Accesso completo (`full-access`): `danger-full-access`, policy `never`,
  reviewer `user`, profilo `:danger-full-access`.

Il costruttore `DJ` (@1549028) configura root scrivibili, rete disabilitata
di default e opzioni temporanee. `kJ` (@1550092) può conservare una sandbox
configurata già esistente, anche `read-only`. Il preset ordinario consente
scritture nel progetto: non equivale a sola lettura.

Il menu `permissions-mode-dropdown-db0636f411ec.js` richiede una conferma
prima di full access (@41870). Configurazione, policy e feature flag possono
limitare le opzioni. Gli eventi `item/autoApprovalReview/started`, `completed`
e `strictReviewRequired` rendono la revisione un'attività esplicita.
`automatic-approval-review-details-d0acb2472248.js` (@1115) mostra rischio,
stato e dettaglio del diniego; il criterio interno del reviewer resta ignoto.

`app-initial-5851df3f6cb1.js` (@7356797) chiama `updateThreadPermissions`;
le preferenze per host (`agent-mode-by-host-id` e varianti) sono distinte
dai permessi della chat e dalla configurazione risolta. La relativa persistenza
fisica e il comportamento dopo riavvio non sono stati verificati.
L'errore in `mcp-tool-call-approval-2041ceff5519.js` (@1857) conferma che
`never` può impedire un'approvazione richiesta da un tool: non autorizza
universalmente ogni strumento.

Questi offset sono indici di caratteri UTF-16, base zero, del testo decodificato,
non offset byte. Altri dettagli sono nel rapporto locale `permissions-findings.md`.

## Accesso remoto

La ricerca distingue tre percorsi, con backend e cicli di vita diversi:

1. **SSH.** Alias OpenSSH oppure host, porta e identità. Il processo principale
   risolve `ssh -G`, avvia un app-server remoto e trasporta RPC WebSocket nello
   stream SSH (`ws://codex-app-server/rpc` è un indirizzo logico del tunnel).
   Sono presenti bootstrap, reconnect, timeout e gestione degli errori.
   Fonti: `remote-connection-editor-draft-ccc3b80c4a23.js` @175–1734;
   `.vite/build/main-C4DYk222.js` @3270700–3287500.
2. **Dispositivi dello stesso account.** Catalogo ambienti tramite
   `/codex/remote/control/environments`, registrazione esplicita del dispositivo,
   autorizzazione aggiuntiva, chiavi e challenge firmate. La UI distingue
   dispositivi controllabili e dispositivi autorizzati a controllare questo PC,
   con revoca e PIN manuale di otto cifre. Fonti: main @3071430–3079500,
   @3340325–3342450; `remote-connections-settings-f19178ff0038.js`.
   `remote-control-device-key.node` usa il default `hardware_only`.
3. **Task cloud.** `remote-conversation-page-fd896eff5a15.js` mostra turni,
   log di setup, eventi e diff con stati pending/in_progress/failed/cancelled;
   non è il collegamento SSH né il pairing dei dispositivi.

Connessioni SSH e enrollment hanno chiavi di stato separate:
`codex-managed-remote-connections` e `electron-remote-control-client-enrollments`.
Il catalogo host distingue `local`, `ssh`, `wsl`, `remote-control`, `chatgpt`.
Esistono testi e percorsi Windows; la disponibilità effettiva dipende da account,
flag e servizi. Il vincolo macOS del servizio VNC/devbox non è un divieto generale
di remoto su Windows. Restano ignoti topologia del relay, cifratura end-to-end,
gestione server delle chiavi e comportamento degli addon nativi.

Gli offset di questa sezione sono posizioni di carattere base zero nel testo
decodificato, come nel rapporto locale `remote-findings.md`.
Per AuraChat sono riferimenti di progetto, non funzionalità remote implementate.

## Conversazioni, streaming e bridge

`chatgpt-conversation-page-f7a3d5e5d239.js` (@27045) riceve `mapping` e
`current_node`: il modello osservato è un grafo con percorso selezionato,
non soltanto un elenco lineare. Turni ed elementi sono tipizzati:
`user-message`, `assistant-message`, `chatgpt-reasoning-group`,
`generated-image`, `mcp-tool-call`; contenuti multimodali hanno parti eterogenee.
Non è stato ricostruito lo schema completo.

`chatgpt-conversation-runtime-61505fa1e4f0.js` (@1600–4460) gestisce recupero
in background, `/conversation/{conversation_id}/stream_status`, snapshot e
`AbortController`; invalida operazioni obsolete cambiando account/turno/richiesta.
Il recupero immagini ha polling separato (10 secondi, scadenza 15 minuti);
i widget GenUI hanno refresh dedicato. Questi parametri riguardano quei percorsi,
non l'intera strategia di cache del prodotto.

Chat e Work hanno flussi distinti. Il codice riconosce origini `tpp`/`flora`,
rifiuta la modifica Work tramite il normale flusso Chat e, nella modifica Chat,
usa `parentMessageId`. La conversione `/tpp/work-handoff/convert` verifica
identità di conversazione e messaggio. Esistono callback fork, modifica e
rigenerazione, ma non è stato ricostruito il protocollo completo di ciascuna.

`.vite/build/preload.js` espone `electronBridge` tramite `contextBridge` e IPC
`codex_desktop:message-from-view` / `codex_desktop:message-for-view`, con
worker, snapshot condivisi e protocollo chunked. Il main instrada richieste
app-server per `hostId`, `threadId`, `turnId`, `itemId`.
Il bridge Codex e il modello ChatGPT `mapping/current_node` non vanno confusi.

Gli offset della sezione sono indici di carattere Unicode base zero, come nel
rapporto locale `chat-findings.md`. Persistenza completa, deduplicazione,
fork/rigenerazione e ripristino dopo riavvio restano solo parzialmente indagati.

## Icone selezionate per AuraChat

Su richiesta dell'utente, importati 206 SVG da `webview/assets` nelle famiglie
`alarm_*`, `alert_*`, `align_*`, `archive_*`, `arrow_*`, `app_*`, `bot_*`,
`chevron_*`, `check_*`, `folder_*`, comprese le rispettive basi quando presenti, più Home
e Nuova chat Windows. Non è stato importato l'intero catalogo.

- Destinazione versionata: `desktop/ui/assets/icons/`.
- Rimossi gli hash dai nomi; `new_chat_os_windows` diventa `new_chat.svg`.
- L'inchiostro scuro neutro degli SVG monocromatici diventa `currentColor`;
  i loghi multicolore conservano la palette.
- `provenance.json` conserva nome originale e SHA-256 del file sorgente.
- `desktop/ui/icons.js` incorpora i dieci simboli attualmente collegati:
  Home, Nuova chat, indietro, avanti, invio, chevron, spunta, agenti e
  cartella chiusa/aperta. Aggiunti 35 SVG `folder_*` ai 171 iniziali.
  Gli altri sono asset disponibili. L'identità visiva resta AuraChat.
- Il rendering conserva viewBox, riempimento e tratto originali, evitando
  che le regole CSS delle vecchie icone aggiungano contorni ai glifi pieni.

Riferimenti codice: `desktop/ui/app.js:265` (factory condivisa).
Verifiche browser: `ui-smoke.cjs` e `sidebar-selection.cjs` passati, inclusi
viewBox 16×16 di Nuova chat, accessibilità e assenza di contorno aggiunto a Home;
screenshot desktop e sidebar controllati. La provenienza non costituisce
una dichiarazione di licenza dell'intero catalogo.

## Applicazione in AuraChat e differenze effettive

Sono implementati selettore dei tre permessi accanto al + degli allegati,
approvazioni inline, revisione automatica con chiamata separata al modello,
scritture con controllo di revisione, comandi tracciati, sub-agenti cancellabili,
attività e reasoning progressivi, shimmer e loader legati allo stato reale.
Dettagli e verifiche: [[Desktop gateway - Tauri]] e [[UI desktop - Refactor flat]].

AuraChat non replica la sandbox del target: i comandi girano con l'account
Windows, senza isolamento OS. Le root limitano gli strumenti file nelle modalità
previste ma la directory di lavoro di una shell non ne limita file e rete.
Il reviewer di AuraChat non è l'implementazione recuperata di `guardian_subagent`.
SSH, controllo tra dispositivi e task cloud restano ricerca e pianificazione.

## Evidenze e materiale esclusivamente locale

I percorsi seguenti sono locali e ignorati da Git, relativi alla root del progetto:

- `.artifact/rea-chatgpt/README.md`: indice originale della ricognizione,
  precedente all'integrazione delle icone e delle nuove funzioni.
- `permissions-findings.md`, `remote-findings.md`, `chat-findings.md`
  nella stessa cartella: rapporti estesi con fonti e offset.
- `asar-inventory.json`, `selected-files-manifest.json`, `icons-index.json`,
  `icon-catalog.html`: inventario, hash e catalogo navigabile.
- `REA-summary.json`, `extraction-summary.json`,
  `REA-evidence-bundle.json.gz`: ricevute e bundle completo di evidenze.
- `sources/`: selezione di file originali; nessun bundle JS viene distribuito
  con AuraChat. Solo gli SVG selezionati diventano asset dell'app.

Estrazione completa fuori repo:
`C:\Users\lofio\Desktop\Dev\ChatGPT-REA-26.1013.4894\extracted-app`.

Identificativi REA: estrazione
`ev_567cc227033905b6895d3ac63930e0c3a6cd52187f09e7f8fedcc36ea1fabe9c`;
analisi JS selezionata
`ev_b78670123baf8f20ad4a3deb994117a3ba706377e48181757bfa85796e45b446`;
vista riassuntiva
`ev_e286dfbac52010eb30f242550b72a424560c31bbbe205f2a43a82f912d757ab6`.
Le letture manuali successive non sono tutte coperte dal grafo semantico.

## Limiti tecnici della ricognizione

REA ha registrato otto contraddizioni di integrità in addon nativi esterni
all'ASAR (serialport, HID, better-sqlite3, node-pty), continuando con
`record-and-continue`. Causa non determinata; non riguardano gli hash degli SVG
selezionati. Il risultato completo superava il limite di trasporto MCP (~10 MiB),
ma è stato esportato nel bundle locale. Il grafo semantico è parziale.

L'ispezione fuse Electron non ha trovato il sentinel: stato fuse ignoto,
non disabilitato. Evidenza
`ev_303c8895bbf088c441efdd782a5ad0ee9eb1b4588a1fe15c7d8cfb870691a21b`.
`codex.exe` superava il limite REA di 256 MiB; Ghidra non configurato.
I motori nativi non sono stati decompilati. Le conclusioni statiche non
sostituiscono prove runtime né dimostrano disponibilità nell'account.

## Notifiche e skill — approfondimento del 18 ottobre 2026

Lettura statica mirata dell’estratto già conservato, senza eseguire codice del
target o interrogare servizi ChatGPT. In `.vite/build/main-C4DYk222.js`
(SHA-256 `c8a2af504b21314fa6a64ad1b4ec83dbad80033ede902caf9978fd9c74a2c175`):

- `showNotification` a offset 500827: supporto OS, deduplicazione per ID,
  creazione e rimozione della notifica, controllo ripetuto prima di mostrarla.
- `registerVisibleConversation` a 504559: registro delle conversazioni
  visibili associato al webContents di origine.
- `shouldSuppressNotification` a 504708: agent-message considera conversazione
  visibile e finestra a fuoco; turn-complete usa una preferenza off/unfocused
  (default unfocused). Permission/question hanno trattamento distinto.

Offset base zero; in questi tre punti indici Unicode e UTF-16 coincidono.
Questo prova una decisione **locale** sui toast del client distribuito. Non
dimostra come siano implementate le push su iOS/Android o il loro backend.
L’ulteriore analisi semantica del main è scaduta: evidenza parziale
`ev_2096601a72175ceb942ef4714de4db95fa7b1f7833bab6d8dff591353b16849e`.
Le osservazioni sopra provengono dalla lettura diretta verificata del file.

L’approfondimento skill ha osservato `skills/list`, attività di caricamento
SKILL.md e controlli del compositore slash. REA ha analizzato solo
`webview/assets/composer-controls-26fb26618ba3.js`: parent
`ev_770a4c77c48ae52267ab780f0ddaaf08007ed9df12fd1ceadef884e1d16bd868`,
summary `ev_199f1c8802ffd6d774d6dd14869d4f9641339b872812eaef46bf08a9ac06805f`.
Copertura applicativa parziale, grafo limitato per numero di nodi; questi
risultati non ricostruiscono il discovery backend completo del prodotto.

Scelte AuraChat: eventi indipendenti dalla visibilità del desktop, filtro toast
locale; cronologia tipizzata con offset e attività espandibili; skill locali
al progetto attraverso discovery/load e `/nome`. I tool sono funzioni native
fornite al modello, non un nuovo addestramento del modello. Il client non
replica le integrazioni MCP, sandbox, tool cloud o ricerca web di ChatGPT.
Riferimenti aggiuntivi propri dell’utente: [[RD Core e Nuifit - Riferimenti riusati]].


### Coda e guida durante il turno — 18 ottobre 2026

Lettura statica del componente distribuito `webview/assets/queued-message-list-aa3e4e664a72.js` (SHA-256 `fb6796a6230366c6e4ef43e318b5af1cac11472d7bda01a719ef44a73b91f348`). Il componente distingue `queued`, `pending`, `sending` e `outcome-unknown`; permette modifica, eliminazione e invio come `Steer`. Una coda interrotta espone `Resume`; un esito ambiguo non autorizza il reinvio automatico. Queste sono osservazioni del client desktop Codex/ChatGPT distribuito, non prove del protocollo interno del modello o della UI Android.

Per AuraChat la richiesta utente è una bolla nella conversazione, con etichetta «In coda» sopra a destra. La guida immediata è distinta dalla coda FIFO; i comandi già eseguiti devono conservare i risultati nel contesto.
