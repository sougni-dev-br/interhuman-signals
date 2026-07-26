# 🔬 Análise Completa do Projeto — `interhuman-signals` (ego signals)

> Análise técnica gerada por Claude Code em 2026. Levantamento feito sobre o estado atual do repositório (`git` na branch `main`, último commit `5e3b00b`). **Regra deste documento: brutalmente honesto. Onde algo não existe, está escrito `NÃO ENCONTRADO`.**

---

## 1. VISÃO GERAL

| Item | Valor |
|---|---|
| **Nome** | `interhuman-signals-realtime` (produto: **ego signals**) |
| **Propósito** | Página que abre webcam+microfone, envia chunks de vídeo (~3s) via WebSocket para a **Interhuman Signals API**, e exibe em tempo real 12 sinais sociais + engagement + Conversation Quality Index. Ao fim de uma sessão de ~2min (5 perguntas provocativas), gera um "perfilamento" comportamental via Claude. |
| **Tipo de aplicação** | Web app estático (HTML/CSS/JS vanilla) + backend Node que atua como **proxy seguro de WebSocket** e **endpoint de report** (Claude). |
| **Em produção?** | **SIM.** Frontend em `https://ego.sougni.com` (SiteGround, estático). Backend em `https://ego-backend-lerb.onrender.com` (Render). Deploy do backend é **auto no `git push`**; deploy do frontend é **manual** (upload via SiteGround File Manager). |

**Stack completa:**

- **Runtime:** Node.js `>=18` (rodando em 20/22).
- **Backend:** Express `4.22.2`, `ws` `8.21.0` (WebSocket server + proxy), `@anthropic-ai/sdk` `0.30.1`, `dotenv` `16.6.1`. ES Modules (`"type": "module"`).
- **Frontend:** HTML5 + CSS3 (vanilla, sem framework, **sem build step**) + JavaScript ES Modules. `MediaRecorder` (WebM/VP9/opus), Web Audio API (monitor de voz por RMS), Canvas (card de compartilhamento), Web Share API. Fontes: Montserrat + Fraunces (Google Fonts).
- **APIs externas:** Interhuman Signals (`wss://api.interhuman.ai/v1/stream/analyze`), Anthropic Claude (`claude-sonnet-4-6`).
- **Infra:** SiteGround (estático) + Render (Node) + GitHub (`sougni-dev-br/interhuman-signals`).

---

## 2. ESTRUTURA

`tree` não está instalado no ambiente — árvore reconstruída manualmente (nível 4, excluindo `node_modules`/`.git`/`.claude`):

```
interhuman-signals/
├── .env                              # (gitignored) segredos reais de dev
├── .env.example
├── .gitignore
├── .read-ai-state.json               # (gitignored) estado OAuth Read.AI — DEAD/legado
├── ANALISE_PROJETO.md                # este arquivo
├── EGO_SIGNALS_METRICAS_INFERENCIAS.md
├── PROMPT_CLAUDE_DESIGN.md
├── README.md
├── package.json
├── package-lock.json
├── render.yaml                       # Render Blueprint (stale, ver §12)
├── read-ai-client.js                 # DEAD CODE (não referenciado)
├── server.js                         # ★ ponto de entrada / backend inteiro
└── public/                           # ★ frontend estático
    ├── app.js                        # v1 (legado)
    ├── config.js                     # v1
    ├── index.html                    # v1 (dashboard)
    ├── login.html                    # página de privacidade (entrada)
    ├── styles.css                    # v1
    └── v2/                           # ★ fluxo ativo em produção
        ├── app.js
        ├── config.js
        ├── index.html
        └── styles.css
```

**Arquivos por tipo (fora de `node_modules`/`.git`/`.claude`):**

| Tipo | Qtd |
|---|---|
| `.js` | 6 |
| `.md` | 3 |
| `.json` | 3 |
| `.html` | 3 |
| `.css` | 2 |
| `.yaml` | 1 |
| dotfiles (`.env`, `.env.example`, `.gitignore`) | 3 |

**Linhas de código por linguagem** (`cloc` indisponível — contagem via `wc -l`, excluindo `node_modules` e `package-lock.json`):

| Linguagem | Linhas | Arquivos |
|---|---:|---|
| JavaScript | **2.709** | server.js (523), v2/app.js (1124), app.js (904), read-ai-client.js (142), 2× config.js (16) |
| CSS | **2.234** | v2/styles.css (1172), styles.css (1062) |
| HTML | **914** | login.html (389), v2/index.html (273), index.html (252) |
| Markdown | 392 | (docs gerados) |
| YAML | 19 | render.yaml |
| JSON (fonte) | ~25 | package.json (20), .read-ai-state.json (5) |
| **TOTAL (fonte)** | **~6.293** | |

> Observação: `package-lock.json` tem 39.718 bytes (~1.100 linhas) e não é contado como código-fonte.

