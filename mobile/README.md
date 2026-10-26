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
Durante un turno il telefono segue `live_turns`: mostra testo parziale, reasoning
richiudibile, tool e sub-agenti, e un indicatore nelle chat che stanno lavorando,
anche per i turni avviati dal desktop. A fine turno il testo definitivo arriva
dai messaggi salvati. Le domande interattive (`ask_user`) compaiono come schede
nella chat aperta e si rispondono dal telefono con le stesse azioni del desktop
(risposta, scelta multipla, testo libero, discuti, salta o chiudi); generano
anch'esse una notifica quando il turno resta in attesa.

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
La funzione invia una notifica per risposta completa (compresi gli strumenti e
sub-agenti del turno) e download del modello vocale, anche per esito fallito/interrotto.
La dettatura non invia notifiche di trascrizione completata o fallita: testo ed
errori sono già nel compositore. Il mittente scarta anche gli eventi
`transcription` rimasti nelle code dei desktop precedenti.
Le richieste di approvazione generano anch'esse una notifica. Android visualizza
le push di sistema in background e dopo normale chiusura del processo; in primo
piano il client usa lo stesso canale locale nativo ad alta priorità, non un banner
custom. Le altre chat notificano anche con l'app aperta; solo la risposta della
chat effettivamente aperta sullo stesso PC viene soppressa, mentre le approvazioni
notificano sempre. iOS disabilita la presentazione automatica foreground di FCM
per non duplicare il banner locale.
Il tap di una push di sistema o locale conserva account, PC e conversazione:
funziona da avvio a freddo, background o app aperta su un'altra chat. La destinazione
attende login, dispositivi e indice aggiornato (fino a 20 secondi), chiude
menu/impostazioni e apre la chat nel suo progetto e sul PC della notifica.
Una notifica di un altro account non apre chat nell'account corrente; destinazioni
rimosse/non sincronizzate mostrano un avviso, senza aprire una chat diversa.
Le vecchie notifiche locali con il solo ID chat non sono riutilizzate come link
perché non identificano il proprietario: usare una nuova notifica.
Le impostazioni del sistema (permesso negato, Non disturbare o arresto forzato)
possono impedire la visualizzazione. Il logout rimuove la registrazione push.

## Interfaccia mobile — 18 ottobre 2026

Le chat avviate da Android usano gli stessi tool MCP del PC: discovery delle
configurazioni globali di altri client, importazione della singola integrazione
e connessione previa approvazione. Configurazioni e login CLI restano sul PC;
il telefono non importa credenziali. Una lista AuraChat vuota non esclude
integrazioni installate in altri client; il modello deve verificarle prima di
richiedere stack trace copiati o un browser.

Aggiornamento 22 ottobre: nella chat aperta il pulsante in alto a destra e
**Opzioni chat** (`...`): attività e cambiamenti, rinomina, copia conversazione
ed elimina con conferma.
Nuova chat resta nella home e nel menu laterale, non nel dettaglio.
Rinomina/eliminazione richiedono PC online e fermo per quella chat; la coda
locale di messaggi deve essere vuota. Il PC ricontrolla titolo e timestamp:
una chat modificata nel frattempo non viene cancellata. La copia usa il testo
caricato sul telefono, senza inviarlo a servizi esterni.

**Attività e cambiamenti** raccoglie output finali pubblicati (non file
temporanei), fonti e allegati, agenti e attività sincronizzate, anche offline.
I link HTTP(S) si aprono direttamente nel browser del telefono; per i file
prodotti sul PC viene copiato il percorso, non simulato un download.
Il riepilogo segue i nuovi messaggi e il turno live. Le shell vengono richieste
all'apertura, a fine turno e con Aggiorna: solo processi attivi o durati almeno
15 secondi, fino a 20, con anteprima limitata dell'output.

Con desktop **protocollo 5 o successivo** e PC online, le chat di progetto mostrano anche
Git: scoperta dei repository autorizzati, selezione iniziale del più modificato
(righe aggiunte/rimosse, poi numero di file), scelta manuale e stage/unstage
per file o gruppo. **Commit…** e **Commit e push…** richiedono uno stage non
vuoto, mostrano il diff e il messaggio modificabile (generabile con AI), e
non salvano senza **Conferma commit**. Il push ha una conferma separata con
remoto, branch e HEAD, anche dopo un commit riuscito. Il commit include tutto
lo stage del repository selezionato, inclusi file preparati sul PC. Non cambia
repository tra commit e push. Lo stato si aggiorna all'apertura, dopo le
azioni, a fine turno e con Aggiorna; non esegue polling Git continuo.
Le operazioni usano gli stessi controlli del desktop su account, consensi
locali, chat/progetto e revisioni. Durante le conversazioni attive restano
disponibili solo le letture. Errori o esiti incerti non provocano retry delle
mutazioni: controllare il PC prima di riprovare. Nessun reset, scarto o
force-push remoto viene esposto. I desktop precedenti mostrano l'invito ad
aggiornare senza impedire la consultazione delle attività.

