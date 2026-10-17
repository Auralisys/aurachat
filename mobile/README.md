# AuraChat mobile

Client Flutter Android del gateway Windows, nella stessa root del desktop.
L'app usa Firebase Auth (stessa email/password), Firestore e notifiche FCM.
Android package: `dev.aurachat.mobile`. Il progetto Firebase è `auralisys-chat`.
Il file google-services.json e FirebaseOptions contengono identificativi pubblici,
non chiavi dei provider. Le chiavi LLM non sono lette dal telefono.

## Avvio

Dal progetto mobile:

```powershell
flutter pub get
flutter run -d emulator-5554
```

Avvia anche il desktop aggiornato. Scegli il PC nell'intestazione: il nome è
`utente Windows · computer`. Il segnale di presenza scade dopo 45 secondi.
Il desktop resta attivo nel tray quando la finestra viene chiusa.

La cronologia mostra chat libere e progetti del desktop. Una nuova chat può
appartenere a un progetto esistente; cartelle e permessi rimangono sul PC.
Il menu nell'intestazione sceglie il modello. Le operazioni che richiedono consenso
si autorizzano dal telefono con la stessa anteprima usata dal desktop.
Le richieste in corso si ritrovano riaprendo l'app. Stop annulla una richiesta
ancora in coda oppure interrompe il turno del desktop, conservando il testo parziale.
Le risposte arrivano quando il turno viene salvato; il testo non viene ancora
trasmesso a frammenti al telefono. Sul desktop resta lo streaming esistente.

## Configurazione esterna ancora necessaria

1. Regole Firestore pubblicate e verificate il 17 ottobre 2026: rimossa la regola globale permissiva; consentito
   accesso soltanto al proprietario di `users/{uid}` e di tutte le sottocollezioni:
   `request.auth != null && request.auth.uid == uid`.
   La prova diagnostica del gateway richiede che leggere un documento di un altro
   UID dia 403; non sostituisce le regole. Il controllo remoto resta disabilitato
   finché questa verifica non passa. La pubblicazione automatica delle regole
   è stata rifiutata dalla revisione automatica; la pubblicazione è stata eseguita dall'utente in console.
2. Mittente scelto: Cloud Function `completionPush` in `europe-west3`, con Blaze
   abilitato dall'utente. Nessuna credenziale amministrativa da configurare sui PC.
3. Dalla root, distribuire il mittente:

```powershell
firebase deploy --only functions:aurachat:completionPush --project auralisys-chat --force
firebase functions:artifacts:setpolicy --location europe-west3 --days 1 --project auralisys-chat --force
```

FCM viene registrato dopo l'accesso; Android chiede il permesso notifiche.
La funzione invia una notifica per risposta, agente, comando, strumento,
trascrizione e download del modello vocale, anche per esito fallito/interrotto.
Le richieste di approvazione generano anch'esse una notifica. Android visualizza
le push di sistema in background e dopo normale chiusura del processo; in primo
piano il client usa lo stesso canale locale. Il tap apre la conversazione.
Le impostazioni del sistema (permesso negato, Non disturbare o arresto forzato)
possono impedire la visualizzazione. Il logout rimuove la registrazione push.

## Interfaccia mobile — 18 ottobre 2026

Home con progetti espandibili e recenti, ricerca e campo compatto in basso,
ispirata ai riferimenti iOS forniti dall'utente. Palette del desktop e bolle
utente viola. Menu laterale per navigazione e account; controlli circolari da
48 dp, PC/progetto allineati a sinistra. Durante la scrittura la barra del campo
espone modello e permessi; testo fino a quattro righe, poi scorrimento interno.
Le transizioni rispettano l'impostazione di riduzione delle animazioni.

