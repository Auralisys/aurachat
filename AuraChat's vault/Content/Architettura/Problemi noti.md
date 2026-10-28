---
tags: [aurachat, problemi-noti]
---

# Problemi noti

← [[Architettura - Overview]]

Elenco dei limiti confermati sul codice al 17 ottobre 2026.

## Regole remote e cronologia legacy

Il client salva ora `config` e `tree` come mappe native in `users/{uid}`.
Il percorso condiviso `data/tree` non viene piu usato. Nessuna migrazione
remota pendente: il 17 ottobre 2026 il vecchio albero e stato assegnato
all'unico account verificato e `data/tree` eliminato, con backup locale.
Le vecchie configurazioni stringificate vengono lette e convertite al salvataggio.

Le regole proprietario sono state pubblicate il 17 ottobre 2026 e verificate con
403 su un percorso valido di un altro UID; la regola globale permissiva è stata
rimossa. Regole e indici restano gestiti manualmente in console, vedi
[[Firebase - trasporto e push]].
La cronologia è stata separata dal documento utente: tree leggero nel parent,
conversazioni e messaggi nelle subcollection per UID. Il limite del parent resta
1 MiB, ma i testi e gli allegati non lo occupano più. Migrazione e verifica CRUD
remota completate; dettagli in [[Firebase - trasporto e push]].

## iOS e turni live — 18 ottobre 2026

iOS non è ancora verificato su dispositivo reale. L'app Firebase con bundle
`com.ridney.aurachat` e `GoogleService-Info.plist` sono pronti; mancano chiave
APNs, abilitazione Push Notifications sull'App ID e build su macOS. Un appId
Android usato su iOS aveva causato la chiusura immediata (`invalid GOOGLE_APP_ID`).

Per i turni live, un arresto del desktop lascia il documento `live_turns` in
stato `running`; il telefono lo ignora dopo 20 secondi, quindi non resta un
loader permanente. I documenti terminali vengono eliminati dal desktop dopo
60 secondi. La scrittura è troncata per rispettare il limite Firestore.

## Copertura delle verifiche UI

Suite UI e Rust passate. Verificati separatamente provider reale con file locale,
trascrizione CPU reale, migrazione Firestore e CRUD/conflitti sul database.
La prova completa con microfono fisico e dialoghi permessi nel WebView Tauri
resta manuale. Dimensioni provate, advisory del detector e screenshot in
[[UI desktop - Refactor flat]].


## Lettura estesa dei vault

Risolto il limite applicativo di otto passaggi che produceva `project tool limit
reached; narrow the request`; rimosso anche il tetto cumulativo di 512 KiB.
Regressione oltre entrambe le soglie verificata. Il modello può continuare
l'esplorazione fino alla risposta; il provider conserva i propri limiti di
contesto e servizio. Non è stata ripetuta dall'agente la lettura completa del
vault Centro cinofilo dopo il fix. Dettagli in [[Desktop gateway - Tauri]].

## Stato dopo impostazioni e dettatura — 17 ottobre 2026

Corretti: modello vocale occupato scambiato per assente; attesa opaca dopo Stop
al primo uso; richieste vocali sovrapposte dopo annullamento; doppia riga di
reasoning con estratti intermittenti. Dettagli in [[Desktop gateway - Tauri]]
e [[UI desktop - Refactor flat]]. Verificate due trascrizioni CPU consecutive
sul campione locale e regressioni browser con microfono simulato.

Restano da verificare microfono fisico e permessi nel WebView nativo. Annullare
una trascrizione scarta il risultato ma attende il blocco ONNX in corso. Provider
esterni non richiamati in questo intervento. Chiavi provider e refresh token
conservano i limiti di storage già documentati; nessuna nuova cifratura dedicata
o modifica delle regole remote. Vedi [[Impostazioni e provider di modelli]] e
[[Account - Login e ripristino sessione]].

## Caricamento del modello all'avvio — 17 ottobre 2026

Il tempo di verifica e caricamento del modello Cohere (~2 GB) non è più opaco:
il modello viene preparato all'apertura dell'app e il microfono mostra un loader
sull'icona finché non è pronto, disabilitando il click anticipato. In
Impostazioni → Voce lo stato distingue preparazione, modello caricato in memoria
e pronto per la dettatura; durante il caricamento download e rimozione sono
disabilitati. Annullare una trascrizione continua ad attendere il blocco ONNX già
in corso (il risultato viene scartato), ma questo non riguarda più il primo avvio.
Dettagli in [[Desktop gateway - Tauri]] e [[UI desktop - Refactor flat]].

## Script e installer — 22 ottobre 2026

- `install-prod.sh` e `package-installer.sh` (macOS) sono controllati solo con
  `bash -n`: non sono ancora stati eseguiti su un Mac.
- Installer non firmati: SmartScreen su Windows, tasto destro → Apri su macOS.
  Mancano firma Authenticode, Developer ID e notarizzazione.
- La versione resta `0.1.0`: va incrementata a mano prima di distribuire.
Dettagli in [[Build e distribuzione]].

## Allucinazione di commit/push Git da parte del modello — 27 ottobre 2026

L'agente a volte dichiara di aver creato un commit o eseguito un push senza averlo
fatto o verificato (es. cita hash inesistenti). Non è un difetto della UI Git,
che richiede già conferme esplicite; è un comportamento del modello. Mitigato nel
system prompt del progetto (`desktop/src-tauri/src/project_files.rs`, `context()`):
l'agente deve rileggere `git status --short --branch` e `git log --oneline -1`
dopo le operazioni e riportare hash e stato reali, senza inventare hash o
dichiarare successo senza l'output del tool. La regola si propaga anche ai
sub-agenti, che clonano lo stesso contesto.
