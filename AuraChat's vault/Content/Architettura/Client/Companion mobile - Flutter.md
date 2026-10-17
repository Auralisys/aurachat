---
tags: [aurachat, client, flutter]
---

# Companion mobile — Flutter

← [[Client - Overview]]

App Flutter (Android/iOS) che comanda il gateway da remoto. È il "ChatGPT sul
telefono", ma per il proprio gateway.

## Responsabilità

- chat con il modello: l'utente scrive, il prompt va in Firestore;
- **pairing**: inserisce il codice mostrato dal desktop per condividere lo stesso
  contesto di sessione;
- ascolta Firestore per la risposta del desktop;
- riceve la **push FCM** quando il desktop finisce, anche ad app chiusa;
- configurazione endpoint/modello cambiabile anche dal telefono (comando al
  desktop); la key resta sempre e solo sul desktop.

## Vincoli

- la companion **non chiama mai il LLM direttamente**: passa sempre dal gateway.
  La key sta solo sul desktop.
- la notifica ad app chiusa richiede FCM (e APNs su iOS): nessuna alternativa
  self-hosted, per decisione in [[Architettura - Overview]].
- il pairing deve funzionare senza account: il "legame" è un ID sessione
  condiviso in Firestore, non un login.

## Non ancora deciso

- persistenza locale della cronologia (sqlite/hive) e modalità offline.