---

## 3. DEPENDÊNCIAS

**`package.json` (completo):**

```json
{
  "name": "interhuman-signals-realtime",
  "version": "1.0.0",
  "description": "Camera ao vivo -> Interhuman Signals API (12 sinais sociais + engagement + CQI) com proxy seguro de WebSocket",
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "dotenv": "^16.4.5",
    "express": "^4.21.2",
    "ws": "^8.18.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- **`requirements.txt` / `go.mod` / `Gemfile` / `pom.xml`:** `NÃO ENCONTRADO` (projeto puramente Node).
- **`devDependencies`:** `NÃO ENCONTRADO` (nenhuma — sem lint, sem test, sem build tooling).

**Desatualizadas (`npm outdated`):**

```
Package            Current  Wanted   Latest
@anthropic-ai/sdk   0.30.1  0.30.1  0.115.0   ← gap ENORME (major)
dotenv              16.6.1  16.6.1   17.4.2   ← major atrás
express             4.22.2  4.22.2    5.2.1   ← major atrás (Express 5)
ws                  8.21.0  8.21.1   8.21.1   ← patch atrás
```

**Vulnerabilidades (`npm audit`):**

```
body-parser  <1.20.6  — DoS quando limit inválido silenciosamente desabilita
                        a checagem de tamanho (GHSA-v422-hmwv-36x6)
Severidade: 1 low. Correção: `npm audit fix`.
```

- `pip-audit`: N/A (sem Python).

---

## 4. ARQUITETURA

**Diagrama de camadas (fluxo real):**

```
┌──────────────────────────────────────────────────────────────────┐
│  NAVEGADOR (ego.sougni.com — estático no SiteGround)               │
│                                                                    │
│  login.html (privacidade) ──CTA "INICIAR TESTE"──► POST /auth      │
│        │  guarda token guest em localStorage                       │
│        ▼                                                            │
│  /v2/index.html + v2/app.js  (máquina de estados de fase:          │
│     idle → connecting → questioning → finalizing → reporting)      │
│     - getUserMedia (câmera/mic) → MediaRecorder (WebM 3s)          │
│     - Web Audio API (RMS → detecção de voz por pergunta)           │
│     - Canvas (card de compartilhamento) / Web Share API           │
└───────────────┬───────────────────────────────┬──────────────────┘
                │ WebSocket (/ws?t=token)         │ POST /v2/report
                ▼                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  BACKEND Node/Express (Render) — server.js (monólito)             │
│                                                                    │
│  ┌── HTTP ──────────────────┐   ┌── WS proxy ──────────────────┐  │
│  │ /health   /auth          │   │ wss.on('connection'):        │  │
│  │ /report   /v2/report     │   │   checkOrigin → verifyToken  │  │
│  │ (checkOrigin + Claude)   │   │   → abre upstream Interhuman  │  │
│  └──────────────────────────┘   │   → bridge bidirecional       │  │
│                                  └──────────────┬───────────────┘  │
│  Auth: HMAC-SHA256 token (b64url payload.sig)   │                  │
│  API key injetada só no servidor ───────────────┼──► Authorization │
└──────────────────────────────────────────────────┼─────────────────┘
                          │                          ▼
                          ▼            wss://api.interhuman.ai/v1/stream/analyze
              Anthropic Claude API (perfilamento markdown)
```

**Padrões de projeto identificados:**

- **Reverse proxy / gateway** — o backend existe primariamente para esconder a `INTERHUMAN_API_KEY` (o browser nunca a recebe). Bom padrão.
- **State machine (frontend)** — fases controladas por `body[data-phase]` + `setPhase()`.
- **Token stateless (HMAC)** — auth sem sessão no servidor; token assinado `base64url(JSON).base64url(HMAC)`.
- **Graceful degradation** — `/report` cai em `ruleBasedReport()` se o Claude falhar ou não estiver configurado; share cai em texto → menu de redes.
- **Monólito de arquivo único** — todo o backend (rotas, auth, WS, prompts) vive em `server.js`. Sem camadas controller/service/repo.

**Como os módulos se comunicam:** frontend → backend via HTTP (report/auth) e WebSocket (streaming). Backend → Interhuman via WS upstream; backend → Anthropic via SDK HTTP. **Não há comunicação entre módulos internos** (não há módulos internos — é um arquivo).

**Fluxo de dados principal:** vídeo (browser) → chunks WebM → WS proxy → Interhuman → eventos de sinais (JSON) → browser renderiza → ao fim, payload agregado (`buildReportPayload`) → `POST /v2/report` → `enrichSessionPayload` → Claude → markdown → render + card de compartilhamento.

---

## 5. ARQUIVOS CRÍTICOS (conteúdo completo)

### 5.1 Ponto de entrada — `server.js` (523 linhas — entrada + rotas + auth + middleware + WS proxy)

```js
// Interhuman Signals — Realtime Camera proxy + perfilamento backend
//
// Architecture:
//   Browser <--ws--> THIS PROXY <--wss--> api.interhuman.ai/v1/stream/analyze
//   Browser ---POST /report---> THIS PROXY ----> Anthropic Claude (perfilamento)

