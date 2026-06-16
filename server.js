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
import { ReadAIClient } from './read-ai-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.INTERHUMAN_API_KEY;
const PORT = Number(process.env.PORT || 3737);
const UPSTREAM_URL = 'wss://api.interhuman.ai/v1/stream/analyze';
const PASSCODE = process.env.PASSCODE || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// Read.AI v2
const READ_AI_CLIENT_ID = process.env.READ_AI_CLIENT_ID || '';
const READ_AI_CLIENT_SECRET = process.env.READ_AI_CLIENT_SECRET || '';
const READ_AI_REFRESH_TOKEN = process.env.READ_AI_REFRESH_TOKEN || '';
const readai = (READ_AI_CLIENT_ID && READ_AI_CLIENT_SECRET && READ_AI_REFRESH_TOKEN)
  ? new ReadAIClient({
      clientId: READ_AI_CLIENT_ID,
      clientSecret: READ_AI_CLIENT_SECRET,
      initialRefreshToken: READ_AI_REFRESH_TOKEN,
      persistPath: path.join(__dirname, '.read-ai-state.json'),
    })
  : null;

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
  readAiEnabled: Boolean(readai),
  v2Endpoints: readai ? ['/v2/benchmarks', '/v2/report'] : [],
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

// ============= /v2/benchmarks — médias históricas Read.AI =============
// Frontend chama no load do dashboard pra mostrar "sua média histórica" ao
// lado dos valores live. Cacheia em memória por 5 minutos por usuário.
const benchmarkCache = new Map();
const BENCHMARK_TTL_MS = 5 * 60 * 1000;

app.options('/v2/benchmarks', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Headers': 'Authorization',
  });
  res.status(204).end();
});
app.get('/v2/benchmarks', async (req, res) => {
  if (!checkOrigin(req)) return res.status(403).json({ error: 'origin not allowed' });
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  // Modo visitante: não tem histórico Read.AI próprio
  if (getTokenRole(req) === 'guest') {
    return res.json({ available: false, reason: 'guest_mode', is_guest: true });
  }
  if (!readai) return res.json({ available: false, reason: 'READ_AI not configured' });

  const cacheKey = req.headers.authorization || 'anon';
  const cached = benchmarkCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const meetings = await readai.listAllMeetings({
      startGte: ninetyDaysAgo,
      expand: ['metrics'],
      maxPages: 5,  // 50 reuniões max
    });

    const withMetrics = meetings.filter(m => m.metrics && m.metrics.read_score != null);
    const n = withMetrics.length;
    const stats = (key) => {
      const vals = withMetrics.map(m => m.metrics[key]).filter(v => Number.isFinite(v));
      if (!vals.length) return null;
      const sum = vals.reduce((a, b) => a + b, 0);
      const mean = sum / vals.length;
      const sorted = vals.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      return {
        mean: Math.round(mean * 100) / 100,
        median: Math.round(median * 100) / 100,
        min: Math.round(Math.min(...vals) * 100) / 100,
        max: Math.round(Math.max(...vals) * 100) / 100,
        n: vals.length,
      };
    };

    const data = {
      available: true,
      window_days: 90,
      meeting_count: meetings.length,
      meetings_with_metrics: n,
      benchmarks: {
        read_score: stats('read_score'),
        sentiment: stats('sentiment'),
        engagement: stats('engagement'),
      },
      recent_titles: meetings.slice(0, 5).map(m => ({ title: m.title, start: m.start_time_ms })),
    };
    benchmarkCache.set(cacheKey, { data, expiresAt: Date.now() + BENCHMARK_TTL_MS });
    res.json(data);
  } catch (e) {
    console.error('[v2/benchmarks]', e.message);
    res.json({ available: false, error: e.message });
  }
});

