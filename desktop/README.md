# AuraChat — Gateway desktop (Tauri 2)

App desktop in **Tauri 2 (Rust)** che fa da gateway locale per un LLM
OpenAI-compatible (DeepSeek di default). Possiede la API key, chiama il modello
e sta nel system tray. È lo **scope 0 + 1** della roadmap (vedi il vault).

Vedi `../AuraChat's vault/` per le decisioni: `Overview.md`,
`Content/Architettura/Client/Desktop gateway - Tauri.md`,
`Content/Design/UIUX - Overview.md`, `Content/Architettura/DevOps/Roadmap.md`.

## Cosa fa (implementato)

- **Tray** con menu (Apri AuraChat / Esci) e processo in background: chiudere la
  finestra nasconde nel tray, non termina. Si esce dal menu del tray.
- **Onboarding dell'inferenza a preset**: *DeepSeek* (basta la key, endpoint e
  modello precompilati) o *Avanzato* (base_url + modello + key custom).
- **Impostazioni** con navigazione laterale e ricerca: Generali, Account, Provider di modelli e Voce. Account mostra identità e disconnessione, senza parametri Firebase. I provider hanno una API key dedicata e uno o più modelli con URL base indipendenti. La key non torna mai nella UI: il backend espone solo `api_key_set: true/false`.
- **Chat**: invia la cronologia della conversazione attiva a `<base_url>/v1/chat/completions`
  (formato OpenAI-compatible, streaming SSE) e mostra la risposta.
- **Turno in corso**: il nome della chat nasce dal primo messaggio, subito, senza
  aspettare la risposta. Mentre il modello pensa il composer resta utilizzabile: con il
  campo vuoto compare solo **Stop**, che chiude il turno conservando la parte di risposta
  gia mostrata; con testo o allegati compaiono **Stop** e **Invia** e l'invio accoda il
  messaggio, che parte appena il turno corrente si chiude. Il messaggio accodato
  compare subito come balloon con bordo tratteggiato, etichetta **In coda** e azioni
  nel menu **…** accanto all'etichetta: **Invia subito**, **Modifica**, **Cancella**,
  come su mobile. Invia subito lo passa come
  guida al turno attivo. Durante l'apertura del menu, l'aggiornamento visivo dello
  stream resta sospeso per mantenere ferme le azioni; il testo ricevuto viene
  mostrato alla chiusura senza interrompere il modello.
  Modifica lo riporta nel compositore. Anche la dettatura resta
  disponibile (`stop_chat` ferma il turno solo per il proprietario della conversazione).
- **Barra delle applicazioni Windows**: indicatore nativo indeterminato durante
  l'elaborazione AI, anche con finestra minimizzata. Rimane attivo mentre almeno
  una chat sta lavorando e si spegne al termine, in caso di errore o dopo Stop.
- **Logo Auralisys** come icona della finestra e del tray.
- **Controlli finestra nativi** di Windows/macOS: minimizza, massimizza/ripristina
  e chiudi sono gestiti dal sistema, senza pulsanti HTML duplicati. La chiusura
  continua a nascondere nel tray; il ridimensionamento si abilita dopo lo splash.

La persistenza Firestore usa `users/{uid}`: `config`, `tree` e `window` sono mappe native,
con aggiornamenti separati che preservano gli altri campi. Il vecchio `config`
JSON stringificato resta leggibile; il database di sviluppo e stato migrato
il 17 ottobre 2026, con backup locale e rimozione di `data/tree`. Le regole remote
vanno limitate al proprietario UID dalla console (vedi vault).

## Companion e servizi esterni

Il companion usa ora lo stesso account email/password, senza pairing codice/QR.
Relay e notifiche sono implementati; l'attivazione remota richiede le regole
Firestore limitate al proprietario e il deploy della funzione FCM su Blaze.
Vedi la sezione finale e `../mobile/README.md` per lo stato delle verifiche.

## Struttura

### Card attività e pannello destro

La card **Output / Agenti / Fonti** (più **Cambiamenti** nei progetti e **Shell** quando serve) compare
quando la conversazione contiene messaggi, allegati o attività. Il pulsante
nell'intestazione la nasconde e la riapre. Su desktop l'ingresso e l'uscita animano
anche lo spazio della conversazione; sotto i 1000 px il pannello si sovrappone alla
chat per mantenere leggibile il contenuto. Con `prefers-reduced-motion` gli
spostamenti sono immediati.

Gli **Output** sono i file finali che il modello pubblica esplicitamente con
`publish_project_output`, dopo averli completati. Scritture, modifiche al codice,
script temporanei e appunti intermedi non vengono elencati automaticamente.
Non esiste una blacklist di estensioni: un report Markdown o uno script richiesto
come risultato finale è un output valido. La pubblicazione verifica file e
consenso locale e si ricostruisce dalle attività salvate, anche dei sub-agenti.
Le vecchie scritture senza pubblicazione esplicita non vengono più elencate.
Ogni riga mostra tipo, dimensione e agente; il pannello conserva i filtri per tipo.
Per le integrazioni native `artifact-created` richiede `final_output: true`,
oltre a un percorso/link o un documento/immagine valido.

**Cambiamenti +N −N** mostra branch, upstream e conteggi locali (senza fetch).
Nella card Attività il recap è una singola riga di testo, senza chip:
**Cambiamenti +N −N**, sopra Output e con colori verde/rosso più netti. Il clic apre
un menu con **Commit…**, **Commit e push…** e **Apri dettaglio completo**, senza
allargare immediatamente la sidebar. Il menu resta fermo anche durante gli aggiornamenti.
Il recap si aggiorna dopo le scritture del modello/sub-agenti e la fine dei comandi;
un controllo ogni 2 secondi rileva anche le modifiche esterne, durante i turni attivi.
Gli aggiornamenti invariati non ricreano il modulo o chiudono il menu.

