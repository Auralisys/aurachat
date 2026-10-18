# RD Core e Nuifit — riferimenti riusati

Su richiesta dell’utente, lettura del 18 ottobre 2026 nei repository locali
`C:/Users/lofio/Desktop/Dev/Flutter/Auralisys/rdcore` e `nuifit`, senza modificarli.

## Interazioni

`rdcore/lib/widgets/rd_gesture_detector.dart`: evidenziazione immediata alla
pressione, ripristino al rilascio/annullamento, feedback aptico e protezione
contro tap ripetuti. Il cleanup è in finally. AuraChat mantiene controlli
Flutter semantici e target 48 dp; riprende feedback immediato, movimento
discreto e supporto Reduce Motion. Nessuna dipendenza path dai repo RD.

## Push e nativo

`rdcore/lib/firebase/cloud_messaging/cloud_messaging_manager.dart` distingue
avvio da notifica, tap, foreground e background. In foreground salta la chat
già aperta, presenta notifiche locali Android e configura la presentazione
iOS. Verifica token APNs e permesso prima delle sottoscrizioni.

`nuifit/ios/Runner/AppDelegate.swift` inoltra esplicitamente il token APNs
a Firebase Messaging e poi a super. Stesso inoltro aggiunto ad AuraChat,
con controllo che Firebase sia inizializzato. AuraChat mantiene il rendering
locale per la sua decisione sulla chat visibile, evitando doppi banner.

`nuifit/functions/notification.js` invia ai topic utente/admin e allega data
per instradare il tap. AuraChat conserva l’indirizzamento FID per installazione
e le ricevute per evento: servono a distinguere i telefoni e ritentare. Non
trasferisce ad AuraChat topic basati su email, API amministrative client,
permessi exact alarm o notifiche critical usati in altri contesti.

Il flag Apple `FirebaseMessagingInstallationIdEnabled` è richiesto dal percorso
FID scelto in AuraChat: non si può dedurne la necessità dai soli topic Nuifit.
La configurazione Nuifit è un riferimento sorgente, non una nuova prova runtime.

## Verifiche AuraChat

Push Android realmente visualizzate in foreground e background tramite
Cloud Function. Sessione Android preservata con aggiornamento in-place.
Calcolo remoto tramite sotto-agente completato con 437 e attività salvate.
Skill temporanea di verifica caricata da root già autorizzata: risposta
SKILL_RUNTIME_OK e load_project_skill nella cronologia.
Apple runtime resta da verificare su nuova build iOS da macOS.
