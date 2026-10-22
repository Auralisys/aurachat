---
tags: [aurachat, client, tauri, rust]
---

# Desktop gateway — Tauri

← [[Client - Overview]]

App desktop in **Tauri (Rust + frontend web)** con chat e gateway locale.
Il processo resta attivo nel tray; il frontend statico comunica con Rust via IPC.

## Responsabilità

- possedere la API key e la configurazione (`base_url`, `model`, `api_key`), da
  impostazioni locali, mai dal codice;
- chiamare il LLM via HTTP all'endpoint OpenAI-compatible
  `<base_url>/v1/chat/completions`;
- ascoltare Firestore per i prompt in arrivo dal telefono e scrivere le risposte;
- accettare dal telefono comandi di cambio endpoint/modello (la key resta
  locale);
- associare il telefono con lo stesso account email/password; il pairing con
  codice/QR del piano iniziale è stato sostituito;
- stare nel system tray e girare in background.

## Vincoli

- **Firestore da Rust non ha SDK ufficiale**: usare la REST API di Firestore o
  il crate `google-cloud-firestore`. Non aggiungere dipendenze solo per
  comodità senza verificarne la manutenzione.
- La push **non** parte dal desktop: il desktop scrive solo su Firestore; la
  notifica la manda la Cloud Function (vedi [[Firebase - trasporto e push]]).
- La key non deve mai finire nei log o negli errori. Decisione 17 ottobre 2026:
  la key e la lista modelli sono salvate nel documento utente Firestore (vedi
  [[Firebase - trasporto e push]]).

## Permessi e operazioni locali — 17 ottobre 2026

Il selettore a sinistra del composer, accanto al +, salva la modalità per
account e progetto: Richiedi approvazione (default), Approva per me e Accesso
completo. Il backend conferma il cambio; full access richiede conferma iniziale.
Il cambio attende che le chat del progetto siano ferme.

Le approvazioni inline sono associate ad account, chat, turno e agente,
monouso, con revisioni monotone e scadenza di dieci minuti. Il diniego non è
ritentabile identico nello stesso turno. Il reviewer automatico è una chiamata
separata al modello: solo JSON valido con allow e rischio low autorizza;
errori e azioni ambigue passano al consenso umano. I token sono conteggiati.

Gli strumenti file richiedono revisione SHA-256 o contenuto precedente;
le sostituzioni puntuali devono essere univoche. Percorso e contenuto sono
ricontrollati dopo l'approvazione. I sub-agenti ereditano modello e permessi,
mantengono reasoning e operazioni e possono essere fermati cancellando le
richieste HTTP e le shell registrate. Gli eventi tardivi non riattivano stati
terminali. Le attività salvate ricostruiscono gli output file.

**Limite effettivo:** le shell usano l'account Windows senza sandbox OS.
La directory di lavoro non limita accesso a file e rete; root autorizzate e
reviewer non sostituiscono isolamento di sistema. Accesso completo consente
operazioni anche fuori dal progetto. SSH e controllo tra dispositivi restano
da implementare. Riferimento esterno e differenze: [[ChatGPT desktop - Analisi locale]].

Codice: `desktop/src-tauri/src/project_files.rs:37` (operazioni file),
`desktop/src-tauri/src/approvals.rs:25` (richieste di consenso),
`desktop/src-tauri/src/agent_runs.rs:21` (ciclo sub-agenti).
Verifiche del 17 ottobre: 32 test Rust passati, quattro prove con servizi
reali escluse dalla suite predefinita; 13 suite UI passate con servizi nativi
simulati. Test HTTP dei sub-agenti con provider locale e file reali;
test shell con processi reali. Account/provider esterni, microfono fisico
e dialoghi WebView non verificati nuovamente in questa sessione.

## Turni live e notifiche selettive — 18 ottobre 2026

`run_chat` emette `live-turn` con `turn_id` all'avvio e alla fine di ogni turno,
anche per le richieste che arrivano dal telefono. In `companion.rs` tre listener
(`live-turn`, `chat-progress`, `agent-activity`) alimentano uno stato per
conversazione; un task ogni secondo pubblica con `relay_upsert`
`users/{uid}/devices/{device}/live_turns/{conversation_id}` con testo parziale,
reasoning, activity, `user_content` e timestamp. Scritture coalescenti
(~1/s), heartbeat ogni 5 s, campi e lista attività troncati, eliminazione dei
documenti terminali dopo 60 s. Un `turn_id` diverso non può sovrascrivere o
chiudere il turno realmente in corso; gli stati con UID sconosciuto vengono
pubblicati sotto la sessione corrente. Il percorso è separato da
`conversations/{id}` per non interferire con le precondizioni di versione.

