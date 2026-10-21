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

La card **Artefatti / Agenti / Fonti** (più la sezione **Shell** quando serve) compare
quando la conversazione contiene messaggi, allegati o attività. Il pulsante
nell'intestazione la nasconde e la riapre. Su desktop l'ingresso e l'uscita animano
anche lo spazio della conversazione; sotto i 1000 px il pannello si sovrappone alla
chat per mantenere leggibile il contenuto. Con `prefers-reduced-motion` gli
spostamenti sono immediati.

Gli **Artefatti** sono solo ciò che il modello ha prodotto: immagini, documenti,
codice, dati, log e file scritti nel progetto. Le risposte in prosa, i ragionamenti e
gli output grezzi degli strumenti non entrano nella lista: un evento
`artifact-created` senza `path` e senza `url` viene scartato, a meno che il `kind` sia
`image` o `document`. Ogni riga mostra il tipo con icona o miniatura, l'azione
(`write_project_file` crea, `edit_project_file` aggiorna), la dimensione e il
sub-agente che l'ha prodotto; il pannello aggiunge i filtri per tipo con i conteggi,
così molti file di testo non nascondono le immagini. Le scritture del turno attivo
compaiono subito come «In creazione…» e diventano artefatti quando lo strumento
completa, senza duplicati per nome file.

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
Con il modello installato la verifica SHA-256 e il caricamento dei pesi partono da soli all'apertura dell'app: il microfono mostra un loader sull'icona, resta disabilitato finché il modello non è in memoria e diventa utilizzabile subito dopo. Impostazioni → Voce espone lo stesso stato (“Preparazione del modello locale…”), quindi non serve più cliccare il microfono per scoprirlo; su CPU i tempi dipendono dall'hardware.
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
Gli artefatti file sono mostrati in Artefatti e ricostruiti dalle attività salvate.

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

Il compositore mostra un catalogo `/` per il progetto corrente; tastiera
(frecce/Invio/Escape), stato di caricamento, duplicati ed errori hanno feedback
esplicito. `project_skills` è autenticato e legge solo root già concesse.
`list_project_skills` e `load_project_skill` sono tool reali del modello;
`/nome` carica la skill prima dell’inferenza e registra l’attività. Discovery
in `.agents/skills`, `.codex/skills` e `.aurachat/skills`, budget globale di
200 entry, file fino a 32 KiB. I permessi restano quelli del progetto.

Un tool shell che restituisce un processo running rimane running; gli eventi
shell aggiornano stato/output e non rilanciano comandi. Fermare il turno
cancella agenti figli e shell della stessa conversazione e conserva gli stati
terminali nella cronologia. Il telefono può fermare singoli agenti o comandi.

Il filtro di visibilità riguarda il solo toast Windows: l’evento push è
comunque pubblicato. La precedente soppressione comune impediva le push
mentre il desktop mostrava la chat; corretta in questa sessione.