// ============= /v2/report — perfilamento Claude enriquecido com histórico Read.AI =============
app.options('/v2/report', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.status(204).end();
});
app.post('/v2/report', async (req, res) => {
  if (!checkOrigin(req)) return res.status(403).json({ error: 'origin not allowed' });
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');

  const payload = req.body || {};
  const isGuest = getTokenRole(req) === 'guest';
  if (!anthropic) {
    return res.json({ markdown: ruleBasedReport(payload), source: 'fallback-no-ai' });
  }

  // Histórico Read.AI — RICO (apenas pra users não-visitantes)
  let baseline = null;
  if (readai && !isGuest) {
    try {
      const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
      // Primeiro: 50 reuniões só com métricas (cálculo de médias)
      const meetings = await readai.listAllMeetings({
        startGte: ninetyDaysAgo,
        expand: ['metrics'],
        maxPages: 5,
      });
      const withMetrics = meetings.filter(m => m.metrics && m.metrics.read_score != null);
      const agg = (key) => {
        const vals = withMetrics.map(m => m.metrics[key]).filter(Number.isFinite);
        if (!vals.length) return null;
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sorted = [...vals].sort((a, b) => a - b);
        return {
          mean: Math.round(mean * 10) / 10,
          median: Math.round(sorted[Math.floor(sorted.length/2)] * 10) / 10,
          min: Math.round(Math.min(...vals) * 10) / 10,
          max: Math.round(Math.max(...vals) * 10) / 10,
          stdev: Math.round(Math.sqrt(vals.reduce((s,v) => s+(v-mean)**2, 0)/vals.length) * 10) / 10,
          n: vals.length,
        };
      };

      // Segundo: top 6 reuniões mais recentes COM dados ricos
      const deepExpand = ['metrics', 'summary', 'action_items', 'key_questions', 'topics'];
      const deepMeetings = [];
      for (const m of meetings.slice(0, 6)) {
        try {
          const detail = await readai.getMeeting(m.id, deepExpand);
          deepMeetings.push({
            title: detail.title,
            platform: detail.platform,
            duration_min: detail.end_time_ms && detail.start_time_ms
              ? Math.round((detail.end_time_ms - detail.start_time_ms) / 60000) : null,
            participants_count: (detail.participants || []).length,
            attended_count: (detail.participants || []).filter(p => p.attended).length,
            folders: detail.folders || [],
            metrics: detail.metrics || null,
            summary: detail.summary?.slice(0, 500) || null,
            action_items: detail.action_items?.slice(0, 5) || null,
            key_questions: detail.key_questions?.slice(0, 5) || null,
            topics: detail.topics?.slice(0, 8) || null,
          });
        } catch (e) {
          // se a reunião falhar, continua com as outras
          console.warn('[v2/report] deep fetch fail for', m.id, e.message);
        }
      }

      // Patterns
      const allTopics = deepMeetings.flatMap(m => Array.isArray(m.topics) ? m.topics.map(t => typeof t === 'string' ? t : t.name || t.title || '') : []).filter(Boolean);
      const topicFreq = {};
      for (const t of allTopics) topicFreq[t] = (topicFreq[t] || 0) + 1;
      const recurringTopics = Object.entries(topicFreq).sort((a, b) => b[1] - a[1]).slice(0, 6);

      baseline = {
        window_days: 90,
        meeting_count: meetings.length,
        meetings_with_metrics: withMetrics.length,
        read_score: agg('read_score'),
        sentiment: agg('sentiment'),
        engagement: agg('engagement'),
        platforms: [...new Set(meetings.map(m => m.platform).filter(Boolean))],
        folders: [...new Set(meetings.flatMap(m => m.folders || []))].slice(0, 8),
        deep_recent: deepMeetings,
        recurring_topics: recurringTopics.map(([name, count]) => ({ name, count })),
      };
    } catch (e) {
      console.warn('[v2/report] readai baseline fail:', e.message);
      baseline = { error: e.message };
    }
  }

  // Enriquecer payload da sessão com derived metrics ANTES de passar pro Claude
  const enriched = enrichSessionPayload(payload);

  try {
    const md = await callClaudeV2(enriched, baseline, isGuest);
    return res.json({
      markdown: md,
      source: 'claude-v2',
      model: ANTHROPIC_MODEL,
      baseline_used: Boolean(baseline && !baseline.error),
      is_guest: isGuest,
      deep_meetings_count: baseline?.deep_recent?.length || 0,
    });
  } catch (e) {
    console.error('[v2/report] Claude err:', e.message);
    return res.json({
      markdown: ruleBasedReport(payload),
      source: 'fallback-error',
      error: e.message,
    });
  }
});