Il backend conosce la chat aperta tramite il comando `set_viewing_chat`, chiamato
da `openConversation`/`clearChat`. Il toast Windows di fine turno viene soppresso solo se quella chat è aperta
**e** la finestra
principale è a fuoco; tray, minimizzata, finestra non a fuoco o altra chat
notificano normalmente. La push FCM viene sempre pubblicata, indipendentemente
dal focus Windows. Le richieste di approvazione non vengono mai soppresse.
`logout` azzera la chat osservata. Test Rust puro su `viewing_match` e sul
reducer live.

## Decisioni (17 ottobre 2026)

- Il frontend desktop non è più solo settings/pairing: include una **chat ricca**
  con sidebar e cronologia organizzata in **progetti → conversazioni** e chat personali,
  selezione del modello, conteggio token/contesto, loader/timer e i18n it/en.
- La **cronologia** è persistita su **Firestore v2**: riepiloghi e riferimenti nella
  mappa `users/{uid}.tree`, conversazioni e messaggi nelle subcollection per UID.
  Caricamento dei messaggi all’apertura della chat; migrazione reale con backup
  completata. Vedi [[Firebase - trasporto e push]].
- La **configurazione utente** (key LLM + lista modelli + modello attivo) è
  salvata nel documento Firestore `users/{uid}` (vedi [[Firebase - trasporto e push]]);
  in locale restano bootstrap pubblico, email, uid e refresh token; la password
  non viene più serializzata. Vedi [[Account - Login e ripristino sessione]].
- Auth Firestore: **email/password** via REST API (Identity Toolkit), nessun SDK.

## Refactor UI (17 ottobre 2026)

La shell ha una barra stretta persistente (Home, impostazioni, avatar), una barra
superiore con navigazione e menu e un pannello arrotondato che contiene sidebar
progetti/recenti e chat. Nuova chat centrale con scelta facoltativa del progetto;
le chat senza progetto sono salvate in `ChatData.conversations`, con default per
leggere i vecchi alberi. Superfici flat e sfondo viola statico mantenuti.
Dettagli verificati, schermate e limiti in
[[UI desktop - Refactor flat]].

## Correzione account e autologin (17 ottobre 2026)

Login separato dalla configurazione iniziale, ripristino sessione tramite refresh
token, password non più salvata, configurazione LLM recuperata dal documento
utente. Gli errori di rete non riaprono il primo avvio. Stato e verifiche in
[[Account - Login e ripristino sessione]].


## Lettura dei progetti — stato aggiornato 17 ottobre 2026

Le chat associate a un progetto espongono `list_project_files` e
`read_project_file` al modello configurato. Il contesto indica le root locali
consentite e quelle collegate ma ancora da autorizzare. Il consenso è locale,
per UID e progetto; un percorso letto da Firestore non concede accesso al disco.
L'accesso verifica il percorso canonico e blocca traversal, symlink e junction
che escono dalla root. I file pertinenti alla richiesta vengono forniti al
provider configurato; il modello deve supportare tool calling.

Corretto il blocco segnalato leggendo il vault del progetto Centro cinofilo:
`project tool limit reached; narrow the request`. L'app interrompeva la richiesta
dopo otto passaggi. Rimossi sia il numero fisso di passaggi sia il tetto
cumulativo di 512 KiB e il limite di otto chiamate nel singolo batch. Il ciclo
prosegue fino alla risposta del modello, senza sostituirla con un riassunto
parziale imposto dall'app. Restano i limiti per singolo file: UTF-8, 128 KiB,
massimo 400 righe per lettura. Le cartelle restituiscono fino a 200 voci.
Restano inoltre i limiti di contesto e gli eventuali errori del provider.

Riferimenti verificati: `desktop/src-tauri/src/llm.rs:73` (ciclo modello/tool),
`desktop/src-tauri/src/project_files.rs:12` (perimetro di accesso),
`desktop/src-tauri/src/project_files.rs:22` (esplorazione e lettura).
La UI mostra il file o la cartella in lettura durante l'elaborazione.

Verifiche: test del provider reale con fixture locale passato; test di regressione
`project_reads_continue_past_eight_rounds_and_512_kib` passato con nove passaggi
di lettura, oltre 512 KiB e risposta finale. Suite Rust: 20 test passati,
quattro verifiche reali escluse dalla suite predefinita ed eseguite separatamente
nel lavoro precedente. La lettura completa del vault Centro cinofilo non è stata
ripetuta dall'agente dopo questa correzione. Riavviare il debug per applicarla;
una vecchia istanza aperta continua a eseguire il codice precedente.