Il dettaglio separa **Staged** e **Non staged**, con statistiche per ciascun gruppo
di modifiche. Non usa checkbox: **+** aggiunge un file allo stage reale di Git,
**−** lo rimuove dallo stage, **Stage tutti** e **Unstage tutti** operano sui rispettivi
gruppi senza cancellare i file. Lo stesso file parzialmente staged appare in entrambi.
Il clic aggiorna immediatamente il gruppo con **In corso…**, senza bloccare chat o
gli altri file: i clic successivi sono accodati e applicati in ordine. Git conferma
solo la revisione dell'indice, senza ripetere tutte le scansioni/statistiche; una
sola riconciliazione finale ripristina conteggi e modifiche parzialmente staged.
In caso di errore la coda si ferma, lo stato reale viene riletto e il problema
rimane visibile. Commit/push attendono la conferma delle operazioni pendenti.
Nel gruppo **Non staged**, il cestino su ogni file e **Scarta tutti…** aprono una
conferma con l'elenco esatto: i file tracciati vengono ripristinati dall'indice
corrente, non da HEAD; i file nuovi non tracciati vengono eliminati definitivamente
senza Cestino. Lo stage resta intatto, anche per file parzialmente staged o su un
branch senza commit. Annulla non modifica nulla. Se contenuti, indice, HEAD o
branch cambiano dopo l'anteprima, la conferma viene rifiutata e lo stato riletto.
La selezione è limitata ai file non staged visualizzati; file ignorati e cartelle
non vengono eliminati ricorsivamente. Link, junction, submodule e file oltre 2 MiB
vanno gestiti esternamente. L'operazione non è annullabile e non è una transazione
atomica contro programmi esterni: evitare modifiche concorrenti; un errore può
lasciare un ripristino parziale, segnalato esplicitamente e riconciliato nella UI.
Il commit usa solo l'indice: modifiche non staged, anche negli stessi file, restano
nel working tree. I comandi rapidi non aggiungono automaticamente tutti i file:
senza stage aprono il dettaglio e indicano come prepararlo.
**Genera con AI** invia solo quel diff al modello configurato nella conversazione,
senza strumenti; il messaggio rimane modificabile e il commit richiede
**Conferma commit**. **Push** ha una conferma separata della destinazione.
Il menu **…** contiene **Commit e push…**: se il push fallisce il commit resta locale.
Non vengono eseguiti force push, pull, reset o configurazioni automatiche del remoto.
Un upstream esistente è necessario per il push. Le credenziali usano Git già
configurato; i prompt interattivi sono disabilitati e gli errori sono mostrati.

Git cerca le root di repository nelle cartelle collegate e autorizzate, anche
nelle sottocartelle dei contenitori multi-repository. Il dettaglio offre un
selettore quando ne trova più di una; senza repository mostra uno stato vuoto,
non l'errore Git «not a git repository». La ricerca si esegue all'apertura e con
**Aggiorna**, non a ogni polling dello stato. Si ferma quando trova un repository,
riconosce anche i worktree (`.git` come file), non segue link/junction e salta
`.git`, `node_modules`, `target`, `.venv`, `build` e `dist`. Oltre 20.000 elementi
segnala esplicitamente la ricerca incompleta: collegare una sottocartella per
restringerla. Errori reali di accesso o di Git restano visibili.
Non usa mai il repository antenato di una sottocartella autorizzata e ricontrolla
che ogni repository selezionato sia dentro un consenso locale valido. Tutti i file già
staged fanno parte del commit: controllare l'intero gruppo Staged, non solo le
ultime aggiunte. Cambiamenti esterni dello stage o di HEAD invalidano l'anteprima
senza perdere il messaggio scritto; modifiche solo al working tree non la invalidano.
Conflitti, merge/rebase in corso e HEAD scollegato bloccano le mutazioni; stage,
unstage, scarta, commit e push attendono che le conversazioni siano ferme. Controllare lo stage prima della
conferma: cambiamenti di programmi esterni e hook Git restano responsabilità
del repository. Limiti espliciti: 1000 file modificati, diff fino a 64 KB,
output Git/file non tracciati fino a 2 MiB; submodule da gestire esternamente.
Questa sezione è nel desktop, anche nella disposizione compatta; non aggiunge
una nuova superficie Git al companion Flutter.
Verifiche dedicate: `tests/git-panel.cjs` per UI e conferme simulate; test Rust
`git::tests` su repository temporanei e remoto bare locale, mai sul repository
di lavoro; `llm::tests::commit_message_sends_only_the_selected_diff_without_tools_and_reports_errors`
usa un provider HTTP locale simulato.

### Integrazioni MCP generali dalla chat

La chat dispone di `list_mcp_servers`, `configure_mcp_server`,
`import_mcp_server`, `remove_mcp_server`, `list_mcp_tools` e `call_mcp_tool`. Non sono strumenti
specifici di Firebase: qualunque server compatibile può fornire ricerca web,
browser, accesso HTTP, API e altre funzioni. Il modello deve prima scoprire il
catalogo reale e usare nomi e schemi restituiti dal server, senza inventare
accessi o risultati.

Le integrazioni **globali** si configurano dalla chat, anche senza progetto,
e sono salvate solo sul PC, separate per account, in
`<app_config_dir>\mcp\<SHA-256 UID>\.mcp.json`. Configurazione, connessione e
chiamate globali richiedono approvazione esplicita. Quelle **di progetto** usano
`.mcp.json`, oppure `.cursor\mcp.json` se il primo manca, nella root autorizzata;
seguono i permessi Richiedi/Auto/Full del progetto. Una configurazione da cloud,
un link o una cartella nominata in chat non concedono accesso locale.

Sono supportati **stdio** (`command`, `args`, `env`) e **Streamable HTTP**
(`url`, `headers`, HTTPS oppure HTTP su loopback). Esempio di configurazione:

```json
{
  "mcpServers": {
    "locale": {
      "command": "C:\\percorso\\server-mcp.exe",
      "args": []
    },
    "remoto": {
      "url": "https://servizio.example/mcp",
      "headers": { "Authorization": "Bearer ${MCP_SERVICE_TOKEN}" }
    }
  }
}
```

Su Windows, per pacchetti Node lanciati con `npx`, configurare `command` come
`cmd.exe` e `args` come `["/c", "npx", "-y", "<pacchetto@versione>", ...]`,
usando le istruzioni ufficiali del server. Configurare un eseguibile non lo
installa magicamente: il pacchetto viene acquisito dal launcher dichiarato, se
previsto, dopo l'approvazione della connessione. Un comando mancante, un login
assente o una discovery fallita producono errori, non una falsa conferma.
Rimuovere un'integrazione elimina la sua configurazione, non il software.

Usare `${NOME_VARIABILE}` in `env` e `headers` per credenziali già presenti
nell'ambiente del desktop; non incollare token nella chat o negli argomenti
del comando. `list_mcp_servers` e `list_mcp_tools` riportano anche `discovered`
e `discovery_errors`: configurazioni globali trovate in Cursor
(`~/.cursor/mcp.json`), Claude Code (`~/.claude.json`, solo `mcpServers`
globali), Claude Desktop, Copilot CLI (`~/.copilot/mcp-config.json`) e Codex
(`~/.codex/config.toml`). La discovery non avvia programmi e non restituisce
argomenti, URL, valori di ambiente/header o altri dati del file al modello.
Un catalogo AuraChat vuoto non significa che il servizio non abbia un MCP.
`import_mcp_server` copia solo il server scelto nella configurazione globale
AuraChat, dopo approvazione, senza modificare l'originale o sovrascrivere nomi
esistenti. Le impostazioni di auto-approvazione del client non vengono importate;
filtri di tool non supportati e formati incompatibili producono errori espliciti.
I file sorgente sono limitati a 1 MiB e 64 server; le configurazioni AuraChat
mantengono i limiti sotto. Per Codex sono supportati anche `http_headers`,
`bearer_token_env_var` e `enabled`; i timeout restano quelli di AuraChat.
Su Windows i launcher importati npx/npm vengono adattati a cmd.exe.

