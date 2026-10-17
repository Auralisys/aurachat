---
tags: [aurachat, design, desktop, implementazione]
---

# UI desktop — Refactor flat

← [[UIUX - Overview]] · [[Desktop gateway - Tauri]] · [[Roadmap]]

## Stato al 17 ottobre 2026

Interfaccia desktop approvata dall'utente e implementata nel frontend statico
Tauri, senza nuove dipendenze applicative. App ricompilata e riavviata dopo
l'ultimo intervento. Lo sfondo viola statico della nuova chat è stato mantenuto
su richiesta esplicita. Questa nota sostituisce la precedente composizione a
sidebar unica con account nel footer.

## Struttura approvata

- **Barra laterale stretta, sempre visibile nella chat:** Home in alto,
  impostazioni e avatar in basso. Home apre una nuova chat. L'avatar mostra le
  prime due lettere dell'account e apre il menu Account / Modelli e inferenza /
  Generali, senza chevron. Non è un caricamento di foto profilo.
- **Barra superiore:** indietro, avanti, compressione della sidebar interna e
  menu File, Modifica, Vista e Guida; restano i controlli finestra Windows.
  Indietro e avanti navigano le viste chat visitate nella sessione.
- **Pannello principale arrotondato:** contiene la sidebar interna e l'area chat,
  separate da un bordo sottile. Comprimere la sidebar nasconde solo progetti e
  recenti; la barra stretta con Home e avatar resta disponibile.
- **Sidebar interna:** marchio AuraChat, Nuova chat, Progetti e Recenti.
  Il pulsante Nuovo progetto compare soltanto sulla riga Progetti.
  Progetti e cartelle hanno icone SVG coerenti, senza il precedente quadrato
  vuoto; restano creazione, rinomina e organizzazione delle conversazioni.
- **Area chat:** nome della conversazione in alto a sinistra, token/contesto
  nell'header, messaggi utente a destra e risposte senza card aggiuntive.

Riferimenti: `desktop/ui/index.html:14` (barra superiore),
`desktop/ui/index.html:38` (barra stretta), `desktop/ui/index.html:47`
(pannello principale), `desktop/ui/index.html:48` (sidebar interna),
`desktop/ui/index.html:77` (titolo chat), `desktop/ui/styles.css:105`
(pannello), `desktop/ui/styles.css:152` (compressione).

## Nuova chat e compositore

- Nella nuova chat, titolo e compositore stanno al centro dell'area disponibile.
  Dopo l'invio, il compositore torna in basso e la conversazione può scorrere.
- Campo di scrittura sopra; modello e invio allineati in basso a destra.
  Il selettore modello è un menu scuro con indicazione della scelta corrente,
  navigazione da tastiera, Escape e ripristino del focus. La selezione viene
  salvata tramite il comando Tauri esistente `set_model`.
- Sotto il box della nuova chat c'è la scelta facoltativa del progetto.
  Senza progetto è il default; scegliendo un progetto il primo invio crea la
  conversazione nella sua prima cartella (creandola se manca).
- Aprire Nuova chat non crea automaticamente né un progetto né una conversazione:
  la conversazione viene creata al primo messaggio non vuoto.
  La scelta del progetto è disponibile sul nuovo draft, non sulle conversazioni
  già salvate.
- Allegati testuali e microfono hanno azioni reali; nessun controllo fittizio per tool, permessi o effort.

Riferimenti: `desktop/ui/index.html:94`, `desktop/ui/app.js:435`
(creazione al primo invio), `desktop/ui/app.js:517` (invio),
`desktop/ui/app.js:579` (modelli), `desktop/ui/app.js:621` (progetto),
`desktop/ui/app.js:851` (ingresso senza creazione automatica).

## Menu e scorciatoie

- **File:** Nuova chat, Nuovo progetto, Impostazioni.
- **Modifica:** Annulla, Ripristina, Seleziona tutto sul campo di testo attivo;
  annulla/ripristina usano la cronologia di modifica del WebView.
- **Vista:** mostra/nascondi sidebar e focus sul campo messaggio.
- **Guida:** istruzioni e scorciatoie in un dialogo dedicato.
- **Ctrl+N:** nuova chat; **Ctrl+B:** comprimi/espandi sidebar;
  **Ctrl+,**: impostazioni. Invio invia, Shift+Invio va a capo.