## Voce locale

Cohere Transcribe INT4, scaricabile in Impostazioni → Voce (~2 GB), con verifica
SHA-256 e download riprendibile. Inferenza locale su CPU; audio solo in memoria,
mono a 16 kHz, massimo due minuti. Stop trascrive nella bozza; Invio trascrive e
invia insieme a testo e allegati; X scarta la registrazione. La forma d'onda
avanza di una barretta ogni 100 ms, indipendentemente dalla frequenza del
microfono (circa 12,5 volte più lenta della versione iniziale a 16 kHz).
Dettagli UI in [[UI desktop - Refactor flat]]. Test browser con AudioWorklet
reale e microfono simulato; trascrizione CPU di un campione pubblico verificata.
Il microfono fisico e il dialogo permessi del WebView restano da provare manualmente.

## Output finali e Git — 21 ottobre 2026

La sidebar mostra **Cambiamenti +N −N** sopra **Output**. Solo
`publish_project_output` pubblica un file finale, con `final_output: true`:
scritture sorgente, script e note temporanee non compaiono automaticamente.
Nessuna blacklist di estensioni: Markdown e script richiesti come deliverable
restano pubblicabili. Le pubblicazioni si ricostruiscono anche dai sub-agenti.

Il menu Cambiamenti offre Commit, Commit e push e dettaglio completo. Il dettaglio
separa stage reale/non staged, con azioni +/− e operazioni su tutto il gruppo.
Nel gruppo Non staged, cestino per singolo file e Scarta tutti richiedono conferma
con l'elenco dei file. Il ripristino usa l'indice corrente: lo stage, anche
parziale, resta intatto. I file nuovi non tracciati selezionati vengono eliminati
definitivamente senza Cestino; nessuna cancellazione ricorsiva o di file ignorati.
Contenuti/indice/HEAD/branch cambiati invalidano la conferma; errori rileggono
lo stato reale e segnalano eventuali operazioni parziali. Link/junction,
submodule e file oltre 2 MiB vanno gestiti esternamente. Evitare editor concorrenti:
il controllo prima dell'azione non rende atomico il working tree.
Il commit usa esclusivamente l'indice esistente, preserva le modifiche non staged
e richiede conferma; il modello genera un messaggio modificabile dal solo diff.
Push separato con destinazione esplicita e nessuna operazione forzata.
Revisioni dell'indice/HEAD/branch invalidano le anteprime obsolete.

Stage/unstage spostano immediatamente i file con **In corso…** senza bloccare
gli altri controlli; i clic sono accodati e confermati in ordine. Git restituisce
la nuova revisione senza ripetere tutte le statistiche. La riconciliazione finale
ripristina anche le modifiche parzialmente staged; errori espliciti interrompono
la coda e ricaricano lo stato reale. Poll locale ogni 2 secondi e invalidazione
sulle scritture del modello. Dettagli/limiti in `desktop/README.md`.

## Musica durante la dettatura — 21 ottobre 2026

Le API Media Control di Windows sospendono soltanto le sessioni già in
riproduzione. Nessun tasto globale play/pausa: lettori inizialmente fermi non
vengono avviati. Ripresa a registrazione conclusa, prima dell'inferenza, anche
su annullamento, cambio chat, logout e chiusura nel tray; uscita normale con
pulizia nativa. Riprendono solo le sessioni sospese da quella registrazione,
ancora in pausa sullo stesso brano. Un arresto forzato non può eseguire la pulizia.
Spotify è stato provato e confermato funzionante dall'utente. La trascrizione
non pubblica più notifiche desktop o push; gli errori restano nel compositore.

## Provider e correzione dettatura — 17 ottobre 2026

La configurazione supporta più provider, chiavi indipendenti e modelli/endpoint
modificabili; dettagli e migrazione in [[Impostazioni e provider di modelli]].

Risolta l’apertura delle impostazioni al secondo tentativo di dettatura quando
il modello era occupato: busy produce un messaggio in chat, non viene confuso
con il modello mancante. Prima del microfono, prepare_speech_model verifica e
carica il modello, mostrando uno stato di preparazione; poi l’istanza è riusata.
SHA-256 è ottimizzato anche nelle build di sviluppo, mantenendo la verifica
completa. Prima la prima trascrizione eseguiva la verifica dei 2 GB dopo Stop,
senza distinguerla dal riconoscimento.

