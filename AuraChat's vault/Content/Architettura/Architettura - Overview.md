---
tags: [aurachat, architettura]
---

# Architettura

← [[Overview]]

AuraChat è tre pezzi, non uno: un **gateway desktop** che possiede la key e fa
l'inferenza, una **companion mobile** che lo comanda, e **Firebase** come
trasporto/push tra i due. Non c'è un backend proprietario: il relay è Firestore
e la notifica è FCM via Cloud Function. Firebase è il candidato, non una
decisione presa (vedi [[Roadmap]]).

## Client

- [[Client - Overview]] — le due app e le convenzioni comuni.
- [[Desktop gateway - Tauri]] — l'app Tauri/Rust: key, endpoint configurabile,
  chiamata al LLM, tray, ascolto Firestore.
- [[Companion mobile - Flutter]] — l'app Flutter: chat con login condiviso,
  invio prompt, turni live, risposte e push.

## Design

- [[UIUX - Overview]] — direzione visiva unica (smooth, minimale,
  ChatGPT/Copilot), onboarding dell'inferenza e token.

## Trasporto e push

- [[Firebase - trasporto e push]] — Firestore come relay, schema dei documenti,
  FCM e la Cloud Function che invia la notifica.

## Operatività

- [[Roadmap]] — build order, dipendenze e criteri di accettazione.
- [[Handoff - prompt per agenti]] — prompt pronti per avviare i progetti con un
  agente a contesto azzerato.
- [[Problemi noti]] — difetti confermati (vuoto finché il progetto non parte).

## Come è organizzata questa documentazione

Il vault documenta **un solo progetto per uso personale, pensato per essere
pubblicato open source**. Non contiene framework condivisi o note su altri
progetti.

Le note distinguono sempre tre cose:

1. **cosa è deciso** — la scelta e il perché;
2. **cosa si rompe se lo si cambia** — i vincoli che non sono nel compilatore;
3. **cosa non è ancora deciso o è rotto** — rimandi a [[Roadmap]] e
   [[Problemi noti]].
