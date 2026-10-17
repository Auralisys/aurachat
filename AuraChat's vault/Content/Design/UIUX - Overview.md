---
tags: [aurachat, design, uiux]
---

# UIUX — Overview

← [[Overview]] · [[Architettura - Overview]]

Direzione visiva unica per le due app: **smooth e minimale, come ChatGPT e
Copilot**, su tema scuro e palette **Auralisys**. Poche informazioni, ma fatte
bene: niente pannelli densi, una sola azione principale per schermo, molto
respiro.

## Principi

- **Poche informazioni, ben fatte.** Mostrare solo ciò che serve alla decisione
  del momento; il resto dietro un passaggio in più, non in un'unica schermata
  densa.
- **Flat e statico (17 ottobre 2026).** Nessuna particella, flare, aurora animata
  o animazione decorativa. Bagliori viola diffusi, statici e discreti soltanto
  su splash, onboarding e chat vuota. Conversazione su fondo uniforme.
- **Testo prima delle icone nei contenuti.** La barra di navigazione stretta
  usa icone con nome accessibile e tooltip; progetti, chat e menu mantengono
  etichette leggibili.
- **Stati vuoti e caricamento curati.** Un'app minimale vive o muore su
  empty state, loading ed errore ben fatti.
- **Token-first.** Colori, spaziature e tipografia sono **token** definiti una
  volta sola, non valori sparsi. Cambiare tema o palette non deve rifare il
  layout: è la garanzia di "non dover rifare la grafica".

## Palette e tipografia — Auralisys

Sorgente verificata: `DESIGN.md` del sito Auralisys
(`C:\Users\lofio\Desktop\Dev\Node.js\website`). Tema di default **scuro**.

- **Accento (Electric Violet)** `#8b3fe0` — il "lavanda" del brand, unico
  colore per azione primaria, link, stato attivo (regola: un solo accento).
- **Compagno chiaro (Orchid Glow)** `#bb93fb` — evidenze, glow, hover; mai
  come riempimento primario.
- **Sfondo** `#170b33` (Void Indigo) base scura; `#0d081f` (Console Ink) per
  superfici più "operate".
- **Card/pannello** `#2a1458` (Plum Card) / `#15102a` (Console Panel).
- **Testo** `#f5f0ff` (primario, quasi-bianco con velo viola), `#b79fde`
  (secondario, Muted Lilac).
- **Bordo hairline** `rgba(187, 147, 251, 0.18)`.
- **Distruttivo** `#d4183d`.
- **Font** `Plus Jakarta Sans` → `Inter` → sans-serif (font del brand;
  default, sovrascrivibile).
- **Logo** — il mark Auralisys SVG (viewBox `0 0 34 32`, fill Orchid Glow
  `#bb93fb`): `Content/Design/Riferimenti/logo-auralisys.svg`. È l'icona/logo
  di AuraChat.

Profondità: niente ombre sulle superfici a riposo — bordo hairline + glow
ambientale; `box-shadow` solo su ciò che fluttua (modali, popover). Angoli
sempre morbidi, mai rettangoli netti.

## Pairing (associazione)

Deve essere immediato, sul modello "collega un dispositivo" di ChatGPT:

1. il desktop mostra un **codice corto** (es. 6 cifre) o un QR;
2. il telefono, al primo avvio, mostra una sola schermata: "Inserisci il
   codice";
3. inserito il codice, la sessione è condivisa e si apre la chat. Fine.

Niente account, niente email, niente conferme multiple.

## Onboarding e configurazione attuali

Accesso email/password Firebase e configurazione inferenza. Le credenziali di
accesso restano locali; per decisione successiva allo scope iniziale, API key LLM,
mappa modelli e modello attivo sono nel documento utente Firestore. Vedi
[[Firebase - trasporto e push]]. I precedenti vincoli “key solo sul desktop” e
“nessun account” descrivono il piano iniziale, superato dalle decisioni della sessione.

## Refactor desktop — 17 ottobre 2026

Implementazione e verifiche: [[UI desktop - Refactor flat]]. Riferimenti forniti
dall'utente: composizione chat/sidebar ChatGPT, impostazioni e menu account del
client mostrato negli screenshot, atmosfera viola dell'ultimo riferimento.
Le scritte negli screenshot sono contenuti di riferimento, non istruzioni operative.

- Barra stretta persistente con Home, impostazioni e avatar; barra superiore
  con indietro/avanti, compressione sidebar e menu File / Modifica / Vista / Guida.
- Pannello principale arrotondato, con sidebar interna di progetti/cartelle/chat
  e recenti separata dalla conversazione. Nuovo progetto solo sulla riga Progetti.
- Avatar compatto senza chevron; la barra stretta resta anche comprimendo la sidebar.
- Menu account con accesso alle sezioni Generali, Account, Modelli e inferenza.
- Impostazioni a due colonne, focus tastiera contenuto nel dialogo e chiusura Escape.
- Chat con misura di lettura limitata, messaggi utente a destra con balloon viola
  Plum Card (`#2a1458`), risposte senza card.
- Nuova chat con titolo e compositore centrali, scelta facoltativa del progetto
  sotto il box; al primo invio il compositore torna in basso. Menu modello
  scuro e invio allineati a destra, nome chat in alto a sinistra.
- Chat senza progetto supportate in cronologia; apertura della nuova chat senza
  creare progetti o conversazioni vuote. Token/contesto nell'header.
- Splash di caricamento con logo centrale, stesso bagliore statico minimale
  dell'onboarding. Nessuna attesa artificiale per prolungare la splash.
- Palette Auralisys conservata negli accenti, superfici operative scure più neutre.
- Sidebar: selezione della sola occorrenza aperta in Progetti o Recenti, loader
  circolare a destra durante la richiesta e righe compatte senza icone chat.
  Confermato lo sfondo viola scuro originale `--c-sidebar` (`#151319`), con hover
  e selezione neutri. Dettagli e verifiche in [[UI desktop - Refactor flat]].
- Font: stack Plus Jakarta Sans → Inter → sans-serif, senza font scaricati.

## Correzione account e autologin (17 ottobre 2026)

Login separato dalla configurazione iniziale, ripristino sessione tramite refresh
token, password non più salvata, configurazione LLM recuperata dal documento
utente. Gli errori di rete non riaprono il primo avvio. Stato e verifiche in
[[Account - Login e ripristino sessione]].
