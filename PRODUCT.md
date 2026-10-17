# AuraChat

Companion personale Android/iOS per il gateway Windows Tauri. Il telefono usa
lo stesso account email/password Firebase del desktop e invia richieste al PC
selezionato tramite Firestore. Solo il gateway chiama i modelli ed esegue gli
strumenti, con i permessi già presenti. Il nome Windows identifica il PC.

## Platform
android

## Stack
Flutter mobile, Tauri/Rust desktop, Firebase Auth/Firestore/FCM e Cloud Functions.

## Vincoli confermati
- `mobile/` e `desktop/` nella stessa root.
- Login email/password condiviso, sostituisce il pairing del piano iniziale.
- Notifiche al completamento su Windows e Android anche in background.
- Design scuro minimale Auralisys già definito nel vault e nel desktop.
- Test reali sull'emulatore Android disponibile.

## Da verificare
Attivazione fatturazione Firebase necessaria al deploy del mittente push.
