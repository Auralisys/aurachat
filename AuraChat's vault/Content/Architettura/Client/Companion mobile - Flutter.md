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
FCM anche in background; il tap apre la conversazione. Il focus desktop sopprime solo il toast Windows; la push viene comunque
pubblicata. Sul telefono il banner foreground viene evitato solo se quella chat
è aperta sul telefono stesso.

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

## Skill, ordine dei passaggi e polish — 18 ottobre 2026

Ragionamento, tool, approvazioni e agenti sono intercalati al testo tramite offset
UTF-16. Ogni passo espande i dati effettivi; i sotto-agenti includono reasoning,
attività e risultato, con stop sul singolo agente/comando quando attivo. I
comandi running non vengono più segnati come completati. Fermare il padre
cancella figli e shell della stessa chat.

Il compositore supporta `/` con catalogo del progetto pubblicato dal PC
(protocollo 3), discovery/load reali e invocazione `/nome`. Nessuna skill
globale importata automaticamente. Posizioni e limiti in `mobile/README.md`.

Secondo polish: liste/header compatti, meno azioni ripetute, icone SVG condivise
con desktop anziché le matite generiche, composer piatto. Riferimenti studiati:
Impeccable, UI UX Pro Max, Apple Design e i componenti RD Core/Nuifit locali
([[RD Core e Nuifit - Riferimenti riusati]]).

Android aggiornato senza disinstallazione: push foreground/background e
caricamento di una skill temporanea provati realmente. La correzione del flag
FID iOS e dell’inoltro APNs richiede ancora nuova build/verifica su iPhone.

## Dettatura via PC, menu composer e coda — 18 ottobre 2026

Il riconoscimento vocale locale (`speech_to_text`) è stato rimosso: non era
affidabile. Il telefono registra ora un WAV **16 kHz mono 16-bit** con `record`.
Al tap sul microfono consulta `speech` nell'heartbeat del PC: se manca chiede di
aggiornare AuraChat, se `ready` è falso chiede di scaricare il modello vocale da
Impostazioni → Voce, se `busy`/`loading` invita a riprovare. Il composer mostra
stop durante la registrazione e uno spinner durante la trascrizione.

L'audio viene diviso in parti da 500 KB e scritto in
`users/{uid}/devices/{id}/requests` con `status: audio`; una richiesta
`action: transcribe` contiene `audio_parts` e `language`. Il PC ricompone il WAV,
trascrive con Cohere e riscrive `result.text` nella richiesta. Il telefono unisce
il testo alla bozza già presente. Stop trascrive soltanto; invio durante la
registrazione trascrive e invia subito, come sul desktop. Su timeout le parti non
vengono cancellate, perché il PC potrebbe doverle ancora leggere.

I menu di modello e permessi sono centrati con 20 px per lato (massimo 480 px),
non più ancorati all'icona che li apre.

La coda dei messaggi mostra la bolla utente con **In coda** e un menu a tre
puntini: **Manda subito** (steering se un turno è in corso, altrimenti promozione
e invio immediato), **Modifica** (riporta il testo nel composer) e **Cancella**.
Se resta in coda parte in FIFO alla fine del turno, anche dopo uno stop. Sono
stati corretti il blocco dell'operazione dopo errori di invio, la coda creata
mentre girava un'altra chat e i messaggi che scavalcavano la coda esistente.