**Menu > Skill** gestisce le skill del PC selezionato: globali, oppure globali
e del progetto scelto. Le skill sono attive di base; gli interruttori persistono
sul PC per account AuraChat e non modificano gli altri editor. `/nome` mostra
anche le globali nelle chat libere. Il progetto ha precedenza per nomi omonimi;
le disattivate non compaiono nel picker e non sono caricabili dal modello.
Le istruzioni gia presenti in una conversazione non vengono eliminate.
La ricerca filtra la lista; **Cerca su skills.sh** cerca nel catalogo pubblico
tramite il PC. **Installa** mostra repository, PC e ambito globale e richiede
conferma prima di scaricare/eseguire npx sul desktop (Node.js 22.20+ e Git).
Non installa codice Android o software sul telefono. Richiede desktop con
protocollo 4; desktop vecchi mostrano un invito ad aggiornare.
Timeout/esiti incerti non vengono ritentati automaticamente: controllare il PC.

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
- `users/{uid}/devices/{id}/questions/{id}`: domande interattive `ask_user` in
  attesa (scelta singola/multipla, risposta libera, batch fino a dodici); il
  telefono risponde con l'azione `answer_question` e il desktop pubblica il
  documento finché è pendente, poi lo rimuove alla risoluzione o all'annullamento.
- `users/{uid}/devices/{id}/live_turns/{conversation_id}`: stato transitorio del
  turno in corso (`running/completed/failed/cancelled`, testo parziale,
  reasoning, activity). Il desktop lo aggiorna al massimo una volta al secondo,
  con un heartbeat ogni 5 secondi; il telefono lo ignora se `updated_at` è più
  vecchio di 20 secondi e lo elimina dal desktop 60 secondi dopo la fine.
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

## iOS — configurazione necessaria

`androidFirebaseOptions` vale solo per Android. Su iOS Firebase si inizializza
dal file `ios/Runner/GoogleService-Info.plist`; senza quel file l'app mostra un
errore di configurazione all'avvio. Un appId Android su iOS provoca invece la
chiusura immediata dell'app (`Configuration fails ... invalid GOOGLE_APP_ID`).

L'app iOS Firebase (`com.ridney.aurachat`) è stata creata via CLI il 18 ottobre
2026 e `ios/Runner/GoogleService-Info.plist` è nel target Runner. Restano da
fare una volta, dalla console e da macOS:

1. In Cloud Messaging caricare la chiave APNs e abilitare Push Notifications per
   l'App ID: l'entitlement `aps-environment` è già in `Runner.entitlements`.
2. Su macOS: `flutter clean`, `flutter pub get`, `pod install` in `ios/`, poi
   `flutter run` su un dispositivo reale. Il simulatore non fornisce un token
   APNs, quindi le push FCM non sono verificabili lì.

## Esito delle prove reali del 17 ottobre 2026

- Accesso email/password Android riuscito; ripristino della sessione verificato.
- Nome PC effettivo rilevato anche senza la variabile COMPUTERNAME.
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

## Push, skill e cronologia — verifica del 18 ottobre 2026

Il focus di Windows sopprime il toast locale della chat aperta, ma non elimina
l’evento push destinato ai telefoni. In foreground il telefono evita il banner
solo per la chat che sta mostrando; approvazioni sempre notificate. FCM
`message_id` nelle ricevute attesta accettazione, non visualizzazione.

La registrazione aspetta il salvataggio del FID, conserva gli eventi arrivati
prima del login, distingue `ios` da `android` e riprova al resume. iOS usa anche
`FirebaseMessagingInstallationIdEnabled = true` e inoltro APNs esplicito nel
runner, come Nuifit. Il warning `invalid-request` va riprovato su nuova build
iOS; nessun test iPhone può essere certificato dall’ambiente Windows.

La chat mobile ricostruisce testo e passaggi secondo offset UTF-16, con
ragionamenti, argomenti/output dei tool, approvazioni e sotto-agenti espandibili.
Le anteprime live sono limitate e dichiarano il taglio; la cronologia salvata
resta il riferimento completo. I controlli di stop live operano sugli ID
registrati e verificano account/conversazione sul PC.

Digitare `/` nel progetto apre le skill note del PC selezionato. Discovery
nelle cartelle `.agents/skills`, `.codex/skills`, `.aurachat/skills` delle sole
root di progetto già autorizzate; `SKILL.md` UTF-8 fino a 32 KiB. `/nome` carica
la skill; il modello dispone anche di `list_project_skills`/`load_project_skill`.
I nomi duplicati richiedono selezione esplicita di root/path via tool. Il
catalogo mobile è aggiornato col heartbeat (protocollo 3). Nessuna importazione
automatica delle skill del profilo utente o delle integrazioni MCP.

Polish: gerarchia compatta, composer piatto, menu coerenti, target 48 dp,
Reduce Motion e testo ingrandito. Gli SVG selezionati coincidono con desktop:
provenienza in `assets/icons/provenance.json`; nessun bundle JS ChatGPT incluso.

Test reali: push Android foreground/background via Cloud Function, turno con
sotto-agente (437) e caricamento skill temporanea (SKILL_RUNTIME_OK). App
aggiornata in-place, senza logout/disinstallazione.
