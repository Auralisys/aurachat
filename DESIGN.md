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
