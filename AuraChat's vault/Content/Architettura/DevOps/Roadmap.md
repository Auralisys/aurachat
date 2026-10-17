---
tags: [aurachat, roadmap]
---

# Roadmap

← [[Architettura - Overview]]

**Stato al 17 ottobre 2026: scope 0+1 (gateway desktop `desktop/`) implementato; Firebase configurato; scope 2 (mobile) non avviato. Lettura, scrittura con revisione, comandi, permessi e sub-agenti cancellabili implementati, oltre alla dettatura locale. I comandi Windows non hanno sandbox OS.** Questa
roadmap è il build order verso un MVP usabile, non un'autorizzazione a partire:
gli scope si avviano solo quando richiesto. DeepSeek è il default, ma ogni pezzo
resta endpoint-agnostico.

Ordine: **0 → 1 → 2 → 3 → 4 → 5**. Gli scope 1 (desktop) e 2 (mobile) si
sviluppano in parallelo e si incontrano nello scope 3 (relay). Il criterio di
"funziona" è sempre il giro completo telefono → desktop → LLM → telefono, non il
singolo schermo.

**La grafica si decide prima dello scope 0** ([[UIUX - Overview]]): ogni scope
rispetta la direzione smooth/minimale e i token, per non dover rifare la UI.
**Firebase è in uso** (progetto `auralisys-chat`, Firestore abilitato): decisione
17 ottobre 2026. Gli scope 0–2 non ne dipendono.

## 0 — Scaffold e ambiente

**Intervento:** struttura del progetto: `desktop/` (Tauri/Rust), `mobile/`
(Flutter), vault affiancato in `C:\Users\lofio\Desktop\Dev\AuraChat`. Progetto
Firebase con Firestore e FCM abilitati. Configurazione DeepSeek (`base_url`,
`model`, `api_key`) come valori locali, fuori dal repository.

**Uscita:** i due progetti compilano vuoti; la config Firebase è pronta; la key
DeepSeek non compare nel repo né nel vault.
**Rischio/ritorno:** nessuna logica ancora; cancellare e rifare è gratis.

## 1 — Gateway desktop (Tauri)

**Intervento:** app Tauri con tray; finestra settings (endpoint/modello/key);
chiamata HTTP al LLM a `<base_url>/v1/chat/completions` (formato
OpenAI-compatible) verificabile con una chat locale minimale. Client Firestore
da scegliere tra REST API e crate `google-cloud-firestore`.

**Uscita:** dal desktop si configura l'endpoint e si ottiene una risposta reale
dal modello; il processo sta nel tray senza finestra aperta.
**Rischio/ritorno:** nessun legame col telefono; ogni scelta di client Firestore
è sostituibile prima dello scope 3.

## 2 — Companion mobile (Flutter)

**Intervento:** app Flutter con chat, schermata di inserimento del codice di
pairing, invio prompt e ricezione risposta. Per ora la risposta è un fake
locale: Firestore arriva nello scope 3.

**Uscita:** la chat mostra prompt/risposta e gestisce loading/errore; la
schermata di pairing è pronta ma non ancora collegata.
**Rischio/ritorno:** la companion non deve mai chiamare il LLM direttamente;
qualsiasi scorciatoia qui viola il vincolo "la key sta solo sul desktop".

## 3 — Relay Firestore e pairing

**Intervento:** schema dei documenti della sessione; pairing con codice/QR
generato dal desktop e inserito dal telefono; giro completo prompt → LLM →
risposta attraverso Firestore, su entrambi i lati.

**Uscita:** dal telefono si manda un prompt e si legge la risposta prodotta dal
desktop, senza che i due device si parlino direttamente.
**Rischio/ritorno:** lo schema è la parte più costosa da cambiare dopo: tenere
i documenti minimi, non aggiungere campi "che serviranno".

## 4 — Push FCM

**Intervento:** Cloud Function su `onDocumentWritten` che invia FCM al token del
telefono quando il desktop scrive la risposta; `functions/` nel repo e
`firebase deploy --only functions`.

**Uscita:** a risposta pronta il telefono riceve una notifica, anche ad app
chiusa.
**Rischio/ritorno:** la funzione è idempotente e non contiene la key del LLM;
la notifica è un'aggiunta, il giro dello scope 3 non dipende da lei.

## 5 — Polish e open source

**Intervento:** README con onboarding a quattro passi (clona → configura
Firebase → deploy funzione → incolla la key), gestione errori e stati vuoti,
pulizia della key da log/errori, licenza.

**Uscita:** un estraneo può far girare AuraChat seguendo il README.
**Rischio/ritorno:** nessuna funzionalità nuova qui; è la fase che rende il
progetto pubblicabile, non quella che lo estende.

## Primo scope consigliato

**Scope 0 + 1**: struttura e gateway desktop con chiamata reale al modello. È il
"quick win" che prova subito key ed endpoint senza dipendere da Firestore o dal
telefono. Poi 2 (mobile) in parallelo, 3 (relay) li unisce, infine 4 (push) e
5 (pubblicazione).

## Ultimo intervento — refactor UI desktop (17 ottobre 2026)