Le sessioni browser/OAuth di altri client non vengono copiate. Un server stdio
puo invece riusare il proprio login CLI gia presente sul PC (per esempio Firebase).
I login mancanti vanno completati esternamente:
questa versione non implementa un flusso OAuth MCP né il vecchio trasporto SSE.
I server MCP eseguono codice locale e/o operazioni esterne con i propri accessi,
senza sandbox; le loro descrizioni e risposte restano dati non affidabili.
Le sessioni sono limitate al turno (anche per i sub-agenti), con timeout, chiusura
alla fine/Stop e ricontrollo di account, consensi e configurazione prima delle
chiamate. Limiti: 16 server per configurazione, 64 KiB per config, 256 strumenti
per server e 256 KiB per risultato. Un timeout non annulla eventuali operazioni
già ricevute dal servizio esterno.

Non è una promessa di parità completa con ChatGPT: ricerca, browser e altri
servizi diventano disponibili quando il relativo MCP è configurato e autenticato.
Le verifiche native usano `tests\mcp-server.cjs`, un server stdio/HTTP locale
senza account o traffico verso servizi reali.

Per un servizio autenticato il modello deve verificare il suo MCP ufficiale,
non dedurre l'assenza di API dal link della console o dall'help di una vecchia
CLI. Per esempio il server Firebase corrente espone strumenti Crashlytics
per issue ed eventi: non richiede di automatizzare la console web per questo.

Per leggere le istruzioni ufficiali prima di configurare il primo MCP esiste
anche **`fetch_web_page`**, disponibile nelle chat senza progetto. Richiede
approvazione dell'URL esatto e legge solo testo/HTML/JSON/XML UTF-8, senza
cookie, login, JavaScript o reindirizzamenti automatici. Restituisce al massimo
64.000 caratteri da una risposta limitata a 256 KiB, con troncamento esplicito.
Non sostituisce un browser autenticato o un motore di ricerca.

Le **Fonti** contengono gli allegati dell'utente e i link HTTP(S) nei suoi messaggi;
le letture del progetto e i link citati dal modello non sono fonti. `user-source`
permette a un'integrazione nativa di aggiungere screenshot o altre risorse
effettivamente fornite dall'utente.

I due eventi usano `{conversation_id, id, title, kind, summary?, content?, url?, path?}`.
`kind: image` abilita l'anteprima; `document` abilita Markdown sanificato; gli altri
contenuti sono testo inerte. Le immagini accettano URL HTTP(S) o data URL raster
PNG/JPEG/WebP/GIF. I percorsi locali sono mostrati come riferimento; non sono eseguiti.
Gli artefatti e le fonti ricevuti tramite eventi durano per la sessione. Allegati e
link nei messaggi si ricostruiscono dalla cronologia salvata. Il selettore allegati
attuale accetta ancora solo file testuali: questa UI non abilita l'upload multimodale
né una pipeline di generazione immagini/file.

La sezione **Shell** è la console di debug della sessione: elenca tutti i comandi
della conversazione, non solo quelli attivi. Ogni riga mostra il comando leggibile
(ricostruito da `{program, arguments}`), un indicatore di stato e la durata; il
dettaglio aggiunge directory, codice di uscita, sub-agente, log in tempo reale con
scorrimento automatico e lo stop dei processi attivi. Anche i comandi in attesa di
approvazione compaiono nella stessa lista, con stato «In attesa di approvazione» o
«Revisione automatica»: si decidono dal compositore e non sono interrompibili. I log
conclusi restano consultabili per tutta la sessione.

`managed_shells::Shells` registra processi già avviati da un runner nativo tramite
`track(uid, conversation_id, command, cwd, child, notify)`. Il runner passa stdout e
stderr piped e inoltra gli snapshot con `app.emit("shell-activity", snapshot)` nella
callback. Ogni snapshot espone `started_at` e `finished_at` in millisecondi epoch: la
UI calcola la durata reale senza inventare stati. `list_shells` recupera gli snapshot
al cambio conversazione; `stop_shell` accetta soltanto un ID registrato che appartiene
all'utente e alla conversazione. Su Windows termina anche i discendenti; lo stop non
richiede rete. Le revisioni degli snapshot impediscono che aggiornamenti tardivi
ripristinino stati vecchi. Il registro conserva al massimo gli ultimi 128 KiB di log
per processo e chiude le esecuzioni all'uscita dell'app.

Il runner nativo avvia i comandi autorizzati e li registra nel pannello Shell.
Le esecuzioni di un sub-agente sono associate al suo ID e vengono fermate quando
l’utente interrompe l’agente.

La UI degli Agenti ascolta l'evento Tauri `agent-activity`, con payload:

```json
{
  "conversation_id": "id della conversazione",
  "id": "id stabile dell'agente",
  "status": "running",
  "title": "Analisi conversazioni",
  "summary": "Breve aggiornamento corrente",
  "task": "Incarico assegnato",
  "content": "Dettaglio aggiornato in Markdown",
  "model": "nome del modello",
  "reasoning": "livello di ragionamento"
}
```

`conversation_id`, `id` e `status` sono obbligatori. Gli stati supportati sono
`running`, `waiting`, `completed`, `failed`, `cancelled`; gli aggiornamenti parziali
preservano gli altri campi. `content` sostituisce il dettaglio precedente, non è
un delta. Gli agenti sono separati per conversazione e restano in memoria durante
la sessione. Il backend crea realmente i sub-agenti tramite il modello configurato,
condivide il contesto e le root autorizzate e inoltra risultato, reasoning e
strumenti eseguiti. Ogni chiamata attende il risultato; sono ammesse fino a
quattro deleghe per turno e i figli non possono delegare a loro volta.

La card elenca solo gli agenti attivi (in esecuzione o in attesa), fino a due,
sotto il riepilogo testuale senza icona «N in esecuzione · M totali».
Quando non ce ne sono, rimangono solo il riepilogo e **Visualizza tutti**, che
apre l'elenco completo con gli agenti conclusi, falliti e interrotti.
Ogni riga combina orb di stato, titolo, ultima attività (o riepilogo), stato
e tempo trascorso. Il dettaglio separa intestazione con stato, chip di modello,
ragionamento e numero di strumenti, quindi Incarico, Cronologia e Risultato.

