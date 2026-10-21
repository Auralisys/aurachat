---
tags: [aurachat, backend, firebase, firestore, fcm]
---

# Firebase — trasporto e push

← [[Architettura - Overview]]

## Aggiornamento push — 21 ottobre 2026

`completionPush` (europe-west3, codebase aurachat) scarta gli eventi
`kind: transcription`, anche da desktop precedenti o code locali ritardate.
La funzione aggiornata è stata distribuita. Le altre push conservano UID,
`device_id` e `conversation_id`; nessuna modifica alle regole o ai permessi.
Il mobile conserva questi campi anche nel payload della notifica locale per
il routing dopo avvio/login. Banner foreground solo per sessioni non già
visibili, salvo le approvazioni che notificano sempre. Dettagli correnti:
[[Companion mobile - Flutter]] e `mobile/README.md`; le sezioni datate sotto
documentano le fasi precedenti dello schema.

**Stato: in uso (decisione 17 ottobre 2026).** Progetto `auralisys-chat`,
Firestore abilitato (database `(default)`, `europe-west3`), web app con API key,
account email/password creato e provider abilitato, regole
`allow read, write: if request.auth != null` impostate.

Decisioni:
- **Auth**: email/password (non anonimo).
- **Dati per utente**: un documento `users/{uid}` con tre campi di tipo map:
  - `config`: `api_key`, `models` (mappa nome modello con `base_url` e `model`),
    `active_model`, `firebase_project_id`, `firebase_api_key`.
  - `tree`: `projects` (progetti con `source_folders` e `conversations` dirette) e `conversations`
    (chat senza progetto). Liste e oggetti sono array e mappe Firestore nativi.
  - `window`: `x`, `y`, `width`, `height` (pixel fisici), `maximized`.
    Creato dal primo salvataggio della disposizione dopo spostamento/ridimensionamento.
  Nessun contenitore JSON serializzato come stringa, nessuna collection tree.
  I salvataggi usano `updateMask.fieldPaths` su `config`, `tree` oppure `window`, per
  preservare gli altri campi del documento.
- **Compatibilita**: il vecchio `config` stringificato resta leggibile e diventa
  map al successivo salvataggio. `data/tree` non viene piu letto o scritto:
  non contiene un UID proprietario e non viene importato automaticamente.
  Migrazione remota completata il 17 ottobre 2026: unico account verificato,
  configurazione e cronologia trasferite senza perdita; `data/tree` eliminato.
- **Accesso da Rust**: REST API via `reqwest` (nessun SDK ufficiale).

Firebase risolve due problemi in un solo config: **Firestore** come relay tra
telefono e desktop, **FCM** come push ad app chiusa. È il candidato per un
progetto open source che altri devono far girare: l'onboarding è
"config → funziona", non "installa un server, configurati TLS, tieni su il
daemon".

## Relay (Firestore)

- i due device non si parlano mai direttamente: scrivono e ascoltano documenti
  in una raccolta condivisa, identificata dall'ID di pairing.
- flusso: il telefono scrive un prompt → il desktop ascolta, chiama il LLM,
  scrive la risposta → il telefono ascolta.
- lo schema dei documenti si definisce nello scope 3 della [[Roadmap]], non qui.

## Push (FCM)

- la notifica non parte dal desktop: una **Cloud Function** su
  `onDocumentWritten` invia FCM al token del telefono quando arriva la risposta.
- il telefono registra il suo token FCM alla prima esecuzione e lo associa al
  pairing.
- la funzione si distribuisce con `firebase deploy --only functions`; il repo
  conterrà una cartella `functions/` con la funzione minima.

## Vincoli

- **Regole e indici Firestore gestiti a mano in console**, come da convenzione:
  non generare file di regole/indici se non richiesto.
- La API key LLM è salvata nel documento utente Firestore per decisione
  successiva al piano iniziale; non va copiata nel vault, nel codice o nei log.
  Il desktop la usa per chiamare il modello; relay/push non sono implementati.
- Il client usa il percorso del proprio UID. Le regole permissive indicate
  sopra non garantiscono isolamento: aggiornare manualmente in console la
  regola a `match /users/{uid} { allow read, write: if request.auth != null
  && request.auth.uid == uid; }`, eliminando la regola globale permissiva.
  Non sono state modificate le regole del progetto remoto.
