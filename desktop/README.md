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
- **Finestra settings** (`base_url`, `model`, `api_key`) riapribile dalla rotella
  nella barra del titolo. La key non torna mai nella UI: il backend espone solo
  `api_key_set: true/false`.
- **Chat**: invia la cronologia della conversazione attiva a `<base_url>/v1/chat/completions`
  (formato OpenAI-compatible, streaming SSE) e mostra la risposta.
- **Logo Auralisys** come icona della finestra e del tray.

La persistenza Firestore usa `users/{uid}`: `config`, `tree` e `window` sono mappe native,
con aggiornamenti separati che preservano gli altri campi. Il vecchio `config`
JSON stringificato resta leggibile; il database di sviluppo e stato migrato
il 17 ottobre 2026, con backup locale e rimozione di `data/tree`. Le regole remote
vanno limitate al proprietario UID dalla console (vedi vault).

## Cosa NON fa (scope 3–4, non ancora implementati)

Pairing (codice/QR), relay e push FCM. Le chat di progetto possono leggere, creare e modificare file ed eseguire comandi attraverso i permessi locali descritti sotto.

## Struttura

### Card attività e pannello destro

La card **Output / Agenti / Fonti** compare quando la conversazione contiene messaggi,
allegati o attività. Il pulsante nell'intestazione la nasconde e la riapre. Su desktop
l'ingresso e l'uscita animano anche lo spazio della conversazione; sotto i 1000 px
il pannello si sovrappone alla chat per mantenere leggibile il contenuto. Con
`prefers-reduced-motion` gli spostamenti sono immediati.

Gli **Output** contengono solo artefatti generati (immagini, documenti, file e log
locali), ricevuti con l'evento `artifact-created`. Le normali risposte dell'assistente
non sono output della card. Le **Fonti** contengono gli allegati dell'utente e i link
HTTP(S) nei suoi messaggi; le letture del progetto e i link citati dal modello non
sono fonti. `user-source` permette a un'integrazione nativa di aggiungere screenshot
o altre risorse effettivamente fornite dall'utente.

I due eventi usano `{conversation_id, id, title, kind, summary?, content?, url?, path?}`.
`kind: image` abilita l'anteprima; `document` abilita Markdown sanificato; gli altri
contenuti sono testo inerte. Le immagini accettano URL HTTP(S) o data URL raster
PNG/JPEG/WebP/GIF. I percorsi locali sono mostrati come riferimento; non sono eseguiti.
Gli artefatti e le fonti ricevuti tramite eventi durano per la sessione. Allegati e
link nei messaggi si ricostruiscono dalla cronologia salvata. Il selettore allegati
attuale accetta ancora solo file testuali: questa UI non abilita l'upload multimodale
né una pipeline di generazione immagini/file.

La sezione **Shell** compare quando esistono esecuzioni attive. Il dettaglio mostra
comando, directory, log in tempo reale, stato e codice di uscita, con stop e gestione
dell'errore. I log conclusi restano consultabili finché il pannello Shell è aperto;
chiudendolo, la sezione scompare se non ci sono più processi attivi.

`managed_shells::Shells` registra processi già avviati da un runner nativo tramite
`track(uid, conversation_id, command, cwd, child, notify)`. Il runner passa stdout e
stderr piped e inoltra gli snapshot con `app.emit("shell-activity", snapshot)` nella
callback. `list_shells` recupera gli snapshot al cambio conversazione; `stop_shell`
accetta soltanto un ID registrato che appartiene all'utente e alla conversazione.
Su Windows termina anche i discendenti; lo stop non richiede rete. Le revisioni
degli snapshot impediscono che aggiornamenti tardivi ripristinino stati vecchi.
Il registro conserva al massimo gli ultimi 128 KiB di log per processo e chiude
le esecuzioni all'uscita dell'app.

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

Verifica: `node tests/activity-panel.cjs` con Playwright in `NODE_PATH` (servizi
nativi simulati). Le immagini di verifica sono in `../.artifact/activity/`.

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

Questi valori vivono solo in `src-tauri/src/config.rs`, non nella UI.

## Icone

`src-tauri/icons/` contiene PNG/ICO derivate da `assets/logo-auralisys.svg`.
Per rigenerarle: `cargo tauri icon ../assets/logo-auralisys.svg` (o lo script
una-tantum usato per crearle).

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
Il primo uso carica i pesi in memoria; su CPU i tempi dipendono dall'hardware.
Il registratore AudioWorklet cattura mono, ricampiona a 16 kHz e conserva l'audio
solo in memoria. Limite due minuti, inferenza in blocchi fino a 30 secondi.
La lingua segue italiano/inglese dell'interfaccia. Registrazione con forma
 d'onda: X scarta solo l'audio; Stop trascrive senza inviare; Invio trascrive e
invia insieme al testo già scritto e agli allegati. Cambiare chat scarta i
risultati tardivi; tutte le tracce del microfono vengono chiuse. Annullare mentre
il motore elabora scarta il risultato; il blocco CPU in corso può terminare.

Le chat di progetto espongono al modello `list_project_files` e
`read_project_file`, con ID root, percorsi relativi, controllo canonico anche
su link/junction, limiti di dimensione per singolo file. L’esplorazione prosegue fino alla risposta del modello, senza soglie arbitrarie sul numero di passaggi o sul totale letto. Vengono consultati
solo i consensi locali dell'utente/progetto e le cartelle ancora collegate.
I file letti per la richiesta vengono inviati al provider LLM configurato;
non avviene scansione o caricamento automatico dell'intera root. Le modifiche verificano la revisione del file e i comandi passano dal controllo
permessi. Solo Accesso completo abilita percorsi assoluti esterni. Il provider
deve supportare tool calling.

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
Gli artefatti file sono mostrati in Output e ricostruiti dalle attività salvate.

I sub-agenti usano il modello e i permessi del progetto, senza nuove autorizzazioni.
Il pannello conserva il testo progressivo, il reasoning effettivamente restituito
dal provider, le operazioni e il loro esito. Interrompi agente annulla le richieste
HTTP in attesa, impedisce nuove operazioni e arresta le sue shell registrate.
Le attività terminali non vengono riattivate da eventi tardivi.

Lo streaming aggiorna nodi stabili: i dettagli aperti e il focus non vengono
ricreati a ogni frammento. Lo shimmer segnala soltanto lavoro attivo; l'attesa di
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