- Menu navigabili con frecce, Home/End ed Escape. I comandi non disponibili
  durante login o invio sono disabilitati nei menu.

Riferimenti: `desktop/ui/app.js:409` (cronologia di navigazione),
`desktop/ui/app.js:896` (menu), `desktop/ui/app.js:994` (shell),
`desktop/ui/index.html:103` (guida).

## Aspetto e impostazioni

Palette Auralisys conservata, superfici operative scure, icone SVG e avatar
compatto. Ombre riservate ai menu e agli elementi flottanti. Bagliore statico
su splash, onboarding e chat vuota; fondo uniforme durante la conversazione.
Il menu modello ha una breve transizione funzionale, disattivata quando il
sistema richiede movimento ridotto. Nessuna animazione dello sfondo.

Impostazioni a due colonne con Generali / Account / Modelli e inferenza,
chiusura Escape e focus contenuto nel dialogo. Generali descrive l'aspetto
corrente: non introduce selettori di tema o lingua. Lo stack font rimane
Plus Jakarta Sans → Inter → sans-serif, senza download di font.

Riferimenti: `desktop/ui/styles.css:75` (sfondo),
`desktop/ui/styles.css:203` (menu e movimento ridotto),
`desktop/ui/index.html:109` (impostazioni).

## Persistenza delle chat senza progetto

La mappa cronologia salvata in `users/{uid}.tree` contiene ora due raccolte alla radice:
`projects` (progetti con cartelle di origine e chat dirette) e `conversations` (chat senza
progetto). La ricerca, la modifica e i recenti includono entrambe.
Il campo nuovo ha `#[serde(default)]`: gli alberi precedenti senza
`conversations` continuano a caricarsi nel nuovo percorso utente. Il vecchio
`data/tree` condiviso e stato migrato nell'unico account il 17 ottobre 2026
su richiesta esplicita dell'utente, poi eliminato; vedi le note Firebase.

Riferimenti: `desktop/src-tauri/src/data.rs:18` (campo nuovo),
`desktop/src-tauri/src/data.rs:53` e `desktop/src-tauri/src/data.rs:64`
(ricerca), `desktop/src-tauri/src/data.rs:80` (test compatibilità).
Vedi [[Firebase - trasporto e push]] e [[Problemi noti]].

## Verifiche eseguite

- `desktop/tests/ui-smoke.cjs`: backend Tauri simulato, nessuna credenziale
  reale o chiamata Firebase/LLM. Passati: barra stretta persistente, pannello
  principale, indietro/avanti, menu File/Modifica/Vista/Guida, selezione testo,
  scorciatoie, menu modello da tastiera, impostazioni, chat, progetto facoltativo,
  chat senza progetto, menu account e sidebar comprimibile. Nessun errore JS.
