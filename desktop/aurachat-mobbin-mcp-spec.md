# Spec — Supporto Mobbin MCP (OAuth + Vision) in AuraChat

## 1. Obiettivo

Permettere a un agent in AuraChat di collegarsi al **Mobbin MCP server**, ricevere gli
screenshot inline e **leggerli come input visivo**, così da usare Mobbin come fonte di
design reference (es. frame-picker "seleziona copertina" per l'upload video).

Blocco iniziale della specifica: AuraChat non automatizzava il flusso OAuth per i server MCP. Il collegamento
a `https://api.mobbin.com/mcp` fallisce con `401` / `MCP HTTP initialization failed`.

---

## 2. Perché serve il MCP (e non basta la REST API)

| Canale | Autenticazione | Cosa ritorna all'agent |
| --- | --- | --- |
| REST API | API key (Bearer) | `image_url` + `app_name` + `mobbin_url` (solo URL/metadati, **nessuna immagine inline**) |
| MCP | OAuth 2.0 | preview **inline** a bassa risoluzione "sized for the agent to read" + `image_url` hi-res |

Solo il canale MCP rende le immagini **leggibili dall'agent**. La REST API non è sufficiente
per "vedere" gli screenshot.

---

## 3. Requisiti

### Asse A — Client OAuth 2.0 per MCP (Streamable HTTP)

Mobbin usa **Dynamic Client Registration (RFC 7591)**: nessun `client_id` da provisionare a
mano e nessuna whitelist di redirect URI. Flusso richiesto (fonte:
`docs.mobbin.com/mcp/build-an-integration`):

1. Fetch protected resource metadata:
   `https://api.mobbin.com/.well-known/oauth-protected-resource/mcp`
   → scopre l'authorization server.
2. Fetch `.well-known/oauth-authorization-server` → endpoint OAuth completi
   (authorization, token, registration, JWKS, …).
3. **DCR**: registrare l'app → ottiene `client_id`.
4. Redirect utente all'endpoint di **authorization** con **PKCE `S256`** e scope **`openid`**
   (apertura browser).
5. Scambiare il code → **access token + refresh token**.
6. Chiamare il MCP a `https://api.mobbin.com/mcp` con header `Authorization: Bearer <token>`.
7. **Refresh token** automatico alla scadenza dell'access token.

Implementazione consigliata: usare un **MCP SDK** che gestisce l'OAuth automaticamente
(TypeScript o Python). AuraChat deve fornire solo:

- una **redirect URI** (callback locale);
- un **hook di persistenza token** (storage sicuro, es. keychain locale / vault account);
- il passo di apertura browser + cattura del callback.

### Asse B — Vision / input multimodale (requisito separato)

Il MCP ritorna per ogni risultato:

- una **preview low-res inline** per l'agent;
- un **`image_url` hi-res** (scade dopo 30 giorni).

Anche con l'OAuth funzionante, l'agent deve **ricevere le immagini come input visivo** nel
contesto, non come semplice testo/URL. Requisito da verificare sul modello AuraChat:
**il modello supporta input immagine nei risultati MCP?**

⚠️ Se AuraChat non supporta il multimodale, l'OAuth da solo non basta: va aggiunto anche il
passaggio delle immagini nel contesto del modello.

### Asse C — MCP Apps (opzionale, solo UX)

L'**interactive gallery** inline è disponibile per ChatGPT / Claude Desktop & Web / Codex, e per
qualunque client che supporti la spec **MCP Apps**
(`modelcontextprotocol.io/docs/extensions/apps`).

- Non necessaria perché l'agent "veda" gli screenshot.
- Utile per mostrare all'utente la gallery dei risultati nel client.

---

## 4. Tool che AuraChat deve esporre (dopo il collegamento)

`list_mcp_tools` dovrà mostrare, come minimo:

| Tool | Funzione |
| --- | --- |
| `search_screens` | Cerca schermate UI |
| `search_flows` | Cerca flussi multi-step (onboarding, checkout, …) |
| `search_sections` | Cerca sezioni web (pricing, footer, …) |
| `list_collections` / `get_collection_contents` | Lettura saved/collezioni |
| `save_content` / `create_collection` / `add_comment` | Gestione collezioni |

---

## 5. Non-goal

- **Nessuna API key** necessaria per il MCP (usa OAuth, non Bearer-key manuale).
- **Nessun provisioning `client_id`** (gestito via DCR).
- **Nessun costo integratore** (piano Pro/Team/Enterprise dell'utente copre il MCP).

---

## 6. Acceptance criteria

- [ ] AuraChat completa l'OAuth via browser e salva + refresha il token senza ri-auth.
- [ ] `list_mcp_tools` espone `search_screens` / `search_flows` / `search_sections`.
- [ ] Una chiamata a `search_screens` ritorna preview **leggibili dall'agent** (vision confermata).
- [ ] Access token scaduto → refresh automatico (nessun 401 a runtime).
- [ ] Revoca accesso (`disconnect`) gestita in modo pulito.

---

## 7. Open questions

1. Il modello usato da AuraChat è **multimodale** (accetta immagini nei risultati MCP)?
2. Dove persistere i token: **keychain locale** vs **account/vault** (multi-device)?
3. Servono entrambi i canali (MCP per vedere + REST API key per search programmatica) o solo MCP?

---

## 8. Riferimenti

- Introduction: https://docs.mobbin.com/mcp/introduction
- Features: https://docs.mobbin.com/mcp/features
- Build an integration: https://docs.mobbin.com/mcp/build-an-integration
- MCP Authorization spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
- MCP Apps spec: https://modelcontextprotocol.io/docs/extensions/apps
- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Python SDK: https://github.com/modelcontextprotocol/python-sdk
- Endpoint MCP: `https://api.mobbin.com/mcp`
- Protected resource metadata: `https://api.mobbin.com/.well-known/oauth-protected-resource/mcp`

## 9. Implementazione e stato della verifica

Implementati gli assi A e B con l'SDK Rust `rmcp` già presente, senza introdurre
un secondo runtime MCP. Accesso e navigazione riusano il browser interno a schede;
la gallery MCP Apps resta opzionale e non implementata.

- OAuth: discovery reale Mobbin compatibile; DCR, PKCE S256, callback loopback,
  salvataggio DPAPI Windows/Keychain macOS, rinnovo e disconnessione locale.
  L'accesso parte nella scheda interna; ↗ lo prosegue nel browser di sistema
  (account Chrome già presenti) e il callback riporta AuraChat in primo piano.
- Browser: profili cookie persistenti separati per account; password native
  WebView2 opt-in su Windows, senza accesso degli agenti, importazione o sync.
- Vision: preview inline inviate al provider come immagini; i modelli DeepSeek
  testuali usano il bridge esistente. Il fallimento sulle preview correnti è
  esplicito, mai mascherato da una risposta solo testuale.

Le fixture locali verificano registrazione, scambio/refresh concorrente, riapertura
dello store protetto, revoca, callback invalidi, catalogo, immagini HTTP oltre
256 KiB e richiesta multimodale al provider simulato. Le verifiche UI coprono
scheda interna, privacy, annullamento, disconnessione e preferenza password.
Gli acceptance criteria sopra rimangono da confermare contro **Mobbin reale**
con un piano abilitato e un modello visivo; non sono dichiarati superati sulla
sola fixture. Non verificati il prompt password/persistenza cookie in WebView2
reale né macOS (data store separati da macOS 14).

Decisioni sulle domande aperte: solo MCP; token locali protetti e non multi-device;
immagini dirette per modelli multimodali, bridge per i DeepSeek testuali supportati.
Disconnessione significa rimozione dei token locali/disabilitazione del server,
non revoca del consenso Mobbin né cancellazione dei cookie. La revoca remota va
eseguita sul sito del servizio.
