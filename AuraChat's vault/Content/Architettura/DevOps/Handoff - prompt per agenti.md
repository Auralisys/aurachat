---
tags: [aurachat, handoff, prompt]
---

# Handoff — prompt per agenti

← [[Roadmap]]

Prompt pronti da incollare in un agente **con contesto azzerato** per leggere il
vault e avviare i due progetti. Ogni prompt è autonomo: percorso del vault, note
da leggere, cosa creare e cosa non inventare. I due agenti lavorano in parallelo;
si incontrano nello scope 3 della [[Roadmap]]. Entrambi devono rispettare la
direzione visiva di [[UIUX - Overview]]: tema scuro, palette Auralisys (accento
Electric Violet `#8b3fe0`), smooth e minimale.

## Prompt 1 — Riprendere il desktop esistente (Tauri/Rust)

Lavora in `C:\Users\lofio\Desktop\Dev\AuraChat`. Il progetto desktop esiste
in `desktop/`: non ricreare lo scaffold. Leggi `Overview.md` del vault, poi
[[UI desktop - Refactor flat]], [[Desktop gateway - Tauri]],
[[Account - Login e ripristino sessione]], [[Firebase - trasporto e push]],
[[Problemi noti]] e [[Roadmap]].

Mantieni la shell approvata: barra stretta con Home/impostazioni/avatar, barra
superiore con navigazione e menu, pannello arrotondato con sidebar interna e
chat. Mantieni lo sfondo viola statico della nuova chat, compositore centrale e
progetto facoltativo. Modifica solo quanto richiesto dall'utente.

La cronologia usa Firestore v2: `users/{uid}.tree` contiene mappe native di
riepiloghi e riferimenti agli ID; i testi stanno in
`users/{uid}/conversations/{id}/messages/{messageId}`. Non incorporare nuovamente
le cronologie nel parent e non serializzare oggetti come stringhe JSON.
I progetti hanno root reali e chat dirette; il consenso è locale per UID e
progetto. Sono implementati strumenti di esplorazione e lettura delle root,
con controlli sui percorsi: non reintrodurre limiti arbitrari sul numero di
passaggi o sul totale letto. La dettatura locale Cohere usa Stop per trascrivere
nella bozza, Invio per trascrivere e inviare, X per annullare; forma d'onda a
100 ms per barretta. Stato e verifiche in [[Desktop gateway - Tauri]].
L'account usa refresh token locale e configurazione LLM nel documento utente:
non chiedere di riconfigurare l'inferenza a ogni riavvio e non copiare segreti
nel codice o nel vault.

Per la verifica usa `desktop/tests/ui-smoke.cjs`, `desktop/tests/auth-flow.cjs`,
`cargo test --manifest-path desktop/src-tauri/Cargo.toml` e la build desktop.
Playwright è disponibile nel runtime locale, non è una dipendenza applicativa.
Distingui i test simulati dall'inferenza reale e aggiorna le note pertinenti.
Mobile, relay/pairing, push e tool di scrittura/esecuzione sono scope separati
da avviare solo su richiesta. Non inizializzare repository Git annidati.

## Prompt 2 — Companion mobile (Flutter)

Lavora nel progetto AuraChat, un'app personale open source per comandare dal
telefono un gateway locale che fa inferenza su un LLM OpenAI-compatible
(DeepSeek di default) con la propria API key.

La documentazione è un vault Obsidian in
`C:\Users\lofio\Desktop\Dev\AuraChat\AuraChat's vault`. Leggi in quest'ordine:
`Overview.md`, `Content/Architettura/Architettura - Overview.md`,
`Content/Design/UIUX - Overview.md`,
`Content/Architettura/Client/Client - Overview.md`,
`Content/Architettura/Client/Companion mobile - Flutter.md`,
`Content/Architettura/DevOps/Roadmap.md` (scope 0 e 2).

Poi crea il progetto mobile in `C:\Users\lofio\Desktop\Dev\AuraChat\mobile`
(cartella nuova, accanto al vault): un'app **Flutter** (Android/iOS) con una
schermata chat minimale e una schermata di inserimento del codice di pairing.
Per ora l'invio del prompt restituisce una risposta fake locale (senza rete):
Firestore arriva nello scope 3 della roadmap, da collegare dopo. Usa il logo
Auralisys (`Content/Design/Riferimenti/logo-auralisys.svg`) come icona
dell'app, copiandolo negli asset Flutter.

Interfaccia: smooth e minimale come ChatGPT/Copilot, tema scuro e palette
Auralisys (accento Electric Violet `#8b3fe0`) — vedi
`Content/Design/UIUX - Overview.md`. Il primo avvio è una sola schermata
"Inserisci il codice" per il pairing; la chat è text-first con poche
informazioni ben fatte. Token di colori/spaziatura/tipografia definiti una
volta sola. La companion non tiene la key (sta solo sul desktop); può però
cambiare endpoint/modello inviando un comando al desktop.

Non implementare ancora Firestore, FCM o push. Non chiamare mai un LLM
direttamente dall'app: la key sta solo sul gateway desktop. Non inizializzare
un repo git annidato in `mobile/`. Segui le convenzioni del vault e riporta nel
risultato cosa hai creato e cosa resta da decidere.