// ============= Enrich session payload — extrai TODAS as variáveis derivadas =============
function enrichSessionPayload(p) {
  const out = { ...p };

  // Top signals com média de probabilidade
  if (p.top_signals && p.per_question) {
    const probMap = new Map();
    const probWeights = { low: 1, medium: 2, high: 3 };
    for (const q of (p.per_question || [])) {
      for (const sig of (q.signals || [])) {
        const probs = sig.probabilities || [];
        const sum = probs.reduce((s, x) => s + (probWeights[x] || 0), 0);
        if (!probMap.has(sig.type)) probMap.set(sig.type, { sum: 0, n: 0 });
        const e = probMap.get(sig.type);
        e.sum += sum;
        e.n += probs.length;
      }
    }
    out.top_signals = p.top_signals.map(s => {
      const m = probMap.get(s.type);
      return {
        ...s,
        avg_intensity: m && m.n ? Math.round(m.sum / m.n * 100) / 100 : null,  // 1=low 2=med 3=high
      };
    });
  }

  // Padrão por pergunta
  if (p.per_question) {
    out.questions_answered = p.per_question.filter(q => q.really_answered).length;
    out.avg_audio_activity = Math.round(
      p.per_question.reduce((s, q) => s + (q.audio_activity || 0), 0) / Math.max(1, p.per_question.length) * 100
    ) / 100;
    // Pergunta mais silenciosa, mais falada, com mais sinais
    const sorted = [...p.per_question].sort((a, b) => (a.audio_activity || 0) - (b.audio_activity || 0));
    out.most_silent_question = sorted[0]?.idx;
    out.most_talkative_question = sorted[sorted.length - 1]?.idx;
    const bySignalsCount = [...p.per_question].sort((a, b) => (b.signals?.length || 0) - (a.signals?.length || 0));
    out.most_reactive_question = bySignalsCount[0]?.idx;
  }

  // Tempo do dia (sutil, mas útil)
  out.time_of_day = new Date().toISOString();
  out.hour_local = new Date().getHours();

  return out;
}

async function callClaudeV2(payload, baseline, isGuest) {
  const systemBase = `Você é um analista comportamental que produz perfilamentos densos, surpreendentes e respeitosos de uma sessão de 2 minutos. A pessoa respondeu 5 perguntas provocativas com a câmera ligada — sinais sociais foram detectados pela Interhuman AI em tempo real.

Você recebe um JSON com TODAS as variáveis disponíveis da sessão:
- duration_s, hour_local, time_of_day
- cqi (quality_index 0-100 + 5 dimensões: clarity, authority, energy, rapport, learning)
- engagement_pct (% engaged/neutral/disengaged ao longo da sessão)
- top_signals (até 5, com count e avg_intensity 1-3)
- per_question[5]: cada uma com question text, duration_s, audio_activity 0-1,
  really_answered, signals[], engagement_changes[]
- questions_answered, avg_audio_activity, most_silent_question, most_talkative_question,
  most_reactive_question — derivados pra você usar diretamente
- raw_signal_count`;

  const systemWithBaseline = `${systemBase}

Você também recebe uma LINHA DE BASE (baseline) do Read.AI com as últimas reuniões reais da pessoa nos últimos 90 dias:
- meeting_count, meetings_with_metrics
- read_score (mean/median/min/max/stdev/n), sentiment (idem), engagement (idem)
- platforms usadas, folders (tipos de reunião recorrentes)
- deep_recent (top 6 reuniões com summary, action_items, key_questions, topics, participants, duration)
- recurring_topics (top tópicos com frequência)

Use a BASELINE pra CONTEXTUALIZAR profundamente. Compare CQI hoje × read_score histórico, engagement hoje × engagement histórico, etc. Cite tópicos recorrentes quando o sinal da sessão (ex: hesitation) puder estar ligado a um tema que aparece nas reuniões recentes. Use action_items pra inferir se a pessoa é executora vs idealizadora. Use key_questions pra inferir estilo cognitivo.`;

  const systemGuest = `${systemBase}

Esta sessão é de um VISITANTE (sem histórico Read.AI). Concentre-se totalmente nos dados da sessão atual — não invente comparações inexistentes. Use as variáveis derivadas (most_silent_question, most_talkative_question, most_reactive_question, avg_audio_activity) pra ancorar observações específicas.`;

  const system = `${(isGuest ? systemGuest : systemWithBaseline)}

REGRAS DE OUTPUT:
- Markdown puro (sem code fences)
- ~400-500 palavras
- Português BR, "você"
- Seções (ordem rígida):

# 🧠 [ARQUÉTIPO em 4-6 palavras provocativas]

[uma linha de hard data: CQI + sinais top + tempo falado]

${!isGuest ? `[QUANDO BASELINE existe] **🔭 Sua linha de base × hoje:** uma frase comparando concretamente 2-3 números (CQI hoje vs read_score histórico, engagement hoje vs hist, etc).` : '[Sem baseline — pule esta seção, vá direto pra próxima]'}

## O que você DISSE × O que vimos
3-5 contrastes específicos pergunta-a-pergunta. Sinalize a pergunta mais silenciosa (most_silent_question) e a mais reativa (most_reactive_question):
- **"[pergunta resumida]"** → DISSE: [inferência sobre fala + audio_activity] · MOSTROU: [sinal dominante + avg_intensity + interpretação]

## Sua fragilidade oculta
1 parágrafo (3-4 frases) sobre o sinal recorrente que apareceu sem você perceber. ${!isGuest ? 'Se a BASELINE mostrar padrão diferente (ex: sentiment hoje muito abaixo), mencione. Se algum topic recurring der pista do gatilho, conecte.' : 'Foque na análise da sessão; cite a(s) pergunta(s) em que apareceu.'}

## Seu superpoder de comunicação
1 parágrafo sobre a dimensão CQI mais alta. ${!isGuest ? 'Se a BASELINE confirma (ex: read_score histórico alto e energy alta hoje), reforce com dados concretos.' : 'Use ancoragem em dados da sessão (qual pergunta acendeu mais).'}

## O conselho que você não pediu
Uma frase acionável específica. ${!isGuest ? 'Pode referenciar topics recurring ou folders frequentes.' : ''}

TOM: surpreender com insights NÃO-óbvios, jamais ofender, ser específico (use números). Não enrole, não use clichês motivacionais.`;

  const user = `## SESSÃO ATUAL (todas as variáveis)
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

${!isGuest ? `## SUA LINHA DE BASE (Read.AI · 90 dias)
\`\`\`json
${JSON.stringify(baseline, null, 2)}
\`\`\`` : '## MODO VISITANTE — sem baseline'}

