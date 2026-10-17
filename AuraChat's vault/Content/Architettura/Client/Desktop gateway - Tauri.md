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
da `openConversation`/`clearChat`. La notifica di fine turno (toast Windows e
push FCM) viene soppressa solo se quella chat è aperta **e** la finestra
principale è a fuoco; tray, minimizzata, finestra non a fuoco o altra chat
notificano normalmente. Le richieste di approvazione non vengono mai soppresse.
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
