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

  const { email, password, rememberMe } = req.body || {};
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
  const token = signToken({ email: email.toLowerCase(), exp });
  return res.json({ ok: true, token, email: email.toLowerCase(), exp });
});

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
  const system = `Você é um analista comportamental que produz perfilamentos curtos, surpreendentes e respeitosos a partir de uma sessão de 2 minutos onde uma pessoa respondeu 5 perguntas provocativas com a câmera ligada.

Você recebe um JSON com:
- 5 perguntas e quanto tempo a pessoa falou em cada uma (audio_activity: 0-1, % de tempo com voz detectada)
- sinais sociais detectados pela Interhuman AI em cada pergunta (12 tipos possíveis: agreement, confidence, confusion, disagreement, disengagement, engagement, frustration, hesitation, interest, skepticism, stress, uncertainty)
- engagement state ao longo da sessão (% engaged/neutral/disengaged)
- Conversation Quality Index 0-100 + 5 dimensões (clarity, authority, energy, rapport, learning)
- top signals (sinais que mais apareceram)

REGRAS DE OUTPUT:
- Markdown puro, sem code fences
- ~300 palavras máximo
- Português BR, forma "você"
- Seções obrigatórias (e ordem):

# 🧠 [ARQUÉTIPO em 4-6 palavras provocativas]

[uma linha de hard data com os números principais]

## O que você DISSE × O que vimos
Lista de 3 a 5 contrastes específicos pergunta-por-pergunta. Formato exato:
- **"[pergunta resumida]"** → DISSE: [inferência sobre a fala] · MOSTROU: [sinal dominante + interpretação]

## Sua fragilidade oculta
Um parágrafo (2-3 frases) sobre o sinal recorrente que apareceu múltiplas vezes sem a pessoa perceber. Cite o sinal específico e em quais perguntas apareceu.

## Seu superpoder de comunicação
Um parágrafo (2-3 frases) sobre a dimensão CQI mais alta e o que isso significa na prática.

## O conselho que você não pediu
Uma frase acionável e específica, baseada no padrão observado.

TOM: surpreender com insights não-óbvios, jamais ofender, ser específico (use os números e nomes dos sinais), nunca genérico. Não enrole, não use clichês motivacionais. Se algum dado faltar, ignore — não invente.`;

  const user = `Analisa essa sessão:

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Produz o perfilamento agora, seguindo a estrutura exata.`;

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

function ruleBasedReport(p) {
  const top = (p.top_signals?.[0]?.type) || 'sinal indeterminado';
  const topCount = p.top_signals?.[0]?.count || 0;
  const engPct = p.engagement_pct?.engaged ?? 0;
  const cqi = p.cqi?.quality_index != null ? Math.round(p.cqi.quality_index) : '—';
  const answered = (p.per_question || []).filter(q => q.really_answered).length;
  const dims = p.cqi || {};
  const topDim = ['clarity','authority','energy','rapport','learning']
    .filter(d => dims[d] != null)
    .sort((a,b) => (dims[b] ?? 0) - (dims[a] ?? 0))[0];

  return `# 🧠 Perfilamento rápido

CQI ${cqi}/100 · ${engPct}% engajado · ${p.raw_signal_count || 0} sinais ao longo de ${p.duration_s}s · respondeu ${answered}/${(p.per_question||[]).length} perguntas.

## O que vimos
O sinal mais recorrente foi **${top}** com ${topCount} ocorrência(s). Sua dimensão CQI mais forte foi **${topDim || '—'}** (${topDim ? Math.round(dims[topDim]) : '—'}/100).

## Resposta por pergunta
${(p.per_question || []).map(q => `- **${q.idx}.** ${q.really_answered ? '✓ respondeu' : '✗ silenciou'} · ${Math.round((q.audio_activity || 0) * 100)}% voz · sinais: ${(q.signals || []).map(s => s.type).join(', ') || 'nenhum'}`).join('\n')}

*Report gerado pelo backend em modo fallback — sem IA conectada. Configure ANTHROPIC_API_KEY no Render pra ativar o perfilamento turbinado.*`;
}

