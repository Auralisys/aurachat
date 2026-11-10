# AuraChat — identità condivisa

Autorità: `AuraChat's vault/Content/Design/UIUX - Overview.md` e desktop esistente.
Modalità mobile: Operate. Home con progetti espandibili e chat recenti, ricerca e
menu laterale. Campo di scrittura sempre in basso. PC e progetto allineati a
sinistra sopra il campo nella conversazione; il PC conserva il suo nome Windows.

Palette del desktop attuale (`desktop/ui/styles.css`): sfondo #1b191f,
pannelli #29252f, sidebar #151319, campo #333038, testo #f5f0ff,
secondario #b4aebd. Viola protagonista nelle bolle utente #2a1458, azione primaria
#8b3fe0, selezione e controlli #bb93fb. Non sostituire le bolle viola con grigio.
Logo Auralisys esistente, superfici piatte, niente animazioni decorative.
Interazioni native Flutter, tap target almeno 48 dp, supporto al ridimensionamento
del testo. Login, caricamento, errore con riprova e PC offline espliciti.

## Mobile — riferimento confermato il 18 ottobre 2026

Riferimenti forniti: schermate ChatGPT/Codex iOS. Riprenderne semplicità,
spaziatura e comandi circolari, mantenendo tema e funzioni di AuraChat. Home con
progetti/recenti confermata dall'utente. Nessun controllo finto per allegati o voce.
Pulsanti di navigazione circolari da 48 dp anche nello slot leading dell'AppBar.
Campo compatto a riposo; durante la scrittura testo sopra e barra con opzioni,
permessi e modello sotto. Massimo quattro righe visibili prima dello scorrimento.
Ingrandimento testo e tastiera non devono nascondere il campo.

Transizioni brevi e interrompibili, disabilitate con Reduce Motion. Le nuove
risposte scorrono al fondo solo se l'utente era già vicino al fondo. La ricerca
conserva il filtro durante gli aggiornamenti di presenza del desktop.

I permessi sono quelli del progetto sul PC selezionato: Richiedi approvazione,
Approva per me, Accesso completo. Per l'accesso completo serve una conferma
esplicita; nessun cambio durante un turno del progetto. Le chat libere mostrano
come accedere ai permessi di progetto, senza simulare impostazioni indipendenti.

## Secondo polish mobile — 18 ottobre 2026

Palette e bolle viola confermate. Header e liste più compatti, gerarchia più
discreta, composer piatto. Usare i glifi condivisi con desktop (soprattutto
`new_chat`, cartelle e frecce) anziché le matite Material generiche per Nuova
chat; evitare azioni ripetute sempre visibili nei progetti chiusi. Origine e
hash in `mobile/assets/icons/provenance.json`. Il riferimento interazioni è
anche RDGestureDetector di rdcore: feedback immediato e ripristino al cancel,
con controlli nativi accessibili. Non introdurre dipendenze path da RD Core.

Cronologia assistant: testo intercalato a gruppi di ragionamento/operazioni,
dettagli espandibili per comando e agente, nessun reasoning inventato. Il
loader descrive il passo corrente; gli stati terminali non continuano a girare.
Slash picker nel composer con skill reali del progetto, stato vuoto esplicito.

## Desktop — lettura e streaming

Adattamento dei comportamenti di DeepSeek Harness, senza sostituire identita
Auralisys o funzioni esistenti. Testo della chat a 15 px, anteprima discreta
dell'ultima riga completa del ragionamento e dettagli Markdown su richiesta.
Nessuno shimmer sul testo; indicatore e timer restano nel gruppo delle attivita.
Codice copiabile, tabelle e collegamenti funzionano anche durante lo streaming.

Seguire il fondo e una scelta del lettore: risalire sospende lo scroll automatico,
**Vai in fondo** o un nuovo invio lo riattivano. I dettagli hanno uno scroll
indipendente. Posizione e aperture si conservano tra conversazioni nella sessione,
non fra riavvii. Gli aggiornamenti non ricreano i blocchi Markdown invariati.
Sotto 850 px la sidebar parte chiusa e si apre in overlay; la card attivita
parte chiusa sotto 1000 px. Nessun redesign del companion Flutter in questa fase.

## Desktop — commenti e browser

Commenti sulle immagini come marker numerati in accento su un'immagine pulita:
editor modale con l'immagine a sinistra e l'elenco dei commenti a destra (in
colonna sotto 820 px), badge col numero sulla miniatura, note sotto l'immagine
nel visualizzatore. Il browser interno occupa una scheda nel pannello destro:
barra compatta con indirizzo a pillola, sottile barra di caricamento,
maniglia di ridimensionamento accessibile da tastiera. La pagina nativa sparisce
sotto menu e dialog invece di coprirli. Rispetto di reduced-motion e forced-colors.

## Desktop — riepilogo, schede e testo incollato

Intestazione secondo il riferimento ChatGPT/Codex: menu, elenco del riepilogo,
separatore verticale e icona del pannello destro; nessun pulsante globo qui.
Il riepilogo da 304 px, limitato allo spazio disponibile, fluttua sotto il suo
pulsante senza spostare la chat. Pannello a schede indipendente con **+**,
chiusura per scheda, espansione/ripristino e Nascondi. Browser e Git condividono
il contenitore con i dettagli esistenti di Output, Fonti, Agenti e Shell.
Schede neutre con icona e titolo troncabile; nessun terminale interattivo o
controllo PR/MR simulato. Sotto 1000 px una vista alla volta: Nascondi torna alla chat.

Il testo incollato oltre 20 righe diventa un chip inline con icona documento e
numero di righe, senza consumare l'altezza del composer. Clic/Invio apre una
lettura modificabile con annulla/salva/rimuovi. Il testo completo resta nella
posizione originale del messaggio; il chip non implica una riduzione dei token.

## Desktop — utilizzo e costi

Pulsante compatto nell'intestazione con token e costo (`12,7k · 0,0047 $`), cifre
tabulari. Popover da 304 px sul pannello scuro con radius-xl: costo in grande,
barra a tre segmenti (cache in accento chiaro, ingresso nuovo in viola, uscita in
bianco), righe etichetta/valore e righe per modello con tag «sconto 50%». Numeri
in `k`/`M` con valore esatto nel tooltip, USD con due cifre significative.
Nelle impostazioni ogni modello ha un riquadro prezzi richiudibile con chip di
stato, riepilogo e campi con suffisso USD (una colonna sotto 600 px).