La UI conserva l’operazione nativa pendente anche quando si annulla o si cambia
chat: scarta il risultato tardivo e impedisce una seconda acquisizione finché
l’elaborazione termina. Un blocco ONNX già in corso non viene interrotto a forza.
Codice: desktop/src-tauri/src/speech.rs:123 e :132;
desktop/src-tauri/src/lib.rs:80; desktop/ui/voice.js:3, :109 e :166.

Verifica reale locale con campione pubblico JFK: preparazione circa 2,95 s,
prima trascrizione 1,98 s, seconda 1,96 s, stesso testo atteso e modello ancora
ready/non busy. Tempi del campione sul computer di prova, non una garanzia per
qualsiasi registrazione. Test voice-flow.cjs passato con AudioWorklet reale e
microfono simulato, inclusi modello occupato, annullamento della preparazione,
errore di inferenza, recupero e risultati tardivi. Microfono fisico non verificato.
Suite nativa: 35 test passati, quattro verifiche reali escluse dal comando
predefinito; la verifica vocale è stata eseguita separatamente con esito positivo.

## Preparazione del modello all'avvio — 17 ottobre 2026

Prima il modello veniva verificato e caricato solo al primo click sul microfono:
durante quella finestra non si distingueva il caricamento dall'occupato o
dall'annullamento. Ora il caricamento parte da solo all'apertura dell'app e il
microfono mostra il proprio stato.

`ModelStatus` espone `loading` e `loaded` oltre a `ready`/`busy`, letti senza
lock e sempre disponibili (`speech.rs:16`, `speech.rs:41`). Un guard RAII
`Loading` copre tutta la finestra lenta — hash SHA-256 dei file e
`CohereModel::load` — non solo il termine (`speech.rs:29`, `speech.rs:130`).
`prepare()` esce subito se il modello è già in memoria, senza occupare `busy`
(`speech.rs:141`); `remove()` azzera `loaded` (`speech.rs:114`).
`prepare_speech_model` emette `speech-model-progress` anche al termine
(`lib.rs:82`), così la UI si riallinea a operazione conclusa.

All'avvio `warmSpeechModel()` verifica lo stato e, se il modello è installato ma
non caricato, invoca `prepare_speech_model` senza bloccare la chat
(`ui/voice.js:45`, `ui/voice.js:251`); lo stesso richiamo segue un download
completato (`ui/voice.js:238`). Finché carica, il microfono è disabilitato con un
loader sull'icona e l'etichetta "Preparazione del modello locale…"; un click
anticipato non produce nulla (`ui/voice.js:66`). In Impostazioni → Voce compaiono
tre stati: preparazione, "Installato · caricato in memoria" (`voice.loaded`) e
"Installato · pronto per la dettatura"; download e rimozione restano disabilitati
durante il caricamento (`ui/voice.js:28`). Dettagli visivi in
[[UI desktop - Refactor flat]]; limiti in [[Problemi noti]].

## Skill e cancellazione figli — 18 ottobre 2026

Tool `list_project_skills`/`load_project_skill`, catalogo autenticato
`project_skills` e menu slash nel composer. Solo root già autorizzate e file
SKILL.md nei percorsi standard del progetto; skill e risorse non ampliano
i permessi. Invocazione esplicita `/nome` registrata nella cronologia.

I processi mantengono il loro stato reale finché non terminano; gli snapshot
shell aggiornano anche la cronologia in streaming. Stop del turno cancella
agenti figli e processi della stessa chat, senza toccare altre conversazioni.
Il telefono può interrompere singoli agenti e shell attraverso ID registrati.

## Trascrizione remota e coda interattiva — 18 ottobre 2026

L'heartbeat del dispositivo pubblica anche `speech` con `ready`, `busy` e
`loading`, così il telefono sa se il modello Cohere è installato e libero prima
di registrare. La nuova azione companion `transcribe` legge le parti audio dalla
collezione `requests` tramite `relay_get`, le decodifica da base64 e ricompone il
WAV in memoria; `speech::transcribe_wav` valida il file 16 kHz mono 16-bit, lo
scrive in una cartella temporanea, carica i campioni con `read_wav_samples` e usa
lo stesso `Speech::transcribe` del desktop. Limite remoto 4 MB (due minuti);
l'`account_lock` viene rilasciato prima dell'inferenza. `execute` ora restituisce
un `Value`: il poll scrive `result` nella richiesta insieme a `completed`, e il
telefono legge `result.text`. Il risultato non viene incluso per le azioni che
non lo producono. Aggiunte le dipendenze `base64` e il test che rifiuta audio non
WAV/troppo grande (`cargo check --tests` verde; l'esecuzione della suite in
questo ambiente si ferma sulla DLL ONNX Runtime).