Protocollo desktop 2: il dispositivo pubblica `project_permissions` per i progetti
dell'account. La nuova azione `permission` usa lo stesso comando del desktop,
verifica appartenenza e blocco durante i turni attivi; il passaggio a `full`
richiede conferma esplicita nell'app e `confirm_full_access: true` nel backend.
I permessi rimangono locali al PC selezionato. Le chat libere spiegano il legame
con i progetti. L'interfaccia desktop si aggiorna anche dopo una modifica remota.

Verifica: analisi Flutter senza problemi, sei test widget/unitari, test Rust del
vincolo di conferma accesso completo e test desktop di chat in background.
Build Android e installer Windows aggiornati e installati. Controllo visivo su
emulatore Android di home, chat, ricerca, composer e selettori; prova widget
su larghezza 320 con testo al 130% e tastiera simulata. Nessuna build iOS
verificata da Windows; le configurazioni iOS recuperate da origin sono conservate.

Il servizio push usa Firebase Admin 14 e le registrazioni FID di FlutterFire 17.
Non contiene credenziali amministrative: usa l'identità della Cloud Function.
Gli eventi hanno una ricevuta per dispositivo e un tag Android stabile sui retry.
La funzione usa 256 MiB, CPU `gcf_gen1`, zero istanze minime, al massimo tre
istanze, una richiesta per istanza e timeout di 60 secondi. Gli eventi non validi
non vengono ritentati; quelli in errore scadono dopo 24 ore. Le vecchie immagini
di distribuzione vengono eliminate dopo un giorno quando la policy è applicata.

## Protocollo

- `users/{uid}/devices/{id}`: nome del PC, presenza, modelli pubblici e stato remoto.
- `users/{uid}/companion/state`: proiezione dell'albero senza configurazione provider.
- `users/{uid}/devices/{id}/requests/{request}`: azione, chat, testo, timestamp,
  stato pending/running/completed/failed/cancelled. Presa in carico con precondizione
  sulla revisione Firestore, senza esecuzioni automatiche duplicate.
- `users/{uid}/devices/{id}/approvals/{id}`: richieste di consenso con revisione.
- `users/{uid}/phones/{installation}`: registrazione FID del telefono.
- `users/{uid}/notifications/{event}`: completamento che attiva la Cloud Function.
- Conversazioni e messaggi usano lo schema desktop esistente, inclusi i messaggi
  suddivisi in parti per il limite Firestore.

Il gateway controlla la coda ogni 2 secondi e pubblica la presenza ogni 15.
Una sola istanza desktop per utente evita gateway concorrenti sullo stesso PC.
Gli eventi di notifica non ancora pubblicati restano in una coda locale per
account e vengono ritentati alla riconnessione, anche dopo il riavvio del desktop.
Richieste più vecchie di cinque minuti vengono rifiutate; i turni interrotti da
un riavvio diventano failed e non vengono rieseguiti. I documenti di richieste e
notifiche sono conservati: pulizia/retention non ancora configurata.

## Verifiche

```powershell
flutter analyze
flutter test
flutter test integration_test/companion_test.dart -d emulator-5554
```

Il test di integrazione usa cloud, PC e modello reali: prima accedere nell'app
Android e predisporre le regole proprietario. Crea una chat riconoscibile
`[Test connessione Android]`, conservata come evidenza. Non contiene password
né bypass di autenticazione. Il login reale è stato verificato. La prova automatica
si è fermata all'accesso dopo la reinstallazione; il giro completo è stato poi
verificato tramite l'interfaccia dell'app normale sull'emulatore, come descritto sotto.

Da root il test di trasporto reale e isolato, con la sessione desktop già presente:

```powershell
$env:AURACHAT_REMOTE_SMOKE='1'
./desktop/tests/run-native.ps1 -TestArguments @('real_companion_claim','--ignored','--nocapture')
```

Questo test controlla la coda, la presa in carico atomica e il rifiuto del duplicato,
poi elimina soltanto il proprio documento temporaneo. Non chiama il modello.

## Limiti della consegna