Verifica: `node tests/activity-panel.cjs` con Playwright in `NODE_PATH` (servizi
nativi simulati) copre artefatti con filtri e scarto della prosa, trail shell con
comandi in attesa e agenti. Le immagini di verifica sono in `../.artifact/activity/`.

```
desktop/
├── assets/logo-auralisys.svg      # copia canonica del logo (sorgente delle icone)
├── ui/                            # frontend statico (nessun bundler)
│   ├── index.html
│   ├── styles.css                 # design token (palette/spazio/tipo) definiti qui
│   ├── app.js
│   └── assets/logo-auralisys.svg  # copia servita (il webview serve solo ui/)
└── src-tauri/                     # backend Rust
    ├── src/{main,lib,config,llm}.rs
    ├── icons/                     # PNG/ICO derivate dal logo
    ├── capabilities/default.json
    └── tauri.conf.json
```

Il logo esiste in due copie per necessità: `assets/` è la copia canonica (usata
per rigenerare le icone), `ui/assets/` è quella servita al webview, che può
leggere solo file dentro `ui/`.

## Prerequisiti

- Rust (rustup) con target `stable`.
- Visual Studio Build Tools con il carico "Desktop development with C++"
  (richiesto da Tauri su Windows; anche da `reqwest`/rustls).
- `cargo install tauri-cli --version "^2"` (una tantum).

## Avvio

```bash
cd desktop
cargo tauri dev
```

`cargo tauri dev` serve i file statici di `ui/` (nessun server esterno, nessun
`npm install`). Per un binario di produzione:

```bash
cargo tauri build   # produce l'installer NSIS in src-tauri/target/release/bundle/
```

Su macOS servono Rust e gli strumenti da riga di comando di Xcode. La configurazione
`src-tauri/tauri.macos.conf.json` genera invece `AuraChat.app`, con icona macOS e
descrizione/entitlement per il microfono. Per compilare e installare localmente:

```bash
cd desktop
npm exec --yes --package @tauri-apps/cli@2 -- tauri build --bundles app
ditto src-tauri/target/release/bundle/macos/AuraChat.app /Applications/AuraChat.app
open /Applications/AuraChat.app
```

È una build release per il Mac corrente. La distribuzione ad altri utenti richiede
separatamente firma Developer ID e notarizzazione Apple.

## Avvio da VS Code

Apri la cartella `desktop/` in VS Code:

- **`Terminal → Run Task → AuraChat: dev`** — avvia `cargo tauri dev` (come da
  terminale). È il modo più semplice e non richiede estensioni.
- **`F5`** — debug nativo del backend Rust con breakpoint, tramite
  `.vscode/launch.json`. Richiede l'estensione **CodeLLDB** (Vadimcn); per
  l'autocompletamento conviene anche rust-analyzer.

## Configurazione e key

La configurazione (`base_url`, `model`, `api_key`) è salvata in JSON nella
cartella config dell'app (`app_config_dir`, su Windows
`%APPDATA%\dev.aurachat.desktop\config.json`). **La key non è mai nel
repository né nel vault.** Il backend non la logga mai: gli errori contengono
solo la risposta dell'API, mai la richiesta (che porta l'header di
autorizzazione).

## Preset DeepSeek

Verificato su `api-docs.deepseek.com` (ottobre 2026):

