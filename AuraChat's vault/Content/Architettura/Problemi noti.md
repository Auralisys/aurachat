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

Le regole note consentono accesso a qualsiasi utente autenticato: il cambio di
percorso nel client non sostituisce le regole. La console deve limitare
`users/{uid}` a `request.auth.uid == uid`, rimuovendo la regola globale.
Regole e indici restano gestiti manualmente, vedi [[Firebase - trasporto e push]].
La cronologia è stata separata dal documento utente: tree leggero nel parent,
conversazioni e messaggi nelle subcollection per UID. Il limite del parent resta
1 MiB, ma i testi e gli allegati non lo occupano più. Migrazione e verifica CRUD
remota completate; dettagli in [[Firebase - trasporto e push]].

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