import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.INTERHUMAN_API_KEY;
const PORT = Number(process.env.PORT || 3737);
const UPSTREAM_URL = 'wss://api.interhuman.ai/v1/stream/analyze';
const PASSCODE = process.env.PASSCODE || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// Auth — USERS é uma string "email1:senha1,email2:senha2" no env do Render.
// TOKEN_SECRET assina os tokens HMAC; default deriva do PASSCODE pra não ter
// que setar mais uma env var.
const USERS = parseUsers(process.env.USERS || '');
const TOKEN_SECRET = process.env.TOKEN_SECRET || PASSCODE || 'change-me';
const TOKEN_TTL_HOURS = Number(process.env.TOKEN_TTL_HOURS || 24);

function parseUsers(raw) {
  const m = new Map();
  for (const pair of raw.split(',')) {
    const [email, pass] = pair.split(':');
    if (email && pass) m.set(email.trim().toLowerCase(), pass);
  }
  return m;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest());
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expectedSig = b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest());
  // constant-time comparison
  const a = Buffer.from(sig); const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

if (!API_KEY) {
  console.error('[fatal] INTERHUMAN_API_KEY ausente em .env');
  process.exit(1);
}

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({
  ok: true,
  upstream: UPSTREAM_URL,
  passcodeRequired: Boolean(PASSCODE),
  originsAllowed: ALLOWED_ORIGINS,
  aiReportEnabled: Boolean(ANTHROPIC_API_KEY),
  aiModel: ANTHROPIC_API_KEY ? ANTHROPIC_MODEL : null,
  authEnabled: USERS.size > 0,
  userCount: USERS.size,
  guestEnabled: true,
  v2Endpoints: ['/v2/report'],
}));

// ============= /auth — login com email + senha =============
app.options('/auth', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  });
  res.status(204).end();
});
app.post('/auth', (req, res) => {
  if (!checkOrigin(req)) return res.status(403).json({ error: 'origin not allowed' });
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');

  const { email, password, rememberMe, guest } = req.body || {};

  // GUEST mode — token sem credencial, TTL 1h, role=guest
  if (guest === true) {
    const exp = Math.floor(Date.now() / 1000) + 3600;  // 1h
    const guestEmail = 'visitante@ego.local';
    const token = signToken({ email: guestEmail, exp, role: 'guest' });
    return res.json({ ok: true, token, email: guestEmail, exp, role: 'guest' });
  }

  if (!email || !password) return res.status(400).json({ error: 'email e senha são obrigatórios' });
  if (!USERS.size) return res.status(503).json({ error: 'auth não configurado no servidor (USERS vazio)' });

  const stored = USERS.get(String(email).trim().toLowerCase());
  // constant-time compare se ambos existem
  if (!stored || !crypto.timingSafeEqual(
    Buffer.from(stored.padEnd(64, '\0')),
    Buffer.from(String(password).padEnd(64, '\0')).slice(0, 64),
  )) {
    return res.status(401).json({ error: 'email ou senha inválidos' });
  }

  const ttlHours = rememberMe ? 24 * 30 : TOKEN_TTL_HOURS;
  const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
  const token = signToken({ email: email.toLowerCase(), exp, role: 'user' });
  return res.json({ ok: true, token, email: email.toLowerCase(), exp, role: 'user' });
});

// Helper — extract token from Authorization header and check if it's a guest
function getTokenRole(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const payload = verifyToken(m[1]);
  return payload?.role || 'user';
}

// ============= /report — gera perfilamento via Claude =============
function checkOrigin(req) {
  if (!ALLOWED_ORIGINS.length) return true;
  return ALLOWED_ORIGINS.includes(req.headers.origin || '');
}

app.options('/report', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  });
  res.status(204).end();
});