- `base_url` = `https://api.deepseek.com` (l'app aggiunge `/v1/chat/completions`)
- `model` = `deepseek-flash` (default attuale; `deepseek-chat` è stato ritirato
  a luglio 2026). L'alternativa è `deepseek-v4-pro`.

I valori iniziali sono definiti in `src-tauri/src/config.rs`; il preset dell’editor in `ui/settings.js` usa gli stessi valori. Endpoint e modelli diventano modificabili nella configurazione del provider.

## Icone

`src-tauri/icons/` contiene PNG/ICO/ICNS derivate da `../mobile/assets/app-icon.svg`,
con lo stesso logo lavanda e sfondo scuro del mobile. Per rigenerarle da `desktop/`:
`cargo tauri icon ../mobile/assets/app-icon.svg --output /tmp/aurachat-icons`, poi
copiare i PNG, ICO e ICNS desktop in `src-tauri/icons/`. `tray.png` rimane separata
e trasparente per la barra di sistema.

La finestra usa la cornice nativa del sistema: semafori a sinistra su macOS,
riduzione/ingrandimento/chiusura a destra su Windows. La chiusura continua a
nascondere l'app nel tray. Il companion pubblica la piattaforma effettiva e il
nome del computer; su macOS legge il nome configurato in Impostazioni di Sistema.
Gli identificatori Windows esistenti restano invariati.

## Localizzazione

L'interfaccia è localizzata in **italiano** e **inglese**. Le stringhe stanno in
`ui/locales/it.json` e `ui/locales/en.json` (JSON piatti, facili da modificare),
caricate a runtime da `app.js`.

La lingua è **rilevata automaticamente** dal sistema (`navigator.language`, che
nel WebView2 rispecchia la lingua del computer): italiano se il sistema è
italiano, altrimenti inglese. Non c'è un selettore manuale (non richiesto).

Gli errori del backend sono chiavi stabili (`no_api_key`, `empty_fields`)
tradotte nei JSON; gli errori tecnici (HTTP/API) vengono mostrati col prefisso
localizzato ("Errore:" / "Error:"). **Da confermare:** la lingua di fallback
quando il sistema non è né italiano né inglese (per ora inglese).

## Dipendenze

Solo Tauri 2 e un client HTTP (`reqwest` con TLS nativo: schannel su Windows,
OpenSSL su Linux); `serde`/`serde_json` sono la plumbatura standard dei comandi
Tauri e della configurazione. Nessuna dipendenza lato frontend (niente npm).

## Decisioni da confermare (non decise nel vault)

- `identifier` dell'app: usato `dev.aurachat.desktop` come segnaposto.
- Font: lo stack è `Plus Jakarta Sans → Inter → sans-serif` ma il font **non è
  bundlelato** (nessun caricamento da Google Fonts): la decisione "bundlelare o
  meno il font per l'uso offline" è aperta.
- Chiusura finestra → nasconde nel tray (non termina): coerente con "gira in
  background", ma non esplicitamente deciso.
- Il contesto di progetto viene fornito al modello per gli strumenti di lettura; nessuna personalità o istruzione generale inventata.

## Debug da Visual Studio Code

Apri la cartella `AuraChat` oppure `desktop` e installa l'estensione consigliata
CodeLLDB (`vadimcn.vscode-lldb`). In Esegui e debug seleziona **AuraChat: debug**:
`F5` compila e avvia l'app, `Shift+F5` (Stop) termina il processo anche se nel tray.
I breakpoint Rust funzionano sui sorgenti in `src-tauri/src`.
Per il frontend usa gli strumenti del WebView. Il frontend statico non richiede
un server separato.

## Disposizione finestra

Dimensioni, posizione e stato massimizzato sono salvati nella mappa Firestore
`users/{uid}.window` dopo una pausa di 1 secondo dai cambiamenti. La splash parte
centrata a 480x320; prima di mostrare la chat viene ripristinata la finestra
salvata. Senza dati precedenti la finestra e 1080x880, adattata al monitor.
Spostamenti e ridimensionamenti della splash non sovrascrivono i dati utente.

## Progetti e cartelle di lavoro

Un progetto contiene un nome, cartelle di origine reali e chat dirette.
La creazione apre il selettore del computer e chiede il consenso alla lettura;
Modifica progetto permette di cambiare nome e collegamenti. Rimuovere un
collegamento non elimina i file o le chat. I consensi restano locali, per utente
e progetto; i percorsi su Firestore non autorizzano altri dispositivi.
Il modello può esplorare le root autorizzate e leggere file UTF-8 pertinenti alla richiesta con strumenti nativi. Scrittura ed esecuzione dipendono dalla modalità locale del progetto.
I vecchi gruppi virtuali vengono appiattiti in chat dirette senza perderle.

I pulsanti ellissi e nuova chat compaiono su hover/focus. Progetti e Recenti
sono comprimibili, con header e stati vuoti coerenti. Nuova chat apre una bozza:
il salvataggio avviene dal primo messaggio. Test dedicato:
`node tests/project-menus.cjs` (Playwright disponibile nel runtime di sviluppo).

## Chat, file e dettatura locale (17 ottobre 2026)

La conversazione usa una colonna di lettura da 760 px, carattere di sistema,
Markdown sanificato, blocchi di codice copiabili e azioni sui messaggi:
copia, modifica, rigenera, feedback e lettura tramite le voci del sistema.
Il titolo apre le azioni della conversazione e i token stanno nel dettaglio
contesto. Il pulsante + sceglie fino a quattro file di testo (128 KiB ciascuno,
256 KiB complessivi); i contenuti partono solo insieme al messaggio inviato.

Impostazioni → Voce gestisce Cohere Transcribe INT4 (~2 GB): download da una
revisione immutabile, controllo SHA-256, interruzione/ripresa e rimozione locale.
Il modello usa ONNX Runtime su CPU, senza Python, chiavi o servizi di trascrizione.
Con il modello installato la verifica SHA-256 e il caricamento dei pesi partono da soli all'apertura dell'app: il microfono mostra un loader sull'icona, resta disabilitato finché il modello non è in memoria e diventa utilizzabile subito dopo. Impostazioni → Voce espone lo stesso stato (“Preparazione del modello locale…”), quindi non serve più cliccare il microfono per scoprirlo; su CPU i tempi dipendono dall'hardware.
Il registratore AudioWorklet cattura mono, ricampiona a 16 kHz e conserva l'audio
solo in memoria. Limite due minuti, inferenza in blocchi fino a 30 secondi.
La lingua segue italiano/inglese dell'interfaccia. Registrazione con forma
 d'onda: X scarta solo l'audio; Stop trascrive senza inviare; Invio trascrive e
invia insieme al testo già scritto e agli allegati. Cambiare chat scarta i
risultati tardivi; tutte le tracce del microfono vengono chiuse. Annullare mentre
il motore elabora scarta il risultato; il blocco CPU in corso può terminare.

Su Windows, all'avvio effettivo della cattura vengono messe in pausa soltanto le
sessioni multimediali già in riproduzione che espongono i controlli di sistema
(per esempio Spotify). Non viene inviato un tasto play/pausa globale: un lettore
già fermo non viene mai avviato. Alla fine della registrazione la musica riparte
prima dell'inferenza, quindi durante la trascrizione, anche dopo annullamento,
cambio chat, chiusura nel tray o logout. Riprendono soltanto le sessioni sospese
da questa registrazione, ancora presenti, in pausa e sullo stesso brano; un
lettore chiuso, fermato, già riavviato o passato ad altro brano non viene forzato.
L'uscita normale ripristina la riproduzione anche dal nativo; un arresto forzato
del processo non può eseguire questa pulizia. Lettori senza integrazione Windows
non sono controllabili; gli errori dei controlli sono segnalati senza impedire
la dettatura. Sul companion mobile non viene aggiunto controllo musicale remoto.

Le chat di progetto espongono al modello `list_project_files`,
`search_project_files` (ricerca testuale ricorsiva, max 100 risultati, salta
`.git`/dipendenze/build e i link) e `read_project_file` (per intervalli di righe,
file fino a 1 MiB), con ID root, percorsi relativi, controllo canonico anche
su link/junction, limiti di dimensione per singolo file. `edit_project_file`
gestisce automaticamente file CRLF e prefissi di riga copiati dalla lettura. L’esplorazione prosegue fino alla risposta del modello, senza soglie arbitrarie sul numero di passaggi o sul totale letto. Vengono consultati
solo i consensi locali dell'utente/progetto e le cartelle ancora collegate.
I file letti per la richiesta vengono inviati al provider LLM configurato;
non avviene scansione o caricamento automatico dell'intera root. Le modifiche verificano la revisione del file e i comandi passano dal controllo
permessi. Solo Accesso completo abilita percorsi assoluti esterni. Il provider
deve supportare tool calling.

Se il modello non vede strumenti file, la chat non appartiene a un progetto
con cartelle autorizzate su questo dispositivo. I consensi sono locali e non
arrivano dalla sincronizzazione cloud: aprire **Modifica progetto**, aggiungere
o riselezionare la cartella, consentire la lettura e salvare; usare poi una chat
di quel progetto. Le modalita Ask/Auto/Full non sostituiscono il consenso iniziale.
Il contesto del modello distingue questo caso dalla chat senza progetto e indica
il percorso di ripristino, anche quando delegare non puo fornire accesso ai file.

### Domande interattive

Il tool `ask_user` è disponibile anche nelle chat senza progetto e nei sub-agenti:
pone una domanda alla volta, fino a otto opzioni, con scelta singola o multipla.
La scheda sopra il compositore aggiunge sempre **Risposta personalizzata** e
**Parliamone**. Il turno attende la risposta effettiva; Parliamone restituisce una
richiesta di discussione senza autorizzare nessuna scelta. Ask/Auto/Full non
rispondono automaticamente alle domande.

Per una sequenza di domande già note il modello passa un'unica chiamata:
`{"questions":[{"question":"Prima?","choices":["A","B"]},{"question":"Seconda?","multi_select":true,"choices":["C","D"]}]}`.
Sono ammesse fino a 12 domande, ognuna con al massimo 8 opzioni.
**Avanti**, **Indietro** e **Salta** funzionano localmente: nessuna richiesta al
modello tra i passaggi. Le risposte si possono correggere prima dell'invio finale.
Il tool restituisce `responses`, con domanda e risposta (`action`, `selected`,
`custom`), solo al termine; il riepilogo diventa un messaggio utente salvato nella
conversazione principale. **Parliamone** interrompe la sequenza e restituisce le
risposte precedenti più la richiesta di discussione; la X chiude inviando soltanto
i passaggi precedenti (non la bozza corrente). Domande saltate o non compilate
non autorizzano alcuna scelta. Nei riepiloghi `[skip]`, `[discuss]` e `[cancel]`
distinguono le azioni dalle risposte. Nei sub-agenti il riepilogo resta nel risultato
del tool, senza inserire messaggi nel turno del coordinatore.

Solo quando una domanda richiede di ragionare sulle risposte precedenti, il modello
usa una chiamata separata con `step: {current: 1, total: 3}`.
**Parliamone** o un chiarimento mantengono lo stesso passaggio.
Domande singole e sequenze con totale ancora sconosciuto non mostrano un
conteggio inventato. Il backend verifica `1 <= current <= total`; numerazione
e totale sono dichiarati dal modello, non ricavati dal numero di tool chiamati.

Le richieste sono isolate per account, conversazione e ID e si possono risolvere
una sola volta. Cambiare chat conserva la risposta in bozza; tornando alla chat
si recuperano anche le richieste native ancora aperte. Stop ritira le domande del
turno o del sub-agente fermato. Le risposte compaiono nell'output dello strumento
nella cronologia delle operazioni, non attribuiscono nuovi permessi. Le domande
in attesa non sopravvivono alla chiusura dell'app: il turno va rilanciato.

## Cronologia Firestore v2

`users/{uid}` conserva config, window e tree. Il tree contiene mappe di progetti
e riepiloghi chat con riferimenti agli ID, senza testi o allegati.
I documenti `users/{uid}/conversations/{id}` contengono metadati e versione;
i messaggi stanno in `messages/m000000000000`, con ordine esplicito e mappe
native. All'avvio si legge il tree; la singola cronologia viene letta quando si
apre la chat. I turni aggiornano solo i messaggi cambiati, con commit atomico e
precondizioni sulle versioni. I conflitti richiedono di riaprire la chat.

La migrazione crea un backup privato completo in `migration-backups/` dentro
la cartella configurazione, copia e rilegge i documenti preservando ID, ordine,
allegati e feedback, quindi sostituisce il vecchio tree con la proiezione v2.
È ripetibile. Il 17 ottobre 2026 il database di sviluppo è stato migrato e
verificato: un progetto, zero conversazioni presenti al momento del passaggio.
Il test CRUD remoto usa una chat temporanea e verifica pulizia e conservazione
di config/window/albero originale. Le regole remote vanno amministrate in console.
Le operazioni oltre 450 scritture o 9 MiB vengono rifiutate prima del commit;
il tree leggero resta soggetto al limite Firestore di 1 MiB.

Verifiche: test Rust, test UI in `tests/` (inclusi `chat-tools.cjs`,
`voice-flow.cjs`, `lazy-history.cjs`), trascrizione CPU reale di campione pubblico,
provider reale con file fixture, migrazione e CRUD remoti. I test browser usano
un microfono simulato ma AudioContext/AudioWorklet reali; il dispositivo fisico
e il dialogo permessi nel WebView Windows richiedono prova manuale.

## Permessi, sub-agenti e feedback operativo (17 ottobre 2026)

Il selettore accanto al + degli allegati salva la modalità localmente per utente
e progetto. Richiedi approvazione è il default: ogni scrittura e comando richiede
Consenti una volta / Rifiuta nella chat, con percorso e anteprima di testo o argv.
Le richieste sono associate ad account, conversazione, turno e agente, hanno
revisioni monotone e scadono dopo dieci minuti. Una decisione non è riutilizzabile;
un diniego non può essere ritentato identico nello stesso turno. Le chat in
background mostrano lo stato di attesa nella sidebar.

Approva per me consente le scritture nelle root autorizzate e pochi comandi Git
verificati senza prompt. Gli altri comandi passano a una chiamata separata del
modello configurato: solo una risposta JSON valida con decisione allow e rischio
low consente l'azione. Azioni rischiose, ambigue o errori del reviewer richiedono
consenso umano. I token della revisione vengono inclusi nel totale del turno.
Accesso completo richiede una conferma iniziale e consente file e comandi senza
prompt, anche fuori dal progetto. Il cambio modalità attende che le chat del
progetto siano ferme. Le tre scelte sono effettive, ma **i comandi usano l'account
Windows senza sandbox OS**: cwd non limita file e rete e il reviewer non sostituisce
l'isolamento. Le descrizioni UI rendono esplicito questo limite.

Gli strumenti write_project_file ed edit_project_file richiedono la revisione
SHA-256 restituita dall'ultima lettura (oppure previous_content per compatibilità).
Le sostituzioni puntuali devono corrispondere una sola volta. Il backend verifica
nuovamente percorso e contenuto dopo l'approvazione e serializza le scritture
interne, scrivendo le sostituzioni su un file temporaneo prima della rinomina.
Le scritture non popolano Output: solo `publish_project_output` pubblica un file
finale e lo rende ricostruibile dalle attività salvate.

I sub-agenti usano il modello e i permessi del progetto, senza nuove autorizzazioni.
Il pannello conserva il testo progressivo, il reasoning effettivamente restituito
dal provider, le operazioni e il loro esito. Interrompi agente annulla le richieste
HTTP in attesa, impedisce nuove operazioni e arresta le sue shell registrate.
Le attività terminali non vengono riattivate da eventi tardivi.

Lo streaming aggiorna nodi stabili: i dettagli aperti e il focus non vengono
ricreati a ogni frammento. Ragionamento e attività restano in un unico elenco
espandibile dentro la chat: il cervello viola pulsa durante il turno e il tempo
trascorso appare nella stessa intestazione. Non c’è una seconda riga di reasoning
sopra il composer. Il testo dei messaggi e dell’input usa 13 px, con titoli
proporzionati e codice invariato. Lo shimmer segnala soltanto lavoro attivo; l'attesa di
consenso ha un segnale distinto. Le animazioni rispettano movimento ridotto e
si fermano quando la finestra è nascosta. Sidebar, agenti e strumenti condividono
icone Lucide e i colori del tema AuraChat.

Verifiche: tests/operations-flow.cjs, permissions.cjs, chat-progress.cjs,
activity-panel.cjs e suite di regressione UI. Questi test usano Edge reale e
servizi nativi simulati. tests/run-native.ps1 compila ed esegue i test Rust,
inserendo il manifest Common Controls v6 nel solo runner dei test (SDK Windows
richiesto), risolvendo TaskDialogIndirect mancante nel runner non attivato.
I test HTTP dei sub-agenti usano un provider locale simulato e file temporanei
reali; quelli shell avviano e fermano processi reali. I test di account, provider
esterno, migrazione e download del modello vocale rimangono esplicitamente opt-in.

## Materiale locale di verifica

La baseline di 206 icone SVG è in `ui/assets/icons/`, con nomi senza hash e
provenienza in `provenance.json`. `new_chat_os_windows` è rinominata `new_chat.svg`.
`ui/icons.js` incorpora i soli dieci simboli usati nell'interfaccia (Home, Nuova
chat, indietro, avanti, invio, chevron, spunta, agenti e cartella chiusa/aperta); gli altri SVG restano
disponibili come asset. Le icone monocromatiche seguono il colore del tema. I progetti usano
`folder_closed` da chiusi e `folder_open` da aperti. Le righe chat di Progetti
e Recenti non hanno icona a sinistra; le chat di progetto restano rientrate.