- Tutti i dati nello stesso documento restano soggetti al limite Firestore di
  1 MiB per documento e profondita massima dei campi. La crescita della
  cronologia richiedera una revisione esplicita dello schema.
- free tier Firestore (50K read / 20K write al giorno) e FCM gratis bastano per
  l'uso personale: spiegano perché non serve un backend a pagamento, non sono
  un vincolo di progetto.

## Correzione account e autologin (17 ottobre 2026)

Login separato dalla configurazione iniziale, ripristino sessione tramite refresh
token, password non più salvata, configurazione LLM recuperata dal documento
utente. Gli errori di rete non riaprono il primo avvio. Stato e verifiche in
[[Account - Login e ripristino sessione]].

## Verifica dello schema per utente (17 ottobre 2026)

Cinque test Rust passati: sessione, compatibilita cronologia, conversione
ricorsiva di mappe/array/tipi nativi, configurazione legacy e valori non validi.
Verifiche del codice locali; migrazione remota successivamente completata, vedi sotto.
Riferimenti REST: [Value](https://firebase.google.com/docs/firestore/reference/rest/v1/Value)
e [PATCH](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/patch).

## Migrazione remota completata (17 ottobre 2026, 12:01 Europe/Rome)

Su richiesta esplicita dell'utente, verificato un solo account Firebase Auth e
un solo documento utente, corrispondente alla sessione locale. I campi `config`
e `tree`, prima JSON stringificati, sono ora mappe native nello stesso documento
`users/{uid}`. Un commit atomico con precondizioni sulle versioni ha aggiornato
l'utente ed eliminato `data/tree`, preservando gli altri campi.

Backup originale e rapporto di verifica salvati localmente nella cartella dati
app, `dev.aurachat.desktop/migration-backups/20261017T100151349916Z/`.
Il backup contiene dati e configurazione privata: non copiarlo nel vault o repo.
Contenuto verificato uguale all'originale: 1 progetto, 0 conversazioni.
Lettura remota verificata anche con il token della sessione app, non solo con
credenziali amministrative. Regole remote non modificate.
Script: `desktop/scripts/migrate-firestore-user.py`; verifica conversione e
backup, rifiuta account multipli o conflitti e riconosce lo stato gia migrato.

## Disposizione della finestra per utente (17 ottobre 2026)

La mappa nativa `users/{uid}.window` conserva la posizione e le dimensioni normali
insieme allo stato massimizzato. Gli eventi nativi di movimento/ridimensionamento
aggiornano la geometria; il frontend accorpa gli eventi in un salvataggio dopo
1 secondo di pausa. I salvataggi sono serializzati anche rispetto all'uscita dal
tray. Un errore di rete viene mostrato e il cambio successivo riprova.
Nessuna scrittura delle coordinate nei campi `config` o `tree`.

Avvio: splash 480x320 centrata, dimensione iniziale fissa e non persistita.
Dopo il recupero dell'account, prima di nascondere la splash, viene applicata
la disposizione salvata. Senza salvataggio: 1080x880 logici centrata, ridotta se
necessario allo spazio disponibile. Senza sessione o con rete non disponibile:
finestra standard per login/errore; non si sovrascrive la disposizione remota.
Minimizzare non sostituisce le coordinate normali; massimizzare ne conserva le
dimensioni di ripristino. Monitor scollegati o piu piccoli: finestra riportata
nell'area utile di uno schermo disponibile.

Verifiche: test Rust su geometria, limiti monitor e conversione in map nativa;
`desktop/tests/window-state.cjs` su ordine splash/ripristino, debounce,
salvataggi seriali, errore e recupero. Backend e finestra simulati nei test UI;
il ciclo reale di riapertura del WebView Windows non e stato automatizzato.
La mappa si popola all'uso della nuova versione; nessuna geometria inventata
inserita nel database di sviluppo.

## Progetti con cartelle di lavoro reali (17 ottobre 2026)

Schema precedente (prima della separazione della cronologia v2) di ciascun progetto dentro `users/{uid}.tree.projects`:
`id`, `name`, `source_folders` (array di percorsi locali), `conversations` (chat
 direttamente nel progetto). Non creare piu cartelle virtuali per le chat.
La deserializzazione Rust appiattisce le vecchie `folders[*].conversations`
conservando le chat; i vecchi nomi di gruppo non diventano percorsi o permessi.
Il prossimo salvataggio scrive solo lo schema nuovo. Il controllo del database
remoto non ha richiesto altre modifiche: l'albero era gia privo di gruppi legacy.

Creazione: selettore nativo della cartella principale, consenso esplicito alla
lettura tramite dialogo nativo, nome modificabile e conferma Crea progetto.
Modifica: nome e cartelle di origine; rimuovere un collegamento non cancella file
sul disco o chat del progetto. Le cartelle di origine possono essere piu di una;
restano distinte dai raggruppamenti virtuali rimossi.

I consensi in lettura sono locali in `folder-permissions.json`, separati per UID
e ID progetto. I percorsi sincronizzati non autorizzano altri dispositivi.
Nuovi collegamenti senza consenso vengono rifiutati nel backend. Annullare la
creazione/modifica elimina i nuovi consensi rimasti scollegati; salvare rimuove
quelli dei collegamenti eliminati. Scrittura ed esecuzione richiedono permessi separati.
Gli strumenti di lettura ora consultano questi consensi e validano i percorsi
canonici, bloccando traversal e link fuori root. I file pertinenti alle richieste
vengono forniti al modello configurato; il dialogo di consenso lo spiega.
Nessun caricamento indiscriminato delle root.

Dipendenza nativa: `tauri-plugin-dialog`, usata da Rust per selezione e consenso;
nessun accesso generico al filesystem esposto al frontend.
Test: migrazione dei vecchi gruppi, isolamento/revoca e persistenza locale dei
consensi, editor con creazione/modifica/annullamento/errore, nuova chat senza
salvataggio fino al primo messaggio. I dialoghi nativi sono simulati nei test UI.


## Separazione cronologia v2 — applicata 17 ottobre 2026

La scelta resta interamente user-based: `users/{uid}/conversations/{id}` e
`messages/{messageId}`. Nel parent restano `config`, `window` e una mappa `tree`
versione 2 con `projects`, `project_order`, `conversations` (riepiloghi) e
`standalone_conversation_ids`; i progetti referenziano `conversation_ids`.
Testi e allegati non sono più incorporati nel documento utente. Gli ID sono
preservati. Un array di messaggi nel solo doc conversazione avrebbe riproposto
il limite di 1 MiB per chat, quindi si usano direttamente documenti messaggio.

`get_data` restituisce i riepiloghi; `get_conversation` legge solo la chat aperta.
La lettura verifica che la versione non cambi mentre scarica i messaggi.
Salvataggi con commit atomico, controllo versione e merge a tre vie dei metadati
per preservare modifiche indipendenti di altri dispositivi. Feedback aggiornato
sul messaggio interessato. Edit/rigenera sostituiscono solo la parte successiva.
Le versioni avanzano anche quando cambia soltanto il feedback.

Migrazione reale: backup completo privato nella cartella app/migration-backups,
copia dei documenti con verifica, switch condizionale del parent, controllo di
ripetibilità. Snapshot al passaggio: 1 progetto, 0 conversazioni, 0 messaggi.
Config e geometria conservate. Nessun deployment di regole; vanno gestite nella
console anche per le nuove subcollection. Le operazioni sopra 450 scritture o
9 MiB falliscono senza commit; il tree resta limitato dalla dimensione del parent.

Fonti: [limiti Firestore](https://firebase.google.com/docs/firestore/quotas),
[struttura dei dati](https://firebase.google.com/docs/firestore/manage-data/structure-data),
[commit REST](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/commit).

## Implementazione companion e notifiche — 17 ottobre 2026

Il codice del relay autenticato è ora presente nel desktop e in `mobile/`.
Le decisioni attuali sostituiscono il pairing senza account: stessa email/password,
PC riconoscibile dal nome Windows. `users/{uid}/companion/state` espone al telefono
soltanto l'albero, senza `config`; gli eventi di completamento si trovano in
`users/{uid}/notifications/{id}`. FID dei telefoni in `users/{uid}/phones/{id}`.
La funzione di invio è pronta ma non distribuita: billing Firebase attualmente
non abilitato. Le regole effettivamente lette via API sono ancora quelle globali
per qualsiasi utente autenticato. La pubblicazione della sostituzione per UID è
stata rifiutata dalla revisione automatica, senza dettagli oltre blocked by policy.
Non sono state pubblicate regole o indici. Il gateway tiene spento il controllo
remoto finché il controllo diagnostico sull'accesso a un altro UID non viene negato.

## Notifiche attivate — 18 ottobre 2026

L'utente ha pubblicato le regole proprietario e abilitato Blaze. Isolamento
verificato con 403 su un percorso valido di un altro UID; corretto il probe del
gateway che usava un ID riservato. Collegamento Android/PC/modello provato.
Cloud Function `completionPush` ACTIVE in europe-west3, Node 22: invii automatici
verificati con HTTP 204 e notifiche Android pubblicate, oltre alle notifiche
Windows nella cronologia del sistema. Il client desktop invia soltanto eventi
FireStore autenticati; nessuna credenziale amministrativa viene distribuita.
Risorse: 256 MiB, CPU gcf_gen1, min 0/max 3 istanze, concorrenza 1, timeout 60 s.
Retry degli errori fino a 24 ore; documenti non validi ignorati. Vecchie immagini
Artifact Registry eliminate dopo un giorno. Titolo della notifica di risposta:
nome della chat; testo: inizio della risposta, massimo 200 caratteri con ellissi.

## Notifiche solo quando servono — 18 ottobre 2026

I completamenti intermedi (chiamate ai tool, sub-agenti, comandi shell) non
generano più push: restano visibili nell'app desktop. Vengono inviate soltanto:
una notifica a fine turno di chat (risposta pronta, errore bloccante o
interruzione), la richiesta di approvazione quando serve una decisione umana, e
le operazioni esplicite dell'utente (download del modello vocale, trascrizione).
Il toast Windows viene soppresso se la chat conclusa è aperta nella finestra
principale a fuoco. L’evento Firestore per le push viene comunque pubblicato:
il focus del desktop non deve sopprimere le notifiche degli altri dispositivi.
Il telefono evita il banner locale per quella chat soltanto quando la sta
mostrando in foreground; approvazioni sempre notificate.

## Turni live sul telefono — 18 ottobre 2026

`run_chat` emette `live-turn` con `turn_id` (running e stato terminale). Il
gateway ascolta anche `chat-progress` e `agent-activity` e pubblica
`users/{uid}/devices/{device}/live_turns/{conversation_id}` con testo parziale,
reasoning, attività/tool/sub-agenti, `user_content`, `started_at` e `updated_at`.
Le attività includono azione, path, stato e, per i comandi, programma e
argomenti. Le scritture sono coalescenti: al massimo circa una al secondo,
heartbeat ogni 5 secondi, campi e lista attività troncati per restare sotto
1 MiB. I documenti terminali vengono eliminati dopo 60 secondi; il telefono
ignora gli stati più vecchi di 20 secondi, quindi un crash del desktop non lascia
loader permanenti. Un `turn_id` diverso non può sovrascrivere o chiudere il turno
in corso. Il percorso è separato da `conversations/{id}` per non interferire con
le precondizioni di versione della cronologia. Il telefono mostra il testo live
in un messaggio assistant, **Ragionamento** e **Attività** espansi con etichette
italiane, il passo corrente nel loader e un indicatore nelle chat in corso; lo
stop dal telefono usa lo stesso turno registrato in `chat_runs`.

## iOS — crash all'avvio e inizializzazione (18 ottobre 2026)

L'app iOS terminava subito all'avvio perché `Firebase.initializeApp` riceveva
le stesse opzioni dell'app Android (`appId: 1:...:android:...`). Firebase iOS
considera invalido un GOOGLE_APP_ID di un'altra piattaforma e lancia
un'eccezione nativa: `Configuration fails. It may be caused by an invalid
GOOGLE_APP_ID`. Ora le opzioni esplicite sono usate solo su Android; su iOS
Firebase legge `ios/Runner/GoogleService-Info.plist` (stesso comportamento
nell'isolate di background). Il 18 ottobre 2026 l'app iOS
`com.ridney.aurachat` è stata creata via `firebase apps:create IOS` e il plist
scaricato con `firebase apps:sdkconfig IOS`, poi aggiunto al target Runner.
Restano da caricare la chiave APNs in Cloud Messaging e abilitare Push
Notifications per l'App ID. Abilitati `UIBackgroundModes`
(`remote-notification`), Darwin initialization per le notifiche locali e il
delegate `UNUserNotificationCenter` in AppDelegate. Il token APNs viene atteso
prima di `register()`; il permesso viene chiesto dopo il login.

## Correzione push multipiattaforma e cronologia — 18 ottobre 2026

La precedente soppressione in `run_chat` eliminava anche l’evento push quando
la chat era aperta sul PC. Il filtro è stato spostato sul solo toast Windows.
Il payload FCM include `kind` per la decisione locale sul telefono.
La funzione registra accettazione FCM, piattaforma ed errori senza loggare FID;
la ricevuta conserva `message_id`: prova l’accettazione del provider, non la
visualizzazione sul dispositivo.

iOS richiede anche `FirebaseMessagingInstallationIdEnabled = true` in
`Runner/Info.plist` per `register()`/FID. Mancava: il warning `invalid-request`
segnalato dall’utente è coerente con questa configurazione incompleta. Flag
aggiunto, piattaforma salvata correttamente come `ios`, attesa APNs esplicita;
la registrazione attende anche il salvataggio del dispositivo prima di dichiarare
successo, conserva gli eventi arrivati prima del login e riprova al ritorno in
foreground. Test iPhone non eseguibile da Windows: nuova build Mac necessaria.

Il relay conserva offset UTF-16, segmenti reasoning, argomenti/output, approvazioni
e attività dei figli; aggiorna i comandi da `shell-activity`. La serializzazione
viene limitata in byte prima della scrittura Firestore. Cronologia mobile
intercalata al testo con passaggi espandibili e stati effettivi.

Verifica reale di questa sessione: Cloud Function ridistribuita; push di prova
visualizzata da Android in foreground e background senza disinstallazione.
Richiesta remota di calcolo tramite sotto-agente completata con `437`, con
reasoning/tool/agente salvati. Questo non certifica ancora la consegna iOS.

## Identità Windows — regressione trovata durante i test

Il riavvio con un launcher diverso ha prodotto `Ridney` invece di `RIDNEY`:
il vecchio hash case-sensitive creava due ID per lo stesso PC, lasciando
il telefono collegato a un gateway offline. L’hash ora normalizza maiuscole
e spazi dei nomi Windows (`identity_version: 2`). Il telefono riconosce un
solo gateway canonico online con lo stesso nome, sostituendo il vecchio alias
solo se offline e senza richiesta locale in corso. Casi ambigui non migrano.
Le richieste già accodate non vengono copiate o rieseguite. Test dedicati
Rust e Dart verificano identità e riconnessione.

## Audio di dettatura e risultato trascrizione — 18 ottobre 2026

Le richieste companion restano documenti da massimo 1 MiB, quindi un WAV non
viene scritto in un unico documento. Il telefono crea nella stessa collezione
`users/{uid}/devices/{device}/requests` una serie di documenti di appoggio con
`status: audio`, `action: audio` e un campo `audio` base64 (parti da 500 KB).
Il poll del desktop interroga solo `status: pending`, quindi non le prende in
carico. La richiesta `action: transcribe` contiene l'elenco ordinato
`audio_parts`, `language` e un `conversation_id` valido; il gateway legge ogni
parte con `relay_get`, ricompone il WAV, trascrive e riscrive il documento con
`status: completed` e `result: {text}`. In caso di errore usa il consueto
`status: failed` + `error` (`speech_model_missing`, `speech_busy`,
`speech_invalid_audio`, `speech_language`, `audio_missing`).

Il telefono elimina le parti solo dopo aver ricevuto uno stato terminale. Se la
risposta non arriva entro 180 secondi non le cancella, perché il desktop può
averle lette o doverle ancora leggere; il documento di richiesta resta come
traccia. L'heartbeat `devices/{id}` pubblica ora anche `speech: {ready, busy,
loading}`, usato dal telefono per il messaggio "scarica prima il modello vocale
sul PC" e per evitare registrazioni mentre il modello carica o sta trascrivendo.
Questo flusso non introduce nuove collezioni né regole Firestore: usa la stessa
collezione `requests` già autorizzata al proprietario.
