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
- mostrare un **codice/QR di pairing** per associare il telefono;
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

## Non ancora deciso

- **Scrittura, esecuzione, modalità automatiche ed effort**: non implementati.
  I soli strumenti già operativi sono esplorazione e lettura delle root autorizzate,
  descritti sotto. Non equipararli a un agente con accesso completo al computer.

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