La bolla della coda desktop non ha più i pulsanti inline: mostra **In coda** e un
menu a tre puntini con **Manda subito**, **Modifica** e **Cancella**. Manda subito
usa `steer_chat` se un turno è in corso, altrimenti sposta la bozza in testa e
chiama `flushQueue`. Modifica rimuove la bozza e la riporta nel composer con gli
allegati; l'editor inline e il relativo lock sono stati eliminati. `flushQueue`
riparte dopo completed **e** dopo cancelled/stopped, mentre solo un failure
sconosciuto mette in pausa. Un invio manuale con coda già presente viene accodato
dopo i draft esistenti. `requestChat` non semina più un turno di background con i
messaggi della chat attiva e non sostituisce `state.messages` se la conversazione
non è quella aperta. Il listener `companion-updated` fa ripartire la coda locale
quando un turno avviato da un altro dispositivo termina.

## Finestra, MCP e strumenti di progetto — 22 ottobre 2026

**Controlli finestra e Git annidato** (`d440cf0`). Su Windows i pulsanti
riduci/ingrandisci/chiudi tornano nativi (prima erano custom e mancava
ingrandisci). Se la cartella aperta non è un repository, `git.rs` cerca i
repository nelle sottocartelle invece di mostrare l'errore "not a git repository".

**MCP generali** (`d440cf0`, `1a8907c`, `6e66ffe`). Il modello può usare gli
strumenti di qualsiasi server MCP configurato (`mcp.rs`), non solo quelli
predefiniti. Prima di dire che manca uno strumento cerca i server già configurati
negli altri client (configurazioni globali, con i segreti oscurati) e può
importarne uno alla volta con approvazione (`import_mcp_server`, `mcp.rs:103`).
Il prompt distingue le API MCP di un servizio (es. Crashlytics) dall'accesso alla
console via browser e dai comandi CLI non aggiornati. Letture web e chiamate MCP
seguono la modalità permessi della chat (Completo/Auto/Chiedi); solo la scrittura
della configurazione MCP globale chiede sempre conferma. Gli stessi strumenti
valgono per le chat avviate dal telefono.

**Pannello attività** (`6e66ffe`). Le fonti web hanno l'icona globo e si aprono
con un clic; Shell elenca solo processi attivi o in background.

**Notifiche** (`3a76e4f`). Il clic su una notifica desktop porta l'app in primo
piano e apre la chat corrispondente.

**Strumenti file e skill** (`97ed72c`, `f2b0264`). `edit_project_file`
(`project_files.rs:301`) accetta `old_text` con LF anche su file CRLF e conserva
il fine riga del file: prima il modello ripiegava su script PowerShell lunghi e
costosi per modifiche di due righe. Aggiunti `search_project_files` e la lettura
dei file grandi per intervalli di righe; dalle modifiche vengono tolti i prefissi
di numero riga copiati dalla lettura. Le skill sono accettate fino a 128 KiB e
quelle installate in più cartelle agente compaiono una volta sola.

**Progetti multi-repo** (`758932a`). Riepilogo, sidebar e pannello cambiamenti
selezionano il repository con più modifiche, a meno che l'utente ne abbia scelto
uno a mano (`manualRoot`, `ui/git.js:2`).

**Icone per piattaforma** (`43632d8`). Windows usa il logo lavanda trasparente;
macOS usa la versione con sfondo scuro come l'app mobile.

## Dettatura, coda e sidebar — 22 ottobre 2026

**Dettatura** (`8b21617`). Dopo l'invio dell'audio `voice.status`
(`ui/voice.js:83`) resta visibile finché la trascrizione è in corso, con tre
puntini animati e testo shimmer; con riduzione movimento l'animazione è
disattivata. Test in `tests/voice-flow.cjs`.

**Domande interattive** (`d179cad`). `Question::normalize` sostituisce trattini
lunghi con `-` in domande e opzioni (`plain_dashes`, `questions.rs:26`).

**Coda: Manda subito** (`d179cad`). Con un turno in corso il messaggio inviato
tramite `steer_chat` compare come normale messaggio utente
(`chat-progress.js:218`) invece di sparire; "Messaggio in coda" si azzera quando
la coda è vuota (`clearQueuedStatus`, `queue.js:17`).

**Sidebar** (`77c9511`). Una chat in attesa di risposta dell'utente mostra un
pallino giallo da 8 px (`styles.css:554`, `app.js:519`) al posto dell'icona che
veniva tagliata; il pallino viola resta per i messaggi non letti.

Script di build e installazione: [[Build e distribuzione]].