// ============= WS proxy =============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (client, req) => {
  const clientId = Math.random().toString(36).slice(2, 8);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.searchParams.get('p') || '';
  const t = url.searchParams.get('t') || '';
  const origin = req.headers.origin || '';

  // Origin allowlist first (cheapest check)
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
    log(clientId, 'REJECT origin', { origin });
    rejectClient(client, 4403, 'origin_not_allowed', 'origin não permitido');
    return;
  }

  // Auth: aceita token HMAC OU passcode legado (qualquer um válido)
  let authedBy = null;
  let authedEmail = null;
  const tokenPayload = t ? verifyToken(t) : null;
  if (tokenPayload) { authedBy = 'token'; authedEmail = tokenPayload.email; }
  else if (PASSCODE && p === PASSCODE) { authedBy = 'passcode'; }

  if (!authedBy && (PASSCODE || USERS.size)) {
    log(clientId, 'REJECT auth', { origin, hadToken: Boolean(t), hadPasscode: Boolean(p) });
    rejectClient(client, 4401, 'invalid_credentials', 'token ou passcode inválido');
    return;
  }

  log(clientId, 'browser conectado', { origin: origin || '(none)', authedBy, authedEmail });

  const upstream = new WebSocket(UPSTREAM_URL, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    perMessageDeflate: false,
  });

  let upstreamOpen = false;
  const pendingFromClient = [];

  upstream.on('open', () => {
    upstreamOpen = true;
    log(clientId, 'upstream Interhuman OPEN');
    safeSend(client, JSON.stringify({ type: 'proxy.upstream_open' }));
    for (const msg of pendingFromClient) upstream.send(msg);
    pendingFromClient.length = 0;
  });

  upstream.on('message', (data, isBinary) => {
    if (isBinary) safeSend(client, data, { binary: true });
    else safeSend(client, data.toString(), { binary: false });
  });

  upstream.on('close', (code, reason) => {
    log(clientId, 'upstream CLOSE', code, reason?.toString?.());
    safeSend(client, JSON.stringify({
      type: 'proxy.upstream_close',
      data: { code, reason: reason?.toString?.() || '' },
    }));
    try { client.close(); } catch {}
  });

  upstream.on('error', (err) => {
    log(clientId, 'upstream ERROR', err.message);
    safeSend(client, JSON.stringify({
      type: 'proxy.upstream_error',
      data: { message: err.message },
    }));
  });

  client.on('message', (data, isBinary) => {
    const payload = isBinary ? data : data.toString();
    if (upstreamOpen) upstream.send(payload);
    else pendingFromClient.push(payload);
  });

  client.on('close', (code, reason) => {
    log(clientId, 'browser CLOSE', code, reason?.toString?.());
    try { upstream.close(); } catch {}
  });

  client.on('error', (err) => {
    log(clientId, 'browser ERROR', err.message);
    try { upstream.close(); } catch {}
  });
});

function safeSend(ws, data, opts) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(data, opts); } catch (e) { console.error('send err', e.message); }
  }
}

function rejectClient(client, code, reasonCode, reasonText) {
  // Envia mensagem JSON pro browser entender ANTES de fechar (cloudflare etc.
  // costuma stripar custom close codes, então mandar JSON é mais robusto).
  safeSend(client, JSON.stringify({
    type: 'proxy.auth_rejected',
    data: { code, reason: reasonCode, message: reasonText },
  }));
  try { client.close(code, reasonCode); } catch {}
}

function log(id, ...args) {
  console.log(`[${new Date().toISOString()}] [${id}]`, ...args);
}

server.listen(PORT, () => {
  console.log(`\n  Interhuman Signals proxy + report + auth rodando em :${PORT}`);
  console.log(`  Upstream: ${UPSTREAM_URL}`);
  console.log(`  Chave Interhuman: ${API_KEY.slice(0, 12)}...${API_KEY.slice(-4)}`);
  console.log(`  Passcode WS: ${PASSCODE ? 'EXIGIDO' : 'desligado'}`);
  console.log(`  Origins permitidos: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : '(qualquer)'}`);
  console.log(`  Auth /auth: ${USERS.size ? `${USERS.size} usuário(s) configurado(s)` : 'desligado (USERS vazio)'}`);
  console.log(`  Token TTL: ${TOKEN_TTL_HOURS}h (com rememberMe: 720h)`);
  console.log(`  Report IA: ${ANTHROPIC_API_KEY ? `${ANTHROPIC_MODEL} via Anthropic SDK` : 'desligado (fallback rule-based)'}\n`);
});