- `desktop/tests/auth-flow.cjs`: login errato/valido, configurazione iniziale,
  ripristino al reload, errore di rete senza reset e Riprova: passati.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`: tre test Rust
  passati, inclusa serializzazione e lettura delle chat senza progetto.
- `cargo build --manifest-path desktop/src-tauri/Cargo.toml`: riuscita dopo
  l'ultimo aggiornamento della shell.
- Anteprime ispezionate a 1080×880 e 720×680; nessun overflow orizzontale a
  720×680. Il detector segnala un advisory sul clipping di `.workspace`, che
  contiene menu posizionati; le verifiche sopra non equivalgono a una copertura
  di tutte le dimensioni o di liste arbitrariamente lunghe.

## Anteprime e limiti

Catture dell'interfaccia con **dati di test**, non dell'account reale dell'utente:

![[desktop-shell-sidebar.png]]

![[desktop-shell-sidebar-compressa.png]]

Copie originali nel progetto: `.artifact/app-shell/sidebar-progetti.png` e
`.artifact/app-shell/sidebar-compressa.png`.

L'utente ha eseguito le proprie prove nell'app e approvato l'aspetto; i test
eseguiti dall'agente restano simulati per Firebase/LLM. Non è stata ripetuta
l'inferenza reale né completata una verifica automatizzata del WebView nativo.
Logout, registrazione, avatar personalizzato, tool e relativi permessi non sono
stati aggiunti. Relay/pairing, mobile e push restano gli scope successivi.

Per avviare il desktop: dalla cartella `desktop`, `cargo tauri dev`.

## Hover progetti, menu cartelle e icone (17 ottobre 2026)

Righe di progetto, cartella e chat evidenziate su hover e focus. Anteprima del
progetto dopo una breve sosta del puntatore: nome, numero chat e cartelle.
Menu accessibile con pulsante ellissi, clic destro o Shift+F10: nuova cartella
sul progetto; nuova chat, rinomina e rimozione sulla cartella. Rimuovere una
cartella sposta le sue chat tra quelle senza progetto, mantenendole nei Recenti.
Il menu lo indica prima dell'azione. Elimina progetto resta un'azione separata.

Icone SVG centralizzate in `ICONS` in `desktop/ui/app.js`, stessa griglia,
tratto arrotondato e dimensioni coerenti tra sidebar, navigazione e compositore.
I loghi Auralisys restano gli asset originali. Nessuna nuova dipendenza.
Anteprime e menu sono esterni al contenitore della sidebar per evitare clipping;
si chiudono con Escape, clic esterno, scroll, cambio vista o ridimensionamento.
Supportate frecce, Home/End, focus di ritorno e riduzione del movimento.

`desktop/tests/project-menus.cjs`: backend simulato; verificati hover, conteggi,
menu mouse/tastiera, creazione/rinomina/rimozione, conservazione delle chat,
ripristino dopo errore di salvataggio e posizionamento a 1080x880 e 720x680.
Catture in `.artifact/project-menus/`. Detector: solo advisory preesistente sul
menu modello dentro `.workspace`, non sulle nuove anteprime o sui nuovi menu.

## Correzione gestione progetti e header (17 ottobre 2026)

Questa sezione sostituisce la precedente organizzazione in cartelle virtuali.
Le chat stanno direttamente nel progetto. Le cartelle indicate nell'editor
sono percorsi reali sul computer, scelti con selettore nativo e consenso locale
in lettura. L'editor offre nome, cartelle di origine e rimozione dei collegamenti;
nessun campo Memoria o funzione di importazione viene aggiunto senza richiesta.

Riga progetto: freccia di espansione, cartella, nome, menu ellissi e pulsante
nuova chat esterno al menu. Il menu contiene Modifica progetto, Rinomina ed
Elimina progetto con il numero di chat. Hover: anteprima con nome, conteggio e
percorsi di origine. Nuova chat apre una bozza nel progetto; crea la conversazione
al primo invio. Anche l'icona nuova chat e stata corretta a quadrato e matita.

Progetti e Recenti hanno header omogenei e comprimibili, freccia su hover/focus o a sezione chiusa,
ellissi e + visibili su hover/focus. I menu consentono creazione e compressione.
Stati vuoti con una sola azione: Crea progetto in Progetti, Nuova chat in Recenti,
allineate a sinistra con gli header, senza etichette vuote ridondanti.
Progetto senza chat: Avvia la prima chat. Le righe nei Recenti hanno
menu ellissi con rinomina/eliminazione e supporto al clic destro/tastiera.

Test `desktop/tests/project-menus.cjs` aggiornato al nuovo modello; fixture di
`ui-smoke.cjs` e `auth-flow.cjs` aggiornate. Anteprime attuali in
`.artifact/project-model/` a 1080x880 e 720x680. I precedenti screenshot dei menu
cartelle virtuali descrivono il comportamento superato.

## Sidebar: selezione contestuale e loader (17 ottobre 2026)

La selezione della chat dipende dall'ID e dalla sezione da cui viene aperta:
cliccando sotto Progetti si evidenzia solo quella riga; cliccando nei Recenti
si evidenzia solo l'occorrenza nei Recenti. Indietro/Avanti conserva anche la
sezione di provenienza. Una nuova bozza rimuove la selezione precedente.

Durante una richiesta al modello compare un piccolo loader circolare a destra
della chat, in entrambe le liste quando la conversazione vi è presente. Indica
una richiesta effettivamente in corso e scompare sia al completamento sia in
caso di errore. L'animazione rispetta la preferenza di movimento ridotto.

Il riferimento fornito dall'utente guida righe compatte da 32 px, titoli senza
icona chat ripetuta, chat di progetto rientrate e azioni ellissi su hover/focus.
Le frecce dei progetti compaiono su hover/focus; gli header di sezione mostrano
la freccia anche quando sono chiusi. Restano disponibili menu e tastiera.

Conferma finale dell'utente: mantenere queste modifiche e ripristinare soltanto
lo sfondo viola scuro originale della sidebar, `var(--c-sidebar)` (`#151319`).
Rimosso l'override carbone `#1c1c1c`; hover e selezione restano rispettivamente
`#252525` e `#303030`.