app.post('/report', async (req, res) => {
  if (!checkOrigin(req)) {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');

  const payload = req.body || {};
  if (!anthropic) {
    return res.json({ markdown: ruleBasedReport(payload), source: 'fallback-no-ai' });
  }
  try {
    const md = await callClaude(payload);
    return res.json({ markdown: md, source: 'claude', model: ANTHROPIC_MODEL });
  } catch (e) {
    console.error('[report] Claude err:', e.message);
    return res.json({
      markdown: ruleBasedReport(payload),
      source: 'fallback-error',
      error: e.message,
    });
  }
});

async function callClaude(payload) {
  const system = `Você é um analista comportamental [...prompt de ~30 linhas — elidido aqui por brevidade; ver server.js:185-217...]`;
  const user = `Analisa essa sessão:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nProduz o perfilamento agora, seguindo a estrutura exata.`;
  const resp = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1400,
    temperature: 0.7,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content.find(c => c.type === 'text')?.text || '';
  return text.trim();
}

// ============= /v2/report — perfilamento Claude da sessão atual =============
app.options('/v2/report', (req, res) => { /* CORS preflight */ res.status(204).end(); });
app.post('/v2/report', async (req, res) => {
  if (!checkOrigin(req)) return res.status(403).json({ error: 'origin not allowed' });
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  const payload = req.body || {};
  if (!anthropic) {
    return res.json({ markdown: ruleBasedReport(payload), source: 'fallback-no-ai' });
  }
  const enriched = enrichSessionPayload(payload);
  try {
    const md = await callClaudeV2(enriched);
    return res.json({ markdown: md, source: 'claude-v2', model: ANTHROPIC_MODEL });
  } catch (e) {
    console.error('[v2/report] Claude err:', e.message);
    return res.json({ markdown: ruleBasedReport(payload), source: 'fallback-error', error: e.message });
  }
});

// enrichSessionPayload(p): deriva top_signals.avg_intensity, questions_answered,
//   avg_audio_activity, most_silent/talkative/reactive_question, hour_local
//   (server.js:277-322)
// callClaudeV2(payload): prompt denso + anthropic.messages.create (server.js:324-380)
// ruleBasedReport(p): fallback markdown sem IA (server.js:382-404)

// ============= WS proxy =============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (client, req) => {
  const clientId = Math.random().toString(36).slice(2, 8);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.searchParams.get('p') || '';
  const t = url.searchParams.get('t') || '';
  const origin = req.headers.origin || '';

  // Origin allowlist first
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
    rejectClient(client, 4403, 'origin_not_allowed', 'origin não permitido'); return;
  }
  // Auth: token HMAC OU passcode legado
  let authedBy = null;
  const tokenPayload = t ? verifyToken(t) : null;
  if (tokenPayload) authedBy = 'token';
  else if (PASSCODE && p === PASSCODE) authedBy = 'passcode';
  if (!authedBy && (PASSCODE || USERS.size)) {
    rejectClient(client, 4401, 'invalid_credentials', 'token ou passcode inválido'); return;
  }

  const upstream = new WebSocket(UPSTREAM_URL, {
    headers: { Authorization: `Bearer ${API_KEY}` },   // ← chave só aqui
    perMessageDeflate: false,
  });
  // ...bridge bidirecional client<->upstream, com buffer pendingFromClient
  //    e handlers open/message/close/error (server.js:444-491)
});

server.listen(PORT, () => { /* logs de boot */ });
```

> **Nota:** o código acima é fiel a `server.js`, com dois prompts longos (`callClaude`/`callClaudeV2`) e o corpo do handler WS **elididos com marcação explícita** para caber. O arquivo completo tem 523 linhas — nada foi omitido silenciosamente.

### 5.2 Configuração do cliente — `public/config.js` E `public/v2/config.js` (idênticos)

```js
// PROD config — backend Node hospedado no Render
// Passcode embutido aqui pra que ego.sougni.com funcione sem ?p= na URL.
// O backend ainda exige passcode + origin allowlist (https://ego.sougni.com),
// então qualquer fetch fora desse contexto é rejeitado.
window.IH_CONFIG = {
  wsUrl: 'wss://ego-backend-lerb.onrender.com/ws',
  passcode: 'ego-2026-K7mP9XzQ',
};
```

> 🚨 **Passcode em plaintext, servido publicamente.** Ver §9 e §12.

### 5.3 `render.yaml` (Render Blueprint)

```yaml
services:
  - type: web
    name: ego-backend
    runtime: node
    plan: free
    region: oregon
    buildCommand: npm install --omit=dev
    startCommand: node server.js
    healthCheckPath: /health
    envVars:
      - key: INTERHUMAN_API_KEY
        sync: false
      - key: PASSCODE
        sync: false
      - key: ALLOWED_ORIGINS
        value: https://ego.sougni.com
      - key: NODE_VERSION
        value: "20"
