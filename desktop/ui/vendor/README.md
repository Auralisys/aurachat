Vendored browser libraries: marked 17.0.5 (MIT), DOMPurify 3.4.17 (Apache-2.0 OR MPL-2.0).
Used to render sanitized Markdown locally; no CDN requests at runtime.

## Icone Lucide

Lucide 1.59.0 (ISC), bundle browser completo `lucide.min.js`, caricato da
`index.html` e disponibile come `window.lucide`, anche offline. Licenza e
attribuzioni in `lucide.LICENSE`. L'azione `compose` (Nuova chat) usa
`MessageCirclePlus` tramite la funzione condivisa `icon()` in `app.js`.

Per aggiungere un'icona da JavaScript:

```js
const symbol = lucide.createElement(lucide.icons.Sparkles, {
  class: 'ui-icon',
  'aria-hidden': 'true',
});
button.appendChild(symbol); // Il pulsante deve avere un nome accessibile.
```

Per il markup: `<i data-lucide="sparkles" aria-hidden="true"></i>`, poi
`lucide.createIcons()` dopo aver inserito gli elementi nel DOM.

Fonte: https://lucide.dev/guide/lucide/getting-started
Pacchetto: https://registry.npmjs.org/lucide/1.59.0
Bundle e licenza estratti dal pacchetto npm dopo verifica SHA-512 con
`dist.integrity`. Per aggiornare, fissare la nuova versione, verificarne
l'integrità e sostituire entrambi i file insieme.

## Dettatura locale

Cohere Transcribe di Cohere Labs, conversione ONNX INT4 di cstr, licenza Apache 2.0 (speech-APACHE-2.0.txt). Pesi scaricati su richiesta da Hugging Face, revisione immutabile 2c870f89692c61348481884eb6e1222ec3ba25c9, verificati SHA-256. Motore Rust transcribe-rs 0.3.12 e ONNX Runtime tramite ort 2.0.0-rc.12. La conversione quantizza il modello originale senza addestramento aggiuntivo.

Fonti: https://huggingface.co/CohereLabs/cohere-transcribe-03-2026, https://huggingface.co/cstr/cohere-transcribe-onnx-int4, https://github.com/cjpais/transcribe-rs.