Verifiche browser con backend simulato: passati `sidebar-selection.cjs`,
`ui-smoke.cjs`, `project-menus.cjs` e `lazy-history.cjs`. Coprono selezione unica,
cronologia di navigazione, tastiera, loader su successo/errore, menu e caricamento
differito. L'ultimo ripristino dello sfondo è stato verificato nel CSS;
l'eseguibile desktop non è stato ricompilato. Le catture in
`.artifact/sidebar-selection/` precedono il ripristino del colore di sfondo.


## Conversazione e audio — aggiornamento 17 ottobre 2026

Colonna 760 px, testo Segoe UI di sistema, superfici neutre e messaggi utente
viola: `--c-user` usa `--c-card` (Plum Card, `#2a1458`). Conferma dell'utente
del 17 ottobre 2026: il riferimento ChatGPT guida la disposizione, mentre i
balloon mantengono la palette viola Auralisys. Sostituito il precedente blu
`#1d3e6d`. Markdown sanificato e azioni copia, modifica, rigenera, feedback e lettura
con voci del sistema. Allegati testuali dal +, visibili come chip e inviati col
messaggio. Token raccolti nel dettaglio contesto.

Dettatura locale Cohere scaricabile in Impostazioni → Voce. Nella toolbar,
X / forma d'onda reale / Stop / Invio. Stop trascrive nella bozza, Invio trascrive
e invia con testo e allegati preesistenti; X scarta solo l'audio. Icone centrate
con grid, senza allineamento alla baseline del testo. Stati di preparazione,
elaborazione, permesso negato e download interrompibile/riprendibile. Audio in
memoria, massimo due minuti; lingua italiana/inglese secondo UI. Il modello
viene caricato in memoria all'avvio dell'app: finché non è pronto il microfono è
disabilitato con un piccolo loader circolare sull'icona (20 px, animazione
disattivata con movimento ridotto o finestra in background) e un click anticipato
non produce nulla; nessun invio audio a servizi esterni. Riferimenti:
`desktop/ui/voice.js:45` (warm-up), `desktop/ui/styles.css:511` (loader).

Le chat caricano i messaggi all'apertura dal nuovo storage separato. Navigazione
ed errori non spostano risposte tardive in una chat diversa. Gli strumenti di
progetto mostrano il file/cartella in lettura mentre il modello lavora.


### Ritmo della forma d'onda

Dopo la segnalazione di scorrimento troppo rapido, la visualizzazione aggrega
l'energia su finestre audio di 100 ms: dieci nuove barrette al secondo, a qualsiasi
frequenza di campionamento. Prima, a 16 kHz, avanzava ogni 128 campioni (8 ms).
La modifica riguarda la visualizzazione, senza rallentare acquisizione o
trascrizione. X e Stop sono centrati nel pulsante tramite grid; il test UI
controlla il centro geometrico delle icone e il numero di barrette per secondo.
Codice: `desktop/ui/voice.js:125`; test `desktop/tests/voice-flow.cjs` passato.

## Permessi, attività e icone — 17 ottobre 2026

CTA dei permessi a sinistra, accanto al + degli allegati, con tre modalità
effettive confermate dal backend e approvazioni inline. Dettagli operativi e
limite di assenza sandbox OS: [[Desktop gateway - Tauri]].

Reasoning e operazioni aggiornano nodi stabili, preservando focus e dettagli
aperti. Lo shimmer indica lavoro attivo, l'attesa di consenso ha stato distinto;
loader e animazioni rispettano movimento ridotto e visibilità della finestra.
Sidebar e pannello attività mantengono palette, superfici e dimensioni AuraChat.

