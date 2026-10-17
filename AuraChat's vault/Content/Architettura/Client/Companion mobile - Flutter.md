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

Notifiche selettive: un solo esito per turno di chat (risposta pronta, errore o
interruzione), richieste di approvazione e operazioni esplicite dell'utente
(trascrizione, download del modello vocale). Tool, sub-agenti e comandi intermedi
non generano push. La funzione `functions/completionPush` inoltra gli eventi a
FCM anche in background; il tap apre la conversazione. La notifica di fine turno
viene omessa quando la chat conclusa è aperta nella finestra desktop a fuoco.

Durante un turno il telefono segue `live_turns`: mostra il testo assistant in
streaming, **Ragionamento** e **Attività** espansi con etichette italiane,
path degli strumenti e comando eseguito, oltre al passo corrente nel loader. La
lista chat mostra un indicatore sulle conversazioni in corso, anche per i turni
avviati dal desktop, e lo stop dal telefono interrompe lo stesso turno registrato
in `chat_runs`. A turno concluso contano i messaggi salvati nella cronologia.

Stato verificato: APK Android compilato/installato, analisi e test locali passati;
trasporto Firestore reale verificato per query, claim atomico e duplicato
rifiutato. Login reale e giro completo Android → PC → modello → Android riusciti.
Regole proprietario pubblicate e controllo remoto attivo; Blaze abilitato e
`completionPush` distribuita in europe-west3.

Dettagli operativi, schema e comandi: `mobile/README.md`. iOS: app Firebase
registrata con bundle ID `com.ridney.aurachat` e `GoogleService-Info.plist` nel
target Runner; restano da caricare la chiave APNs, abilitare Push Notifications
e verificare la build su macOS con un dispositivo reale. Interfaccia mobile
italiana; la persistenza offline non è implementata.


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
