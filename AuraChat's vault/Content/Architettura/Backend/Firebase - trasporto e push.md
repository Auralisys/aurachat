---
tags: [aurachat, backend, firebase, firestore, fcm]
---

# Firebase — trasporto e push

← [[Architettura - Overview]]

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