Screenshot, sessioni REA e output generati sono conservati nella cartella
`../.artifact/`, ignorata da Git. I test creano direttamente le proprie sottocartelle
in quella posizione; il vecchio percorso `../artifacts/` è ignorato per
compatibilità con script precedenti. Nessuna cattura viene versionata.

## Impostazioni e provider (17 ottobre 2026)

L’ingresso nella rail usa un ingranaggio Lucide. Il pannello ha una seconda
sidebar con profilo, ricerca per sezione/parola chiave e quattro sezioni. Account
mostra email, stato di accesso e disconnessione locale; non espone configurazioni
Firebase. La disconnessione elimina la sessione salvata e la cache in memoria,
conserva i dati remoti ed è bloccata durante le richieste in corso.

Provider di modelli permette di aggiungere DeepSeek, OpenAI, OpenRouter o un
provider personalizzato compatibile con OpenAI Chat Completions in streaming.
DeepSeek precompila i modelli esistenti; per gli altri si inseriscono gli ID dei
modelli disponibili sul proprio account. Ogni provider ha una chiave condivisa
dai suoi modelli, ognuno con il proprio URL base. Gli URL ammettono HTTPS e HTTP
su localhost; il percorso `/v1` non viene duplicato. I preset seguono le
[API DeepSeek](https://api-docs.deepseek.com/en/),
[OpenAI](https://developers.openai.com/api/reference/overview) e
[OpenRouter](https://openrouter.ai/docs/api/api-reference/models/get-models).

La configurazione resta in `users/{uid}.config`: `providers` contiene nome,
tipo e chiave; `models` associa ID, modello, URL e provider. La configurazione
precedente viene convertita in memoria conservando chiavi, ID e modello attivo,
e salvata nel nuovo formato alla prima modifica. Le chiavi non sono restituite
al frontend e lasciarle vuote nell’editor conserva quelle esistenti. Rimangono
archiviate nella configurazione Firestore dell’account, come nella versione
precedente: questo intervento non aggiunge un vault crittografico dedicato.
Rimuovere un provider conserva le chat e seleziona un modello rimanente;
se non ne rimangono, il menu modelli permette di aprire la configurazione.
Chat, sub-agenti e revisione automatica usano la chiave del modello selezionato.

Verifiche: `tests/settings-flow.cjs`, suite UI esistente e `tests/run-native.ps1`.
I test browser simulano i servizi nativi e non chiamano provider reali.
Le catture desktop e compatte sono in `../.artifact/settings/`.

### Correzioni dettatura e selettore modelli

Il modello occupato produce un messaggio nella chat e non apre le impostazioni:
la sezione Voce si apre solo se il modello non è pronto. La preparazione nativa
precede la cattura del microfono e riusa il modello caricato. Dopo un annullamento,
la UI attende il completamento dell’operazione nativa prima di consentirne un’altra;
il risultato annullato non viene inserito in alcuna bozza. Non si interrompe
forzatamente un’inferenza ONNX già in corso. SHA-256 è compilato con ottimizzazioni
anche nel profilo di sviluppo, mantenendo la verifica completa dei file.
Il test reale locale esegue preparazione e due trascrizioni consecutive. Con il modello installato il caricamento parte all’avvio: il microfono resta disabilitato, con un loader sull’icona e senza click prematuri, finché i pesi non sono in memoria; `voice-flow.cjs` copre avvio, loader, click inerte e sblocco.

Il selettore mostra il logo bianco del provider prima del modello quando disponibile
(DeepSeek); altrimenti usa “Provider · modello”. Le etichette accessibili includono
sempre il nome del provider.

## Companion e notifiche (17 ottobre 2026)

`../mobile/` contiene il client Flutter Android con accesso allo stesso account,
nome Windows del PC, chat/progetti, modelli, stop e approvazioni. Il gateway
pubblica presenza e albero pubblico senza credenziali provider, prende in carico
richieste tramite revisione Firestore e non riesegue i turni dopo un riavvio.
Le richieste scadono dopo cinque minuti. I turni avviati dal telefono vengono
mostrati anche nella UI desktop; la cronologia caricata di altre chat viene
preservata durante l'aggiornamento dell'albero remoto.

Le notifiche di completamento nascono nel backend Rust: funzionano anche se il
webview è nascosto, senza dipendere dal rendering della chat. Coprono un solo
esito per turno (risposta pronta, errore o interruzione), le approvazioni in
attesa e le operazioni esplicite dell'utente (trascrizione, download voce). I
completamenti intermedi di agenti, shell e strumenti restano nell'app e non
generano push. Il solo toast Windows di fine turno viene omesso quando la chat è quella
aperta nella finestra principale **e** la finestra è a fuoco: l'utente sta già
vedendo la risposta. In tray, minimizzata o su un'altra chat la notifica arriva
normalmente. Gli eventi Firestore sono inoltrati a FCM da
`../functions/completionPush`. Le approvazioni in attesa producono una notifica
con apertura della conversazione sul telefono.

Durante il turno `run_chat` emette `live-turn` (running/terminal) e il gateway
pubblica `users/{uid}/devices/{id}/live_turns/{conversation_id}`: testo parziale,
reasoning e activity aggiornati al massimo una volta al secondo, con heartbeat
ogni 5 secondi. I documenti terminati vengono eliminati dopo 60 secondi. Il
telefono ignora gli stati più vecchi di 20 secondi, così un arresto del desktop
non lascia loader permanenti. La scrittura è troncata per restare sotto il limite
Firestore e non tocca `conversations/{id}`, che conserva le precondizioni di
versione del salvataggio cronologia.

Stato esterno: regole limitate al proprietario pubblicate dall'utente e isolamento
verificato con 403 su un percorso valido di un altro UID. Il gateway disabilita
il controllo remoto se manca l'isolamento. Blaze è stato abilitato dall'utente
per distribuire la Cloud Function. Dettagli in
`../mobile/README.md`; nessuna regola o indice viene distribuito dal repository.

Verifiche: 37 test Rust locali; test UI auth/chat/background; CRUD reale della
cronologia con conservazione di config/window/albero originale, inclusa la
preservazione della cronologia durante refresh; trasporto reale Firestore con
claim atomico e duplicato rifiutato. Il login Android è stato poi verificato, insieme a push reali in background e dopo
chiusura del processo, apertura della chat da push e notifica Windows nella
cronologia di sistema. Il giro completo Android/Firestore/Windows/modello/Android
è riuscito con la risposta di verifica `ANDROID_REMOTE_OK_20261017_2348`.

Le notifiche Windows richiedono l'app installata (limite del plugin Tauri), non
il solo eseguibile di sviluppo. Con una build debug installata, il test reale
opt-in `AURACHAT_NOTIFICATION_SMOKE=1` invia una notifica di prova dopo cinque
secondi e pubblica il corrispondente evento Firestore. Il hook non è compilato
nelle build release.


Verifica installer Windows: spostata la risoluzione di MAINBINARYSRCPATH dentro
NSIS_HOOK_POSTINSTALL, dopo le definizioni di Tauri. Prima veniva incorporato
l'eseguibile come DirectML.dll e l'app installata falliva con 0xc000007b.
DLL installata verificata per hash e avvio reale riuscito. Il gateway usa una
sola istanza e conserva su disco le notifiche ancora da pubblicare per ogni UID.

Cloud Function `completionPush` attiva dal 18 ottobre 2026 in europe-west3.
Invio automatico verificato con HTTP 204 e pubblicazione su Android. Nessuna
istanza sempre accesa; 256 MiB/CPU frazionaria, max 3 istanze e build eliminate
dopo un giorno. Le notifiche di fine risposta mostrano titolo della chat e primi
200 caratteri della risposta, uguali su Windows e telefono.

## Skill e stato dei processi — 18 ottobre 2026

Il compositore mostra un catalogo `/` di skill globali e del progetto corrente,
con frecce/Invio/Escape, caricamento, duplicati, errori e riprova.
Le globali sono disponibili anche nelle chat libere: per esempio `/impeccable`
carica l'Impeccable presente nella home dell'utente. `project_skills` resta
autenticato; le skill di progetto richiedono root gia concesse.
Discovery in `.agents/skills`, `.codex/skills`, `.aurachat/skills`,
`.claude/skills`, `.cursor/skills`, `.github/skills` e `.copilot/skills`,
sia nella home sia nelle root autorizzate:
200 entry per ambito, SKILL.md UTF-8 fino a 32 KiB. Alias dello stesso file
canonico non sono duplicati; per `/nome` il progetto precede la globale.
Duplicati distinti nello stesso ambito richiedono una scelta esplicita per id.
`list_project_skills`, `load_project_skill` e `read_skill_resource` sono tool
reali, disponibili anche ai subagenti. `/nome` carica la skill prima
dell'inferenza e registra l'attivita. I riferimenti UTF-8 fino a 128 KiB sono
leggibili solo dentro la directory della skill, senza traversal/link esterni.
I permessi su file e comandi non cambiano: leggere una skill globale non
autorizza comandi, script o altre cartelle nelle chat libere.

**Impostazioni > Skill** elenca globali e progetto selezionato, con ricerca
locale e interruttori attivi per impostazione predefinita. Le disattivazioni
sono salvate su questo PC, separate per account in
`<app_config_dir>\skills\<SHA-256 UID>.json`; non toccano altri editor e bloccano
catalogo, caricamento slash/tool e riferimenti nei richiami successivi.
Non cancellano istruzioni gia caricate nella conversazione o nei turni avviati.
Una skill di progetto disattivata non ripiega silenziosamente su un'omonima globale.

Il pulsante **Cerca su skills.sh** invia solo la query al catalogo pubblico,
senza lanciare npx a ogni ricerca. Ogni risultato mostra nome e repository;
**Installa** chiede conferma prima di eseguire
`npx --yes skills add owner/repo --skill nome --global --agent codex --yes`.
Sono necessari Node.js 22.20+ e Git; la skill e globale per l'utente del PC,
quindi disponibile anche negli editor compatibili, non isolata per account AuraChat.
Il CLI viene scaricato da npm, la sorgente da GitHub; installare solo repository
affidabili. Telemetria del CLI disabilitata. Argomenti validati, niente sorgenti
shell arbitrarie, una sola installazione per volta, timeout 180 secondi e
verifica del catalogo dopo l'uscita: gli errori non diventano successi.
Un timeout puo lasciare file parziali: aggiornare prima di riprovare.
L'app non aggiorna/sovrascrive automaticamente skill gia presenti e non le disinstalla.

Il companion Android usa lo stesso catalogo e le stesse preferenze del PC scelto.
Protocollo 4: `global_skills` serve le chat libere; `skills_catalog`,
`skill_enabled`, `skills_search` e `skill_install` usano richieste autenticate
al desktop. Il telefono non esegue npx e non legge la propria home.
L'installazione richiede conferma esplicita anche nel protocollo remoto.
Il menu `...` del dettaglio chat mobile offre rinomina, copia ed eliminazione,
non Nuova chat. Le mutazioni sono bloccate durante i turni; eliminazione con
conferma e controllo di titolo/timestamp per non cancellare una chat cambiata
dopo l'anteprima. Salvano lo stesso albero Firestore del desktop.

Un tool shell che restituisce un processo running rimane running; gli eventi
shell aggiornano stato/output e non rilanciano comandi. Fermare il turno
cancella agenti figli e shell della stessa conversazione e conserva gli stati
terminali nella cronologia. Il telefono può fermare singoli agenti o comandi.

Il filtro di visibilità riguarda il solo toast Windows: l’evento push è
comunque pubblicato. La precedente soppressione comune impediva le push
mentre il desktop mostrava la chat; corretta in questa sessione.