Implementata e approvata la shell desktop a due sidebar: barra stretta persistente
con Home, impostazioni e avatar; barra superiore con navigazione e menu; pannello
principale arrotondato con sidebar progetti/recenti separata dalla chat.
Nuova chat centrale con progetto facoltativo, menu modello scuro e chat senza
progetto persistite nella mappa `tree` di `users/{uid}`. Build, test UI simulati e test Rust passati.
Inferenza reale non ritestata dall'agente dopo le modifiche UI.
Verifiche e punto di ripresa: [[UI desktop - Refactor flat]]. Il refactor non
completa relay/pairing, mobile o lo scope agente con tool.

## Correzione account e autologin (17 ottobre 2026)

Login separato dalla configurazione iniziale, ripristino sessione tramite refresh
token, password non più salvata, configurazione LLM recuperata dal documento
utente. Gli errori di rete non riaprono il primo avvio. Stato e verifiche in
[[Account - Login e ripristino sessione]].


## Aggiornamento operativo — progetti, voce e storage (17 ottobre 2026)

Implementati e verificati: cronologia Firestore v2 con tree leggero e messaggi
separati, migrazione con backup, caricamento delle chat all'apertura, strumenti
reali di esplorazione/lettura delle root autorizzate e dettatura locale Cohere.
Risolti il blocco dopo otto passaggi di lettura e lo scorrimento troppo rapido
della forma d'onda (ora una barretta ogni 100 ms).

Stato puntuale, prove e limiti: [[Desktop gateway - Tauri]],
[[Firebase - trasporto e push]], [[UI desktop - Refactor flat]] e [[Problemi noti]].
Mobile, relay/pairing, push e strumenti di scrittura/esecuzione restano da realizzare.

## Aggiornamento finale — impostazioni e conversazione (17 ottobre 2026)

Completati dialogo impostazioni compatto con ricerca e sidebar, account senza
parametri Firebase, logout e gestione di provider preset/custom con più modelli,
endpoint e chiavi indipendenti. Migrazione compatibile della configurazione
precedente. Dettagli: [[Impostazioni e provider di modelli]].

Corretti il falso modello vocale mancante e la preparazione al primo utilizzo;
verificate due trascrizioni locali consecutive. Ragionamento e attività unificati
nella chat con cervello viola animato, testo della conversazione ridotto a 13 px.
Verifiche e limiti: [[Desktop gateway - Tauri]], [[UI desktop - Refactor flat]]
e [[Problemi noti]]. Mobile, relay/pairing e push restano pianificati.

## Aggiornamento companion e notifiche — 17 ottobre 2026

Il mobile Flutter Android e il trasporto gateway sono ora implementati in
`mobile/` e `desktop/src-tauri/src/companion.rs`. Login email/password condiviso,
non pairing anonimo. Implementate notifiche native Windows ed eventi per FCM;
mittente Cloud Function pronto in `functions/`, non distribuito perché il progetto
è senza billing. Il controllo remoto è disabilitato finché le regole permissive
non vengono sostituite con isolamento per UID. L'aggiornamento automatico delle
regole è stato bloccato dalla revisione automatica e resta un intervento in console.

Verificati build Android, test locali e trasporto/CRUD Firestore reali.
Il test completo sull'emulatore è stato tentato, ma richiede prima il login
nell'app con lo stesso account del desktop. Vedi [[Companion mobile - Flutter]]
e `mobile/README.md` per prerequisiti, limiti e comandi ripetibili.


Verifiche successive: login Android reale completato, FCM diretto ricevuto sia in
background sia dopo chiusura del processo, tap che apre la conversazione, toast
Windows nella cronologia del sistema, installer Windows corretto e verificato.
Inferenza remota ancora bloccata dalle regole; deploy automatico FCM ancora da fare.

## Companion e push operative — 18 ottobre 2026

Regole per UID pubblicate, Blaze attivo, completionPush distribuita. Collegamento
reale Android/PC/modello e push automatiche provati; notifiche Windows verificate.
Funzione senza istanze minime, max 3, CPU frazionaria/256 MiB; retry limitato a
24 ore e immagini delle build eliminate dopo un giorno. Notifiche di risposta
con nome chat e anteprima del testo. Restano firma release Android e sviluppo iOS.

## Notifiche selettive, turni live e iOS — 18 ottobre 2026

Le push non arrivano più per ogni attività: un solo esito per turno di chat,
richieste di approvazione e operazioni esplicite (trascrizione, download voce).
Tool, sub-agenti e comandi intermedi restano nell'app. La notifica di fine turno
è soppressa se la chat conclusa è aperta nella finestra desktop a fuoco.

Il telefono vede ora il turno in corso tramite
`users/{uid}/devices/{device}/live_turns/{conversation_id}`: testo parziale,
reasoning e attività/agenti, con loader nella lista chat e stop anche per i turni
avviati dal desktop. Dettagli su cadenza, `turn_id`, limiti e retention in
[[Desktop gateway - Tauri]], [[Companion mobile - Flutter]] e
[[Firebase - trasporto e push]].

iOS: creata via CLI l'app Firebase `com.ridney.aurachat` e aggiunto
`GoogleService-Info.plist` al target Runner; corretto il crash immediato dovuto
all'appId Android usato su iOS. Restano chiave APNs, capability Push e verifica
su dispositivo reale. Per provare modifiche al gateway va ricompilato e
riavviato il desktop, non solo l'app mobile.
