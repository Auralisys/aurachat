---
tags: [aurachat, desktop, impostazioni, provider, implementazione]
---

# Impostazioni e provider di modelli

← [[Desktop gateway - Tauri]] · [[Account - Login e ripristino sessione]] · [[UI desktop - Refactor flat]]

## Stato implementato — 17 ottobre 2026

Impostazioni in un dialogo centrato, massimo 860 × 600 px, con sfondo oscurato;
non occupa l’intera finestra. Sidebar interna con profilo, ricerca per parola
chiave e sezioni Generali, Account, Provider di modelli, Voce. Ingresso dalla rail
tramite ingranaggio, Ctrl+, menu account e voce Gestisci provider nel menu modelli.
La ricerca filtra le sezioni e segnala le ricerche senza risultati.

Account espone identità, stato di accesso e disconnessione locale, senza campi
Firebase. Dettagli della sessione in [[Account - Login e ripristino sessione]].

## Configurazione dei provider

Preset DeepSeek, OpenAI e OpenRouter, oppure servizio personalizzato compatibile
con OpenAI Chat Completions in streaming. DeepSeek precompila deepseek-flash e
deepseek-v4-pro. Gli altri preset precompilano l’URL, lasciando gli ID dei modelli
all’utente. Ogni provider ha nome e API key condivisa; ogni modello ha ID e URL
base indipendenti. Sono disponibili aggiunta/rimozione di righe e modifica o
rimozione del provider, con conferma delle modifiche da scartare.

URL HTTPS, oppure HTTP su localhost; credenziali nell’URL, query e frammenti non
ammessi. L’utente inserisce l’URL base, non /chat/completions. Il suffisso /v1 non
viene duplicato. ID modello duplicati nello stesso provider sono rifiutati.
Per l’uso degli strumenti, il modello deve supportare tool calling.

## Persistenza e compatibilità

In users/{uid}.config, providers contiene nome, tipo e chiave; models contiene
il modello, l’URL e provider_id. La vecchia chiave condivisa viene associata ai
provider ricostruiti dagli endpoint esistenti, preservando ID e modello attivo.
La conversione avviene in memoria al caricamento e viene persistita al primo
salvataggio successivo. La chiave precedente viene eliminata dal campo condiviso.

Il backend restituisce solo api_key_set e metadati, mai la chiave. Lasciare vuoto
il campo nell’editor conserva il segreto salvato. Chat, sub-agenti e revisione
automatica usano la chiave del provider del modello selezionato. Le chiavi restano
nella configurazione Firestore dell’account; non è stato aggiunto un vault cifrato.
Rimuovere un provider conserva le conversazioni e sceglie un modello rimanente;
nessun modello rimasto: il selettore mantiene Gestisci provider.

Nel selettore chat, DeepSeek è rappresentato dal logo bianco seguito dal modello,
senza separatore; senza logo specifico si mostra “Provider · modello”. Il nome
completo del provider resta nell’etichetta accessibile. Logo da Simple Icons,
provenienza e licenza in desktop/ui/assets/providers/README.md.

## Codice e verifiche

- desktop/ui/settings.js:39 — sezioni; :115 — editor; :179 — salvataggio.
- desktop/src-tauri/src/config.rs:150 — migrazione; :165 — scelta della chiave;
  :169 — validazione e aggiornamento del provider; :226 — vista pubblica.
- desktop/src-tauri/src/lib.rs:258 — salva provider; :269 — rimuovi provider.
- desktop/ui/styles.css:253 — overlay; :254 — dimensioni del dialogo.

Passati settings-flow.cjs, auth-flow.cjs e ui-smoke.cjs con servizi nativi
simulati: ricerca, preset/custom, più modelli, conservazione chiave, errore di
salvataggio, selezione in chat, modifiche non salvate, rimozione e logout.
Test Rust coprono migrazione, isolamento chiavi, round-trip, validazione atomica
e URL. In questo intervento non sono state effettuate nuove chiamate a provider
esterni né modifiche alle regole remote Firestore.
