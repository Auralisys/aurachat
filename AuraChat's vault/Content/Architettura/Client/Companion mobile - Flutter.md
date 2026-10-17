# Companion mobile — Flutter

Implementazione in `mobile/`, accanto al desktop. Decisione utente 17 ottobre 2026:
login email/password con lo stesso account del PC, sostituisce il pairing senza
account del piano iniziale. Il telefono sceglie il gateway riconoscendolo dal
nome utente Windows e dal nome computer.

Chat, progetti, scelta del modello, invio remoto, stop e approvazioni usano
Firestore. Le chiavi dei modelli restano nella configurazione usata dal desktop,
non vengono copiate nel client mobile. Il client non chiama mai il modello.
La cronologia usa le sottocollezioni esistenti, comprese le parti dei messaggi grandi.

Il gateway prende in carico una richiesta con precondizione di revisione; non
riesegue una richiesta interrotta da un riavvio. Le richieste scadono dopo cinque
minuti. La presenza è aggiornata ogni 15 secondi e scade sul telefono dopo 45.

Notifiche native Windows ed eventi di completamento implementati per chat,
agenti, shell, strumenti, trascrizioni e download del modello vocale. La funzione
`functions/completionPush` inoltra gli eventi a FCM per il telefono anche in
background. Il tap apre la conversazione; si notificano anche le approvazioni.

Stato verificato: APK Android compilato/installato, analisi e test locali passati;
trasporto Firestore reale verificato per query, claim atomico e duplicato rifiutato.
Il login Android è ora verificato. Il controllo
remoto è bloccato dalle attuali regole permissive, da aggiornare manualmente in
console; la revisione automatica ha rifiutato la pubblicazione da parte dell'agente.
Il progetto non ha ancora billing abilitato: la Cloud Function richiede Blaze.

Dettagli operativi, schema e comandi: `mobile/README.md`. Nessuna build iOS pronta:
la cartella iOS è uno scaffold, da configurare e verificare su macOS. Interfaccia
mobile italiana; il testo parziale, il reasoning e le attività sono trasmessi dal
desktop tramite `live_turns` e le chat in corso mostrano un loader. La persistenza
offline non è implementata.


Prove successive riuscite: login reale e ripristino sessione Android, presenza del
PC `lofio · Ridney`, lettura della cronologia e apertura della chat dal tap su push.
FCM diretto ha consegnato notifiche con app in background e dopo terminazione del
processo; registrazione FID attiva nel manifest. Verificata anche la notifica
Windows nella cronologia di sistema. Corretto l'installer DirectML (risoluzione
NSIS nel macro dopo le definizioni), verificata DLL installata e avvio reale.
Queste prove non equivalgono al deploy della funzione automatica, ancora pendente.

## Aggiornamento — 18 ottobre 2026

Regole proprietario pubblicate e verificate, controllo remoto attivo. Giro reale
Android/Firestore/PC/modello/Android riuscito. Blaze abilitato e completionPush
pubblicata in europe-west3; invio automatico verificato in background e con
processo Android assente prima del completamento. Notifiche Windows presenti
nella cronologia di sistema. Nome chat nel titolo e anteprima di 200 caratteri
della risposta, con ellissi quando tagliata, condivisi tra desktop e telefono.
