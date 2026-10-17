---
tags: [aurachat, account, auth, desktop, implementazione]
---

# Account — Login e ripristino sessione

← [[Desktop gateway - Tauri]] · [[Firebase - trasporto e push]] · [[UIUX - Overview]]

## Correzione del 17 ottobre 2026

L'utente segnalava che a ogni apertura veniva riproposta l'intera configurazione.
In questa installazione non è stato trovato un config.json locale. Inoltre il
vecchio get_config nascondeva errori di autenticazione/Firestore restituendo una
configurazione vuota: la UI interpretava anche un errore di rete come primo avvio.

## Flusso attuale

1. Splash durante il ripristino sessione.
2. Senza sessione: solo email e password. Il bootstrap pubblico Firebase del
   progetto AuraChat è già preimpostato nell'app; non è necessario chiederlo
   all'utente prima del login. Non contiene credenziali LLM.
3. Dopo login: caricamento di users/{uid}, campo `config` (map nativa Firestore; lettura legacy JSON compatibile).
4. Key LLM già presente: apertura chat. Key assente: richiesta della sola API key
   una tantum e salvataggio nel documento utente, con mappa modelli, modello attivo
   e identificativi pubblici Firebase. Documento vecchio senza nuovi campi: compatibile.
5. Ai riavvii: rinnovo sessione con refresh token, senza reinserire password.
6. Sessione invalidata/scaduta: nuovo login. Errore di rete o lettura profilo:
   messaggio con Riprova, senza trasformarlo in una configurazione vuota.

La configurazione locale contiene bootstrap pubblico, email, uid e refresh token.
La password non viene più serializzata. Le vecchie configurazioni con password sono
lette per migrare al primo accesso riuscito; il successivo salvataggio la elimina.
Il refresh token è salvato nel JSON locale dell'app, non in un portachiavi cifrato.
La key LLM rimane sul documento utente Firestore per decisione dell'utente.
Non inserire password, key LLM o refresh token nel vault o nel codice.

Gli errori di lettura cronologia ora si propagano: non si inizializza un albero vuoto
quando Firestore è irraggiungibile. Login a un account diverso azzera le cache.
La cronologia usa ora la mappa `tree` nello stesso `users/{uid}`. Il vecchio
`data/tree` condiviso e stato migrato nell'unico account verificato il 17 ottobre
2026, poi eliminato. Le regole remote restano da limitare al proprietario:
vedi [[Firebase - trasporto e push]].

## Riferimenti verificati

- `desktop/src-tauri/src/config.rs:15` — `pub struct AppConfig`.
- `desktop/src-tauri/src/config.rs:39` — `pub fn load`.
- `desktop/src-tauri/src/config.rs:97` — `pub struct UserConfig`.
- `desktop/src-tauri/src/config.rs:177` — `fn session_survives_serialization`.
- `desktop/src-tauri/src/lib.rs:61` — `async fn ensure_uid`.
- `desktop/src-tauri/src/lib.rs:94` — `fn get_local_config`.
- `desktop/src-tauri/src/lib.rs:99` — `async fn login`.
- `desktop/src-tauri/src/lib.rs:120` — `async fn get_config`.
- `desktop/src-tauri/src/lib.rs:200` — `async fn get_data`.
- `desktop/src-tauri/src/firestore.rs:77` — `pub async fn id_token`.
- `desktop/src-tauri/src/firestore.rs:105` — `pub async fn login`.
- `desktop/ui/app.js:800` — `function showLogin`.
- `desktop/ui/app.js:811` — `async function routeAccount`.
- `desktop/ui/app.js:830` — `async function restoreSession`.

## Verifiche e limiti

- cargo test: due test Rust passati (serializzazione sessione senza password;
  configurazioni legacy/parziali e bootstrap predefinito).
- desktop/tests/auth-flow.cjs: login errato, login valido con soli email/password,
  configurazione LLM una volta, reload con autologin, rete assente senza nuova
  configurazione o salvataggi, Riprova. Backend simulato, nessun segreto reale.
- desktop/tests/ui-smoke.cjs: menu, impostazioni, chat e sidebar passati.
- cargo build: riuscita. Nessun nuovo pacchetto applicativo.
- Accesso reale e recupero del profilo da verificare nell'app con il primo login
  dell'utente; in questa sessione non sono state usate credenziali reali nei test.

## Aggiornamento shell desktop

La successiva shell a due sidebar e le chat senza progetto sono descritte in
[[UI desktop - Refactor flat]]. Il flusso account resta quello di questa nota;
`auth-flow.cjs` è passato nuovamente dopo l’ultimo aggiornamento della UI.

## Splash e ripristino finestra

La splash iniziale e fissa a 480x320 e centrata. Dopo il recupero del profilo viene
letta anche la mappa `window` di `users/{uid}` prima di mostrare l'interfaccia.
La finestra torna alla posizione/dimensione precedente, incluso lo stato
massimizzato, con correzione per monitor non piu disponibili. Login ed errori
usano la finestra standard se non si puo ancora ripristinare l'account.
La geometria della splash non viene salvata. Dettagli in [[Firebase - trasporto e push]].

## Account nelle impostazioni — 17 ottobre 2026

La sezione Account mostra identità, email, stato e disconnessione, senza parametri
Firebase. Logout elimina email/sessione persistita e cache locali, conservando
conversazioni e provider remoti; è rifiutato durante una richiesta chat attiva.
La UI attende la coda dei salvataggi finestra prima di uscire e ricarica il login.
Codice: desktop/src-tauri/src/lib.rs:282; desktop/ui/settings.js:203.

La configurazione LLM ora contiene provider indipendenti, con chiave dedicata e
modelli/endpoint modificabili: [[Impostazioni e provider di modelli]]. Un account
senza provider dopo la rimozione dell’ultimo può aprire la chat e riconfigurarli
dal selettore. Restano invariati bootstrap pubblico e ripristino con refresh token.