Android è stato compilato e installato sull'emulatore API 37. L'APK è di debug.
Firma di distribuzione Android non configurata. La cartella iOS è lo scaffold
Flutter e richiede configurazione Firebase/APNs, firma e verifica su macOS:
non è una build iOS pronta. Interfaccia mobile attuale in italiano.
Push automatiche operative tramite Cloud Function su Blaze; nessuna credenziale
FCM amministrativa viene distribuita nei client.
La visualizzazione delle notifiche Windows va verificata con l'app installata;
Tauri non la garantisce con il solo eseguibile di sviluppo.

## Esito delle prove reali del 17 ottobre 2026

- Accesso email/password Android riuscito; ripristino della sessione verificato.
- Nome PC effettivo rilevato anche senza la variabile COMPUTERNAME: `lofio · Ridney`.
- Lettura della cronologia reale, inclusa apertura della chat tramite tap su push.
- Registrazione FID Firebase riuscita con il flag Android
  `firebase_messaging_installation_id_enabled`.
- FCM ha accettato e Android ha visualizzato notifiche sia in background sia
  dopo terminazione normale del processo dell'app. Invii di prova diretti con
  l'identità amministrativa locale, non con la Cloud Function ancora da distribuire.
- Notifica Windows reale presente nella cronologia di sistema dell'app installata.
- Corretto un errore preesistente nell'installer: il percorso DirectML veniva
  risolto prima delle definizioni NSIS e copiava l'eseguibile al posto della DLL.
  Hash della DLL installata verificato contro la sorgente; app installata avviata.
- Trasporto Firestore reale: claim atomico, duplicato rifiutato e snapshot di
  approvazione vecchi che non possono riattivare una decisione già conclusa.
- CRUD della cronologia reale con preservazione di config/window/albero originale
  e conservazione delle cronologie già caricate durante il refresh del gateway.

Le regole proprietario sono state pubblicate dall'utente e verificate con risposta
403 su un percorso di un altro account. Corretto il controllo desktop, che usava
un ID riservato da Firestore e riceveva 400 invece di verificare le autorizzazioni.
Il test reale ora richiede esplicitamente isolamento attivo e passa; desktop
ricompilato, installato e avviato. Dopo il nuovo accesso nell'emulatore, inviata
dall'interfaccia Android una nuova chat `[Test connessione Android]` richiedendo
`ANDROID_REMOTE_OK_20261017_2348`: il PC ha eseguito il turno e la risposta del
modello con quel testo è comparsa sul telefono. Giro Android/Firestore/Windows/
modello/Android verificato realmente.

## Cloud Function attiva — 18 ottobre 2026

`completionPush` distribuita e verificata ACTIVE in `europe-west3`, Node.js 22.
Trigger sulla creazione di `users/{uid}/notifications/{eventId}`. La prima
attivazione ha richiesto la propagazione dei permessi Eventarc; il deploy
successivo è riuscito. Policy immagini di build: eliminazione dopo un giorno.
Invii automatici conseguenti a richieste reali dall'emulatore verificati con
risposte HTTP 204 della funzione e notifiche pubblicate sul canale Android.
Notifiche Windows `Risposta pronta` presenti nella cronologia del sistema.

Le notifiche di fine risposta usano il titolo della chat (massimo 100 caratteri)
e l'inizio della risposta (200 caratteri, spazi normalizzati e puntini se tagliata).
Windows e FCM ricevono lo stesso titolo e testo. Per risposte vuote, errori e
interruzioni senza testo viene conservato il messaggio di stato.

Verifica finale: notifica automatica ricevuta anche dopo aver confermato assente
il processo Android e generato dal desktop un evento di completamento. Il test
successivo con risposta di 100 parole ha mostrato su Android e nella cronologia
Windows il nome della chat e la stessa anteprima `ANTEPRIMA_NOTIFICA_OK...`,
troncata con ellissi. Invocazioni Cloud Run terminate con HTTP 204.
Test mirato Rust dell'anteprima e due test Node della funzione superati.