Produz o perfilamento agora.`;

  const resp = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 2400,
    temperature: 0.7,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return (resp.content.find(c => c.type === 'text')?.text || '').trim();
}

async function _legacyCallClaudeV2(payload, history) {
  const system = `Você é um analista comportamental que produz perfilamentos densos, surpreendentes e respeitosos a partir de uma sessão de 2 minutos onde a pessoa respondeu 5 perguntas provocativas com a câmera ligada.

Você recebe DOIS conjuntos de dados:

A. SESSÃO AGORA — JSON com:
- 5 perguntas, tempo falado em cada (audio_activity 0-1)
- sinais sociais Interhuman detectados (12 tipos: agreement, confidence, confusion, disagreement, disengagement, engagement, frustration, hesitation, interest, skepticism, stress, uncertainty)
- engagement state ao longo da sessão (% engaged/neutral/disengaged)
- Conversation Quality Index 0-100 + 5 dimensões (clarity, authority, energy, rapport, learning)
- top signals da sessão

B. HISTÓRICO DA PESSOA — JSON do Read.AI com:
- read_score médio das últimas reuniões reais (0-100)
- sentiment médio (0-100)
- engagement médio (0-100)
- títulos recentes (contexto profissional)
- plataformas usadas

Use o HISTÓRICO pra CONTEXTUALIZAR a sessão. Se não houver histórico (history nulo ou sem dados), produza o perfilamento normal sem mencionar comparações inexistentes.

REGRAS DE OUTPUT:
- Markdown puro, sem code fences
- ~350-400 palavras
- Português BR, "você"
- Seções (ordem rígida):

# 🧠 [ARQUÉTIPO em 4-6 palavras provocativas]

[uma linha de hard data: CQI + sinais top da sessão]

[QUANDO houver histórico] **🔭 Comparação com sua média (últimas N reuniões reais):** uma linha com a comparação concreta dos 3 números (sentiment hoje vs média, engagement hoje vs média, etc) interpretando se está acima/abaixo.

## O que você DISSE × O que vimos
3-5 contrastes específicos pergunta-a-pergunta:
- **"[pergunta resumida]"** → DISSE: [inferência sobre fala] · MOSTROU: [sinal dominante + interpretação]

## Sua fragilidade oculta
1 parágrafo (3-4 frases) sobre o sinal recorrente que apareceu sem a pessoa perceber. Cite o sinal e em quais perguntas. SE o histórico mostra padrão diferente da sessão (ex: sentiment hoje muito abaixo da média), mencione.

## Seu superpoder de comunicação
1 parágrafo sobre a dimensão CQI mais alta. SE o histórico Read.AI confirma esse superpoder (ex: read_score histórico alto), reforce com dados.

## O conselho que você não pediu
Uma frase acionável específica, ligada ao padrão observado. Se for relevante, use referência histórica ("Você consistentemente performa melhor em reuniões de [tipo]").

TOM: surpreender com insights não-óbvios, jamais ofender, ser específico (use números concretos). Não enrole.`;

  const user = `## A. SESSÃO AGORA
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

## B. HISTÓRICO READ.AI
\`\`\`json
${JSON.stringify(history, null, 2)}
\`\`\`

Produz o perfilamento seguindo a estrutura exata.`;

  const resp = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1800,
    temperature: 0.7,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return (resp.content.find(c => c.type === 'text')?.text || '').trim();
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