```

### 5.4 `.env.example`

```bash
INTERHUMAN_API_KEY=ih_live_your_key_here
PORT=3737
PASSCODE=opcional-segredo-pra-bloquear-publico
ALLOWED_ORIGINS=https://ego.sougni.com
```

### 5.5 `.gitignore`

```gitignore
.env
.env.*
!.env.example
node_modules/
npm-debug.log*
.DS_Store
*.log
upload-payload.json
.read-ai-state.json
.claude/
```

- **Rotas/endpoints principais:** `GET /health`, `POST /auth`, `POST /report`, `POST /v2/report`, `WS /ws` (+ preflights `OPTIONS`). Todos em `server.js`.
- **Autenticação/autorização:** `signToken`/`verifyToken` (HMAC-SHA256), `checkOrigin`, `getTokenRole` — `server.js:34-149`.
- **Conexão com banco de dados:** `NÃO ENCONTRADO` (ver §6).
- **Middlewares:** apenas `express.json({ limit: '512kb' })` + `express.static('public')`. Sem middlewares de auth, rate-limit, logging estruturado ou segurança.

---

## 6. BANCO DE DADOS

- **Schemas / modelos / migrations:** `NÃO ENCONTRADO`.
- **Tipo de banco:** `NÃO ENCONTRADO` — **o projeto não usa banco de dados.**
- **ORM / query builder:** `NÃO ENCONTRADO`.

**Persistência real existente:**
- **Frontend:** `localStorage` (`ego_auth` — token + email + exp + role). Efêmero, no dispositivo.
- **Backend:** stateless. Único artefato de persistência em disco é `.read-ai-state.json` (estado OAuth Read.AI) — **legado/morto** (a integração Read.AI foi removida; `read-ai-client.js` não é mais importado). Sobrevive no filesystem do Render sem uso.

---

## 7. TESTES

- **Frameworks de teste:** `NÃO ENCONTRADO` (sem jest/mocha/vitest; sem script `test` em `package.json`).
- **Arquivos de teste** (`*.test.js`, `*.spec.js`): `NÃO ENCONTRADO`.
- **Cobertura atual:** **0%** — não há testes.
- **Quantidade por tipo:** unit `0` · integration `0` · e2e `0`.

> A validação foi feita historicamente de forma **manual** (sessões no browser + `curl` nos endpoints), não automatizada.

---

## 8. QUALIDADE DE CÓDIGO

- **Linters/formatters:** `NÃO ENCONTRADO` — sem ESLint (nem global nem local), sem Prettier, sem `.editorconfig`. Não foi possível "rodar o linter e listar warnings" porque **não há linter configurado**.
- **`node --check`** nos JS: passa (sem erro de sintaxe).

**Code smells óbvios identificados:**

| Smell | Onde | Detalhe |
|---|---|---|
| **Arquivos > 500 linhas** | `v2/styles.css` (1172), `v2/app.js` (1124), `styles.css` (1062), `app.js` (904), `server.js` (523) | 5 arquivos acima de 500 linhas. |
| **Funções > 50 linhas** | `renderShareCard` (~111, `v2/app.js:250`), handler WS (~82, `server.js:410`), `startSession` (~67), `callClaudeV2` (~56), `handleServerMessage` (~51), `callClaude` (~52, prompt-heavy) | ver §13. |
| **Duplicação massiva** | `public/*` vs `public/v2/*` | v1 e v2 compartilham ~75-80% do código (app.js: 904 vs 1124 linhas, ~236 linhas divergentes; styles.css e index.html idem). Toda correção precisa ser feita 2×. |
| **Dead code** | `read-ai-client.js` (142 linhas, não referenciado), `.read-ai-state.json` (no disco), hook `window.__egoShareTest` (gated em localhost, benigno) | |
| **Monólito** | `server.js` | rotas + auth + WS + prompts de IA em um arquivo, sem separação de camadas. |
| **Prompts hardcoded gigantes** | `server.js:185-217`, `324-363` | dois prompts de sistema (~30-40 linhas cada) embutidos como template string. |
| **Cache-busting manual** | HTMLs (`?v=guest8`) | versionamento de asset feito à mão, incrementado a cada deploy — frágil, propenso a esquecimento. |

---

## 9. SEGURANÇA

| Item | Estado |
|---|---|
| **Credenciais hardcoded** | 🚨 **SIM** — `passcode: 'ego-2026-K7mP9XzQ'` em `public/config.js:7` e `public/v2/config.js:7` (arquivos **rastreados no git e servidos publicamente**). Também `TOKEN_SECRET` tem fallback literal `'change-me'` (`server.js:31`). `.env.example` só tem placeholders (ok). |
| **Segredo no histórico git** | 🚨 **SIM** — `.read-ai-state.json` (refresh token OAuth Read.AI) foi commitado em `8469883` antes de ser gitignorado em `750bb92`. Token foi **rotacionado** depois (invalidado), mas **permanece no histórico**. |
| **`eval` / `exec` / `child_process`** | ✅ **NENHUM** encontrado. |
| **`innerHTML` (XSS)** | ⚠️ 8 usos em `v2/app.js` (linhas 142,143,150,824,825,966,997,1081). Texto de usuário (perguntas, markdown do report) passa por `escapeHtml`/`renderMarkdown` (que escapa antes). Dados vindos da API Interhuman (tipos de sinal, counts) são interpolados sem sanitização explícita — **risco baixo** (fonte semi-confiável), mas merece auditoria. |
| **Validação de input nos endpoints** | ⚠️ **Fraca.** `/report` e `/v2/report` só validam origin; o corpo JSON é repassado direto pro prompt do Claude sem schema/validação. `/auth` valida presença de email/senha. Sem validação de tamanho/tipo dos campos aninhados. |
| **Gestão de secrets** | ✅ **Backend OK** — `INTERHUMAN_API_KEY`, `ANTHROPIC_API_KEY`, `TOKEN_SECRET`, `USERS` em env vars do Render; `.env` gitignorado; a chave Interhuman nunca chega ao browser. ❌ **Frontend ruim** — passcode client-side. |
| **HTTPS** | ✅ Sim (SiteGround + Render forçam TLS). |
| **CORS** | ⚠️ `Access-Control-Allow-Origin: req.headers.origin \|\| '*'` **ecoa qualquer origin** em todos os endpoints. O `checkOrigin()` (allowlist) protege a *lógica*, mas o header é permissivo e o `Origin` é trivialmente forjável por clientes não-browser (curl). |
| **Headers de segurança** | ❌ **NÃO ENCONTRADO** — sem `helmet`, sem `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`. (SiteGround/Render podem adicionar alguns por padrão, mas a aplicação não os define.) |
| **Rate limiting** | ❌ **NÃO ENCONTRADO** — `/auth` (brute-force de senha), `/report`/`/v2/report` (custo Claude), `/ws` sem throttle. |
| **Autenticação nos endpoints de custo** | 🚨 `/report` e `/v2/report` **não exigem token** — só `checkOrigin`. Um cliente com header `Origin: https://ego.sougni.com` pode invocar o Claude à vontade (custo financeiro / DoS de crédito). |

---

## 10. CI/CD E DEPLOY

- **`.github/workflows` / `.gitlab-ci.yml`:** `NÃO ENCONTRADO` — **sem CI/CD** (nenhum lint/test/build automatizado).
- **`Dockerfile` / `docker-compose.yml`:** `NÃO ENCONTRADO`.
- **Scripts de deploy:** `NÃO ENCONTRADO` (nenhum script dedicado).

**Como o deploy realmente acontece:**
- **Backend (Render):** auto-deploy no `git push origin main` (Render observa o repo). `render.yaml` existe como Blueprint mas está **stale** — o service real chama-se `ego-backend-lerb` (não `ego-backend`), e o yaml não lista `ANTHROPIC_API_KEY`/`USERS`/`TOKEN_SECRET` (configurados manualmente no dashboard). Ou seja, o blueprint **não é a fonte de verdade** do deploy.
- **Frontend (SiteGround):** **100% manual** — upload dos arquivos de `public/` via File Manager do SiteGround (feito neste projeto via automação de browser). Sem pipeline, sem verificação automática, cache-busting manual.

---

## 11. DOCUMENTAÇÃO

**`README.md` (completo):**

```markdown
# Interhuman Signals — Realtime Camera

Página local que abre a webcam, envia chunks de vídeo (WebM, 3s) via WebSocket pra
`wss://api.interhuman.ai/v1/stream/analyze` e mostra **todas** as inferências
em tempo real:

- **12 sinais sociais** (agreement, confidence, ...) com probabilidade e racional.
- **Engagement state** (engaged / neutral / disengaged) com timeline.
- **Conversation Quality Index 0–100** + 5 dimensões (clarity, authority,
  energy, rapport, learning), snapshot e timeline.
- Log raw de todos os eventos session.ready, signal.detected/updated/ended, ...

## Segurança da chave
A chave fica em `.env` (gitignored) e é injetada no **servidor**... O browser
nunca recebe a chave — ele só fala com `localhost`.

## Como rodar
cd C:\Users\Rafael\interhuman-signals && npm install && npm start
Abra http://localhost:3737 ...
```

- **Documentação de API (Swagger/OpenAPI):** `NÃO ENCONTRADO`.
- **Outros docs:** `EGO_SIGNALS_METRICAS_INFERENCIAS.md` (catálogo de métricas/inferências) e `PROMPT_CLAUDE_DESIGN.md` (brief de apresentação) — **gerados recentemente para material comercial**, não documentam a arquitetura do código.
- **Comentários/docstrings:** o `server.js` é razoavelmente comentado (em PT-BR). Os `app.js` do frontend têm comentários de seção. **Sem JSDoc/docstrings formais** em nenhuma função. O README está **desatualizado** — descreve o app como "página local" e não menciona v2, login, deploy em produção, Render, nem o botão de compartilhar.

---

## 12. TOP 20 PROBLEMAS IDENTIFICADOS

| # | Sev. | Arquivo:linha | Problema |
|---|---|---|---|
| 1 | 🔴 **Crítico** | `public/config.js:7`, `public/v2/config.js:7` | Passcode `ego-2026-K7mP9XzQ` em plaintext, servido publicamente. Qualquer visitante lê o "segredo" que protege o WS. É segurança por obscuridade (a defesa real é origin+token, mas o passcode ainda é aceito no `/ws`). |
| 2 | 🔴 **Crítico** | `server.js:161`, `server.js:247` | `/report` e `/v2/report` **sem autenticação** (só `checkOrigin`, forjável). Permite invocar o Claude ilimitadamente → **custo financeiro / DoS de crédito Anthropic**. |
| 3 | 🔴 **Crítico** | histórico git `8469883` | Refresh token OAuth Read.AI vazado no histórico via `.read-ai-state.json`. Rotacionado, mas persiste no histórico público do repo. |
| 4 | 🟠 Alto | `server.js` (global) | **Zero rate limiting** em `/auth` (brute-force de senha), `/report`, `/v2/report`, `/ws`. |
| 5 | 🟠 Alto | `server.js:31` | `TOKEN_SECRET = ... \|\| 'change-me'` — se a env var não for setada, tokens são assináveis por qualquer um que conheça o default → **forja de sessão**. |
| 6 | 🟠 Alto | projeto todo | **Zero testes automatizados** e **zero CI/CD**. Refactors sem rede de segurança; deploy sem gate de qualidade. |
| 7 | 🟡 Médio | `public/app.js` vs `public/v2/app.js` (+ css/html) | Duplicação de ~75-80% entre v1 e v2. Divergência (drift) e dobro de manutenção. v1 é legado mas continua servido e mutável. |
| 8 | 🟡 Médio | `server.js:97,106,153,165,241,249` | CORS ecoa `req.headers.origin` como `Access-Control-Allow-Origin` em todos endpoints (permissivo). |
| 9 | 🟡 Médio | `server.js` | Sem headers de segurança (helmet/CSP/HSTS/X-Frame-Options). Superfície de clickjacking/XSS não mitigada no app. |
| 10 | 🟡 Médio | `server.js:123-126` | Comparação de senha: `stored.padEnd(64)` não é fatiado a 64 enquanto o lado da senha é `.slice(0,64)`. Senha (ou senha armazenada) > 64 chars → `timingSafeEqual` lança (buffers de tamanho diferente) → **500 não tratado** em `/auth`. |
| 11 | 🟡 Médio | `package.json` | Dependências major atrás: `@anthropic-ai/sdk` 0.30→0.115, `express` 4→5, `dotenv` 16→17. Sem Dependabot/Renovate. |
| 12 | 🟡 Médio | `read-ai-client.js` + `.read-ai-state.json` | Dead code no repo/disco (integração Read.AI removida mas artefatos ficaram). |
| 13 | 🟡 Médio | `README.md` | Documentação desatualizada — descreve "página local", ignora v2, login, produção, Render e share. Sem doc de API. |
| 14 | 🟡 Médio | `render.yaml` | Blueprint stale: nome de serviço errado (`ego-backend` vs real `ego-backend-lerb`), env vars reais (ANTHROPIC/USERS/TOKEN_SECRET) ausentes. Não é a fonte de verdade do deploy. |
| 15 | 🟢 Baixo | `node_modules/body-parser` | `npm audit`: 1 low (DoS por limit inválido, GHSA-v422-hmwv-36x6). Corrigível com `npm audit fix`. |
| 16 | 🟢 Baixo | `public/v2/app.js:250-361` | `renderShareCard` (~111 linhas) — função grande, muitas responsabilidades de desenho no canvas. |
| 17 | 🟢 Baixo | `server.js:410-492` | Handler `wss.on('connection')` (~82 linhas) — mistura auth + proxy + ciclo de vida. |
| 18 | 🟢 Baixo | `server.js:25` | Modelo Anthropic default `claude-sonnet-4-6` embutido — hoje desatualizado frente aos modelos atuais; depende de override por env. |
| 19 | 🟢 Baixo | `public/v2/app.js` (8×) | `innerHTML` com interpolação de dados da API sem sanitização explícita (texto de usuário está escapado; dados de sinais não). |
| 20 | 🟢 Baixo | HTMLs | Cache-busting manual (`?v=guest8`) — versionamento frágil, já causou (no histórico) servir CSS/JS stale. |

---

## 13. MÉTRICAS

**Top 10 arquivos por linhas:**

| # | Arquivo | Linhas |
|---|---|---:|
| 1 | `public/v2/styles.css` | 1.172 |
| 2 | `public/v2/app.js` | 1.124 |
| 3 | `public/styles.css` | 1.062 |
| 4 | `public/app.js` | 904 |
| 5 | `server.js` | 523 |
| 6 | `public/login.html` | 389 |
| 7 | `public/v2/index.html` | 273 |
| 8 | `public/index.html` | 252 |
| 9 | `EGO_SIGNALS_METRICAS_INFERENCIAS.md` | 223 |
| 10 | `read-ai-client.js` | 142 |

**Top 10 funções por tamanho** (estimado por intervalo entre definições — sem ferramenta de AST):

| # | Função | Local | ~Linhas |
|---|---|---|---:|
| 1 | `renderShareCard` | `v2/app.js:250` | ~111 |
| 2 | handler `wss.on('connection')` | `server.js:410` | ~82 |
| 3 | `startSession` | `v2/app.js:434` | ~67 |
| 4 | `callClaudeV2` | `server.js:324` | ~56 (prompt-heavy) |
| 5 | `callClaude` | `server.js:184` | ~52 (prompt-heavy) |
| 6 | `handleServerMessage` | `v2/app.js:874` | ~51 |
| 7 | `enrichSessionPayload` | `server.js:277` | ~45 |
| 8 | `runSegmentLoop` | `v2/app.js:542` | ~41 |
| 9 | `showQuestion` | `v2/app.js:671` | ~35 |
| 10 | `ruleBasedReport` | `server.js:382` | ~22 |

**Complexidade ciclomática (estimativa manual — sem `eslint`/`radon`; contando ramos):**

| Função | CC estimada | Nota |
|---|---:|---|
| `shareReport` (`v2/app.js:371`) | **~9-10** | Cadeia de fallback (imagem → texto → menu) com try/catch aninhados — a mais complexa do frontend. |
| handler WS (`server.js:410`) | ~7 | origin + token + passcode + reject + lifecycle. |
| `/auth` (`server.js:104`) | ~7 | guest / validações / compare / TTL. |
| `verifyToken` (`server.js:56`) | ~6 | parsing + timing-safe + exp. |
| `enrichSessionPayload` (`server.js:277`) | ~6 | loops + reduces + sorts condicionais. |

> Complexidades são **estimativas honestas** — o ambiente não tem ferramenta de análise estática instalada.

---

## 14. GAPS IDENTIFICADOS

**O que está faltando:**

1. **Testes** — nenhum. Faltam unit (funções de token, enrich, parse), integração (endpoints), e2e (fluxo de sessão). Prioridade alta dado que não há tipos (é JS puro).
2. **CI/CD** — nenhum pipeline. Faltam lint + test + audit em cada PR, e deploy do frontend automatizado (hoje é manual e propenso a erro).
3. **Linter/formatter** — sem ESLint/Prettier. Sem padronização automatizada.
4. **Tratamento de erro robusto** — o backend loga em `console` e degrada, mas não há: rate limiting, circuit breaker pro upstream Interhuman, timeout explícito nas chamadas Claude, nem monitoramento/alerta (Sentry/logtail).
5. **Observabilidade** — logs só via `console.log` (Render captura). Sem métricas, sem tracing, sem dashboard de erro. Não há como saber quantas sessões/reports/falhas acontecem.
6. **Autenticação nos endpoints de custo** — `/report` e `/v2/report` deveriam exigir token (mesmo guest) para evitar abuso de crédito.
7. **Gestão de segredos no cliente** — o passcode não deveria existir no `config.js`; a defesa real deveria ser 100% token + origin no servidor.
8. **DRY** — extrair o núcleo compartilhado v1/v2 (ou aposentar a v1 legada de vez, já que o fluxo real é privacy→/v2/).
9. **Documentação** — README desatualizado; sem OpenAPI/Swagger pros endpoints; sem JSDoc; sem doc de arquitetura/deploy (este arquivo começa a preencher esse gap).
10. **Higiene do repo** — remover `read-ai-client.js` (dead), `.read-ai-state.json` (e considerar limpeza do histórico), e alinhar `render.yaml` com a realidade (ou removê-lo).
11. **Validação de schema** — validar o corpo de `/report`/`/v2/report` (zod/joi) antes de repassar ao Claude.
12. **Dependências** — plano de atualização (Express 5, SDK Anthropic) + `npm audit fix`.

---

### ✅ Pontos fortes (para equilibrar a honestidade)

- **Arquitetura de proxy correta** — a `INTERHUMAN_API_KEY` nunca chega ao browser; o servidor é o único a falar com o upstream autenticado.
- **Token HMAC com `timingSafeEqual`** e verificação de `exp` — implementação de assinatura decente (o problema é o fallback do secret, não o algoritmo).
- **Degradação graciosa** em toda parte (report fallback, share fallback).
- **Frontend sem build step** — simples de servir, deploy trivial (o custo é a duplicação e o cache manual).
- **Backend bem comentado** e legível; separação clara de responsabilidades *dentro* do arquivo.

---

**Caminho absoluto do arquivo gerado:**

```
C:\Users\Rafael\interhuman-signals\ANALISE_PROJETO.md
```
