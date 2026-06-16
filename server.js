// Interhuman Signals — Realtime Camera proxy + perfilamento backend
//
// Architecture:
//   Browser <--ws--> THIS PROXY <--wss--> api.interhuman.ai/v1/stream/analyze
//   Browser ---POST /report---> THIS PROXY ----> Anthropic Claude (perfilamento)

import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
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
}));

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
  const origin = req.headers.origin || '';

  if (PASSCODE && p !== PASSCODE) {
    log(clientId, 'REJECT passcode', { origin });
    client.close(4401, 'invalid passcode');
    return;
  }
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
    log(clientId, 'REJECT origin', { origin });
    client.close(4403, 'origin not allowed');
    return;
  }

  log(clientId, 'browser conectado', { origin: origin || '(none)' });

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

function log(id, ...args) {
  console.log(`[${new Date().toISOString()}] [${id}]`, ...args);
}

server.listen(PORT, () => {
  console.log(`\n  Interhuman Signals proxy + report rodando em :${PORT}`);
  console.log(`  Upstream: ${UPSTREAM_URL}`);
  console.log(`  Chave Interhuman: ${API_KEY.slice(0, 12)}...${API_KEY.slice(-4)}`);
  console.log(`  Passcode WS: ${PASSCODE ? 'EXIGIDO' : 'desligado'}`);
  console.log(`  Origins permitidos: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : '(qualquer)'}`);
  console.log(`  Report IA: ${ANTHROPIC_API_KEY ? `${ANTHROPIC_MODEL} via Anthropic SDK` : 'desligado (fallback rule-based)'}\n`);
});