Importata una baseline di 206 SVG selezionati dall'utente; `new_chat.svg`
sostituisce `new_chat_os_windows`. Home, Nuova chat, frecce, chevron, spunta e
agenti usano già gli asset estratti. Le altre icone restano disponibili in
`desktop/ui/assets/icons/`; simboli non sostituiti continuano a usare Lucide
o i glifi esistenti. Provenienza e dettagli in [[ChatGPT desktop - Analisi locale]].

Verifica corrente: tutte le 13 suite browser passate, inclusi permessi,
approvazioni, attività, reasoning, sidebar, layout compatto e icone.
Screenshot solo locali in `.artifact/`, ignorata da Git insieme al percorso
legacy `artifacts/`; le vecchie catture sono state conservate localmente e
rimosse dal tracciamento. Gli SVG scelti per l'app restano versionati.


### Cartelle progetto e righe chat

Aggiunti 35 SVG `folder_*` alla baseline (206 totali), con provenienza e hash
nel manifest. Il progetto mostra `folder_closed` quando compresso e
`folder_open` quando espanso, seguendo lo stato nativo di details anche da
tastiera. Le chat nei progetti e nei Recenti non mostrano icona a sinistra;
quelle di progetto mantengono il rientro rispetto al titolo del progetto.

La cartella chiusa è ridotta otticamente al 90%, mantenendo lo stesso spazio
di layout e lasciando invariata la dimensione della cartella aperta.
Nuova chat usa una riga da 32 px, icona da 16 px, gap e padding orizzontale
da 8 px: icona e testo sono allineati alle righe progetto. Il margine sotto
l'azione scende da 16 a 4 px, avvicinandola all'header Progetti.

### Accesso completo: segnale visivo

Quando il backend conferma la modalità full, la CTA dei permessi mostra uno
scudo con punto esclamativo; icona e label usano arancione `#f99741`.
Tornando alle altre modalità si ripristinano scudo standard e colori normali.
Il cambiamento riguarda la presentazione, senza modificare le autorizzazioni.

Verifiche degli ultimi ritocchi: `sidebar-selection.cjs`, `ui-smoke.cjs`,
`project-menus.cjs` e `permissions.cjs` passati. Coperti cambio cartella con
mouse/tastiera, chat senza icone, ripristino degli stati e colore di icona/label.
Screenshot controllati in `.artifact/sidebar-selection/` e
`.artifact/permissions/full-access.png`. Eseguibile desktop non ricompilato;
le 13 suite e i 32 test nativi citati sopra sono la verifica completa precedente.

## Impostazioni, reasoning e tipografia — aggiornamento finale 17 ottobre 2026

Questa sezione aggiorna i riferimenti precedenti alle impostazioni e al reasoning.
Il dialogo è compatto e centrato (massimo 860 × 600 px), con sidebar e ricerca;
Account è separato da Provider di modelli. Flusso, migrazione, storage e limiti in
[[Impostazioni e provider di modelli]]. In chat, logo DeepSeek bianco + modello;
senza logo specifico: Provider · modello.

Un solo “Ragionamento e attività” espandibile dentro il messaggio assistente,
nella posizione della precedente riga con cervello bianco. Durante il turno
il cervello diventa viola e pulsa; tempo trascorso e conteggio sono nella stessa
intestazione. Rimossa la riga separata sopra il composer che alternava estratti
di reasoning e attività. L’elenco conserva passaggi e contenuti, dettagli aperti
e nodi stabili durante lo streaming; a turno terminato il cervello è statico.
L’attesa di consenso non pulsa; movimento ridotto e finestra nascosta sono rispettati.

Messaggi e input a 13 px (--fs-chat), titoli Markdown riproporzionati, codice
invariato a 13 px. Lo stack attuale è Segoe UI Variable → Segoe UI → Arial → sans-serif.
Codice: desktop/ui/chat-progress.js:22 (elenco), :56 (composizione messaggio),
desktop/ui/styles.css:50 (dimensione chat), :538 (cervello animato).

Verifiche aggiornate: chat-progress.cjs, operations-flow.cjs, background-chats.cjs,
chat-tools.cjs, activity-panel.cjs e ui-smoke.cjs passati. Servizi nativi simulati;
controllati elenco unico, timer, nodi/dettagli stabili, cronologia, layout compatto,
movimento ridotto e assenza della riga duplicata. Catture locali in .artifact/chat-progress/.
