---
tags: [aurachat, client]
---

# Client — Overview

← [[Architettura - Overview]]

Due app in due cartelle affiancate al vault, dentro
la root del repository AuraChat:

- `desktop/` — **gateway Tauri/Rust**. Possiede la API key, chiama il LLM, sta
  nel tray, ascolta Firestore.
- `mobile/` — **companion Flutter** (Android/iOS). Chat con login condiviso,
  invia i prompt via Firestore, segue i turni live e riceve risposte e push.

Nessuna delle due parla direttamente con l'altra: comunicano **solo** tramite
Firestore (vedi [[Firebase - trasporto e push]]). È questo il vincolo che
permette al telefono di comandare il desktop anche su reti diverse e senza
aprire porte in ingresso.

Convenzioni condivise:

- endpoint `base_url`, `model` e `api_key` sono sempre **configurabili** e mai
  hardcoded; DeepSeek è solo il default.
- la key non va mai nel vault né nel repository: solo in configurazione locale.
