---
tags: [aurachat, roadmap]
---

# Roadmap

← [[Architettura - Overview]]

**Stato al 17 ottobre 2026: scope 0+1 (gateway desktop `desktop/`) implementato e funzionante; Firebase configurato (Firestore abilitato, account email/password, regole impostate); scope 2 (mobile) non avviato; strumenti di lettura delle root e dettatura locale implementati; scrittura/esecuzione e agente completo non implementati.** Questa
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
