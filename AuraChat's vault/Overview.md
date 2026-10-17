---
tags: [aurachat, overview]
---

# AuraChat

Vault tecnico di AuraChat, un'app personale open source per portare un LLM
OpenAI-compatible (DeepSeek di default) dietro un gateway che gira sul proprio
computer e si comanda dal telefono, come ChatGPT/Copilot. BYOK: ognuno usa la
propria API key.

Il vault è una cartella del progetto AuraChat
(`C:\Users\lofio\Desktop\Dev\AuraChat`): codice e documentazione vivono
insieme. Aprire questa cartella come vault in Obsidian.

## Mappa

**Roadmap** — [[Roadmap]] è il punto di partenza: build order, criteri di
accettazione e cosa non è ancora autorizzato. Stato al 17 ottobre 2026:
gateway desktop Tauri implementato in `desktop/`, account Firebase e cronologia
Firestore in uso; shell desktop approvata con barra stretta, menu superiori e
sidebar interna. Sono implementati lettura delle root di progetto tramite tool,
dettatura locale Cohere e cronologia Firestore v2 separata dal tree utente.
Scrittura file, comandi, tre modalità di permesso e sub-agenti cancellabili
sono implementati; i comandi usano l'account Windows senza sandbox OS.
Mobile, relay/pairing e push restano da implementare. Stato UI e verifiche:
[[UI desktop - Refactor flat]]; stato operativo: [[Desktop gateway - Tauri]].

**Architettura** — [[Architettura - Overview]] è il punto di ingresso tecnico.
Da lì si diramano le note su client (desktop + mobile) e trasporto/push.

**Design** — [[UIUX - Overview]] fissa la direzione visiva unica: smooth,
minimale, alla ChatGPT/Copilot, con pairing e onboarding dell'inferenza
semplificati.

**REA** — [[ChatGPT desktop - Analisi locale]], nella cartella `Content/REA`,
documenta pacchetto analizzato, permessi, remoto, chat, baseline di 206 icone,
evidenze e limiti. Estrazioni, sessioni e screenshot restano in `.artifact/`,
solo locali e ignorati da Git.

**Client** — [[Client - Overview]] descrive le due app:
[[Desktop gateway - Tauri]] (gateway locale in Rust/Tauri) e
[[Companion mobile - Flutter]] (compagna in Flutter).

**Trasporto e push** — [[Firebase - trasporto e push]] descrive Firestore come
relay tra telefono e desktop, FCM per le notifiche e la Cloud Function che le
scatena. Firebase (`auralisys-chat`) è già in uso per account, configurazione
utente e cronologia; relay tra dispositivi e push restano pianificati.

**Avvio con altri agenti** — [[Handoff - prompt per agenti]] contiene i prompt
per riprendere il desktop esistente o avviare il mobile con contesto azzerato.

## Vincoli del progetto

- **DeepSeek è solo il default, non una dipendenza**: endpoint, modello e key
  sono configurabili; il gateway deve parlare con qualsiasi API
  OpenAI-compatible.
- **La grafica si decide prima di iniziare e non si rifà**: smooth e minimale
  come ChatGPT/Copilot, token-first. Direzione in [[UIUX - Overview]].
- **Firebase è in uso** per account, configurazione e cronologia
  (`auralisys-chat`). Quando servirà la push ad app chiusa, passerà comunque da
  FCM/APNs (non esiste alternativa self-hosted su iOS/Android).
- **Il desktop è un gateway con UI chat**: Tauri/Rust, tray e processo in
  background; frontend statico con progetti, conversazioni e impostazioni.
- **Nessuna key di API nel repository né nel vault**: la key (e la lista modelli)
  sta nel documento utente Firestore (decisione 17 ottobre 2026), non nel codice
  né nel vault.
- **L'accesso remoto non aumenta i costi del modello**: si paga solo
  input/output del LLM; il trasporto (Firestore/FCM) non consuma token.

## Come contribuire

Documentare una parte **reale** del progetto, collegandola da
[[Architettura - Overview]]. Le parti non implementate restano piano e decisioni con la loro motivazione,
**senza inventare dettagli non ancora decisi**.

Quando il codice esiste, le note contengono **fatti verificati sul codice** con
`file:riga`: non stimare, e se un numero non è stato verificato, verificarlo o
non scriverlo. Non duplicare in una nota nuova ciò che sta già in un'altra:
linkare con `[[...]]`.

Quando cambia un comportamento, aggiornare insieme codice e nota. Quando si
trova un difetto, aggiungerlo a [[Problemi noti]] con il rimando alla nota dove
è descritto.
