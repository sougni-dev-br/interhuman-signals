// Interhuman Signals — Realtime Camera proxy + perfilamento backend
//
// Architecture:
//   Browser <--ws--> THIS PROXY <--wss--> api.interhuman.ai/v1/stream/analyze
//   Browser ---POST /report---> THIS PROXY ----> Anthropic Claude (perfilamento)

import dotenv from 'dotenv';
dotenv.config({ quiet: true }); // dotenv 17: quiet suprime o banner promocional no boot
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import {
  initDb,
  seedAdmin,
  DB_MODE,
  getUserByEmail,
  verifyPassword,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  getUserById,
  VALID_ROLES,
} from './db.js';
import { mountPulse, persistSessionAndReport } from './pulse.js';
import { aggregateAU, auPromptBlock } from './af.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.INTERHUMAN_API_KEY;
const PORT = Number(process.env.PORT || 3737);
const UPSTREAM_URL = 'wss://api.interhuman.ai/v1/stream/analyze';
const PASSCODE = process.env.PASSCODE || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// Auth — USERS é uma string "email1:senha1,email2:senha2" no env do Render.
// TOKEN_SECRET assina os tokens HMAC; default deriva do PASSCODE pra não ter
// que setar mais uma env var.
const USERS = parseUsers(process.env.USERS || '');
// TOKEN_SECRET assina os tokens HMAC. SEM fallback inseguro: se nem TOKEN_SECRET
// nem PASSCODE estiverem no ambiente, o processo aborta (tokens seriam forjáveis).
if (!process.env.TOKEN_SECRET && !process.env.PASSCODE) {
  console.error(
    '[fatal] defina TOKEN_SECRET (recomendado) ou PASSCODE no ambiente — sem isso qualquer um poderia forjar tokens de sessão.',
  );
  process.exit(1);
}
const TOKEN_SECRET = process.env.TOKEN_SECRET || PASSCODE;
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
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
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
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ============= Logging estruturado (JSON por linha) =============
function logEvent(type, data = {}) {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), type, ...data }));
  } catch {
    console.log(JSON.stringify({ ts: new Date().toISOString(), type }));
  }
}
function clientIp(req) {
  const xff = (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

if (!API_KEY) {
  console.error('[fatal] INTERHUMAN_API_KEY ausente em .env');
  process.exit(1);
}

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// Chamada ao Claude com timeout duro (AbortController). Se estourar, lança —
// e o endpoint que chama cai no ruleBasedReport com source 'timeout'.
async function claudeCreate(params, ms = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await anthropic.messages.create(params, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const app = express();
// Render/Cloudflare ficam na frente — confiar no primeiro proxy pra ler o IP
// real (X-Forwarded-For) e o express-rate-limit funcionar corretamente.
app.set('trust proxy', 1);

// ============= Headers de segurança (helmet) =============
// CSP calibrada pra NÃO quebrar: fontes Google (Montserrat/Fraunces), o WS do
// backend Render, e os scripts/estilos inline (auth gate, handlers). Webcam e
// card de compartilhamento usam blob:/data:. upgrade-insecure-requests fica
// desligado pra não estourar o dev em http://localhost.
const BACKEND_ORIGIN = (
  process.env.PUBLIC_BACKEND_ORIGIN || 'https://ego-backend-lerb.onrender.com'
).replace(/\/$/, '');
const BACKEND_WSS = BACKEND_ORIGIN.replace(/^http/, 'ws');
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'blob:', 'https://cdn.jsdelivr.net'],
        workerSrc: ["'self'", 'blob:'], // MediaPipe pode criar worker via blob
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: [
          "'self'",
          BACKEND_ORIGIN,
          BACKEND_WSS,
          'ws://localhost:*',
          'http://localhost:*',
          'https://cdn.jsdelivr.net', // MediaPipe Face Landmarker (bundle + wasm)
          'https://storage.googleapis.com', // modelo face_landmarker.task
        ],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false, // não exigir COEP (quebraria embeds/fontes)
  }),
);

app.use(express.json({ limit: '1mb' })); // folga p/ au_frames (capado a 1200 no schema)

// v1 legada removida: a raiz e o antigo /index.html mandam pro login (que
// encaminha pro /v2/). Cobre bookmarks antigos sem dar 404.
app.get(['/', '/index.html'], (_req, res) => res.redirect(302, '/login.html'));

app.use(express.static(path.join(__dirname, 'public')));

// ============= Rate limiting =============
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10, // 10 tentativas por IP
  skipSuccessfulRequests: true, // logins OK não contam
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logEvent('ratelimit', { route: '/auth', ip: clientIp(req) });
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfter: 15 * 60 });
  },
});
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5, // 5 reports por IP/hora (custo Claude)
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logEvent('ratelimit', { route: 'report', ip: clientIp(req) });
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfter: 60 * 60 });
  },
});

// ============= Auth obrigatória (token HMAC válido) =============
function requireToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  const payload = m ? verifyToken(m[1]) : null;
  if (!payload) {
    logEvent('auth.reject', { route: req.path, ip: clientIp(req) });
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.user = payload; // { email, exp, role }
  next();
}
app.get('/health', (_req, res) =>
  res.json({
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
  }),
);

// ============= /auth — login com email + senha =============
app.options('/auth', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': corsAllowOrigin(req),
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  });
  res.status(204).end();
});
app.post('/auth', authLimiter, async (req, res) => {
  if (!checkOrigin(req)) return res.status(403).json({ error: 'origin not allowed' });
  res.set('Access-Control-Allow-Origin', corsAllowOrigin(req));

  const { email, password, rememberMe, guest } = req.body || {};

  // GUEST mode — token sem credencial, TTL 1h, role=guest
  if (guest === true) {
    const exp = Math.floor(Date.now() / 1000) + 3600; // 1h
    const guestEmail = 'visitante@ego.local';
    const token = signToken({ email: guestEmail, exp, role: 'guest' });
    logEvent('auth.success', { role: 'guest', ip: clientIp(req) });
    return res.json({ ok: true, token, email: guestEmail, exp, role: 'guest' });
  }

  if (!email || !password) return res.status(400).json({ error: 'email e senha são obrigatórios' });

  const em = String(email).trim().toLowerCase();
  const ttlHours = rememberMe ? 24 * 30 : TOKEN_TTL_HOURS;
  const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;

  // 1) Banco (fonte de verdade — usuários gerenciados pelo admin)
  try {
    const u = await getUserByEmail(em);
    if (u) {
      if (Number(u.active) !== 1) {
        logEvent('auth.fail', { ip: clientIp(req), email: em, reason: 'inactive' });
        return res.status(403).json({ error: 'conta desativada' });
      }
      if (verifyPassword(password, u.password_hash)) {
        const token = signToken({ email: em, exp, role: u.role });
        logEvent('auth.success', { role: u.role, email: em, ip: clientIp(req), src: 'db' });
        return res.json({ ok: true, token, email: em, exp, role: u.role });
      }
      logEvent('auth.fail', { ip: clientIp(req), email: em, reason: 'bad_password' });
      return res.status(401).json({ error: 'email ou senha inválidos' });
    }
  } catch (e) {
    logEvent('db.error', { op: 'auth.lookup', message: e.message });
    // segue pro fallback de env abaixo
  }

  // 2) Fallback legado: env USERS (compat durante a transição)
  const stored = USERS.get(em);
  const fixed64 = (s) => {
    const b = Buffer.alloc(64);
    Buffer.from(String(s), 'utf8').copy(b, 0, 0, 64);
    return b;
  };
  const ok = Boolean(stored) && crypto.timingSafeEqual(fixed64(stored), fixed64(password));
  if (!ok) {
    logEvent('auth.fail', { ip: clientIp(req), email: em.slice(0, 80) });
    return res.status(401).json({ error: 'email ou senha inválidos' });
  }
  const token = signToken({ email: em, exp, role: 'user' });
  logEvent('auth.success', { role: 'user', email: em, ip: clientIp(req), src: 'env' });
  return res.json({ ok: true, token, email: em, exp, role: 'user' });
});

// ============= Admin — CRUD de usuários (só role=admin) =============
function requireAdmin(req, res, next) {
  requireToken(req, res, () => {
    if (req.user?.role !== 'admin') {
      logEvent('admin.forbidden', { email: req.user?.email, ip: clientIp(req) });
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  });
}

const adminUserSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(6).max(200),
  role: z.enum(['admin', 'gestor_rh', 'colaborador', 'guest']).default('colaborador'),
  department: z.string().max(120).optional(),
});
const adminPatchSchema = z
  .object({
    role: z.enum(['admin', 'gestor_rh', 'colaborador', 'guest']).optional(),
    active: z.boolean().optional(),
    password: z.string().min(6).max(200).optional(),
    department: z.string().max(120).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'nada para atualizar' });

app.options(['/admin/users', '/admin/users/:id'], (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': corsAllowOrigin(req),
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
  });
  res.status(204).end();
});

app.get('/admin/users', requireAdmin, async (req, res) => {
  res.set('Access-Control-Allow-Origin', corsAllowOrigin(req));
  try {
    res.json({ ok: true, roles: VALID_ROLES, users: await listUsers() });
  } catch (e) {
    logEvent('db.error', { op: 'listUsers', message: e.message });
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/admin/users', requireAdmin, async (req, res) => {
  res.set('Access-Control-Allow-Origin', corsAllowOrigin(req));
  const parsed = adminUserSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_payload',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  try {
    const existing = await getUserByEmail(parsed.data.email);
    if (existing) return res.status(409).json({ error: 'email já cadastrado' });
    const user = await createUser(parsed.data);
    logEvent('admin.user.create', { by: req.user.email, email: user.email, role: user.role });
    res.status(201).json({ ok: true, user });
  } catch (e) {
    logEvent('db.error', { op: 'createUser', message: e.message });
    res.status(500).json({ error: 'db_error' });
  }
});

app.patch('/admin/users/:id', requireAdmin, async (req, res) => {
  res.set('Access-Control-Allow-Origin', corsAllowOrigin(req));
  const parsed = adminPatchSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_payload',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  try {
    const target = await getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'não encontrado' });
    // trava de segurança: não permitir remover o próprio status de admin/desativar-se
    if (
      target.email === req.user.email &&
      ((parsed.data.role && parsed.data.role !== 'admin') || parsed.data.active === false)
    ) {
      return res.status(400).json({ error: 'você não pode rebaixar/desativar a própria conta' });
    }
    const user = await updateUser(req.params.id, parsed.data);
    logEvent('admin.user.update', {
      by: req.user.email,
      id: user.id,
      changes: Object.keys(parsed.data),
    });
    res.json({ ok: true, user });
  } catch (e) {
    logEvent('db.error', { op: 'updateUser', message: e.message });
    res.status(500).json({ error: 'db_error' });
  }
});

app.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  res.set('Access-Control-Allow-Origin', corsAllowOrigin(req));
  try {
    const target = await getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'não encontrado' });
    if (target.email === req.user.email) {
      return res.status(400).json({ error: 'você não pode excluir a própria conta' });
    }
    await deleteUser(req.params.id);
    logEvent('admin.user.delete', { by: req.user.email, id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    logEvent('db.error', { op: 'deleteUser', message: e.message });
    res.status(500).json({ error: 'db_error' });
  }
});

// ============= /report — gera perfilamento via Claude =============
function checkOrigin(req) {
  if (!ALLOWED_ORIGINS.length) return true;
  return ALLOWED_ORIGINS.includes(req.headers.origin || '');
}

// CORS controlado: sem allowlist (dev) ecoa o que veio. Com allowlist, só ecoa
// o Origin se ele estiver permitido; caso contrário fixa o primeiro permitido
// (nunca ecoa origin arbitrário, evitando refletir qualquer site).
function corsAllowOrigin(req) {
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.length) return origin || '*';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return ALLOWED_ORIGINS[0];
}

// ============= Validação de schema do payload (/v2/report) =============
// Espelha buildReportPayload() do frontend. Lenient (passthrough + campos
// opcionais) pra não rejeitar payload legítimo que evolua, mas trava lixo:
// precisa ser objeto, per_question array capado (anti-abuso), tipos corretos
// quando presentes. Payload inválido NÃO vai pro Claude (economia + segurança).
const perQuestionSchema = z
  .object({
    idx: z.number().optional(),
    question: z.string().max(2000).optional(),
    duration_s: z.number().optional(),
    audio_activity: z.number().optional(),
    really_answered: z.boolean().optional(),
    signals: z.array(z.any()).max(500).optional(),
    engagement_changes: z.array(z.any()).max(2000).optional(),
  })
  .passthrough();

const reportPayloadSchema = z
  .object({
    duration_s: z.number().nonnegative().optional(),
    cqi: z.any().optional(),
    cqi_timeline_points: z.number().optional(),
    engagement_pct: z.any().optional(),
    top_signals: z.array(z.any()).max(100).optional(),
    per_question: z.array(perQuestionSchema).max(50).optional(),
    raw_signal_count: z.number().optional(),
    au_frames: z.array(z.any()).max(1200).optional(), // frames de AU (MediaPipe/PyAFAR) — cap anti-abuso
    au_source: z.enum(['mediapipe', 'pyafar']).optional(),
  })
  .passthrough();

app.options('/report', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': corsAllowOrigin(req),
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
  });
  res.status(204).end();
});

app.post('/report', reportLimiter, requireToken, async (req, res) => {
  if (!checkOrigin(req)) {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  res.set('Access-Control-Allow-Origin', corsAllowOrigin(req));

  const t0 = Date.now();
  const payload = req.body || {};
  const respond = (body) => {
    logEvent('report.request', {
      route: '/report',
      role: req.user?.role,
      ip: clientIp(req),
      bytes: JSON.stringify(payload).length,
      latency_ms: Date.now() - t0,
      source: body.source,
    });
    return res.json(body);
  };
  if (!anthropic) return respond({ markdown: ruleBasedReport(payload), source: 'fallback-no-ai' });
  try {
    const md = await callClaude(payload);
    return respond({ markdown: md, source: 'claude', model: ANTHROPIC_MODEL });
  } catch (e) {
    const timedOut = e.name === 'AbortError' || /abort/i.test(e.message || '');
    logEvent('claude.error', { route: '/report', timedOut, message: e.message });
    return respond({
      markdown: ruleBasedReport(payload),
      source: timedOut ? 'timeout' : 'fallback-error',
      error: e.message,
    });
  }
});

async function callClaude(payload) {
  const system = `Você é um analista comportamental que produz perfilamentos curtos, surpreendentes e respeitosos a partir de uma sessão de 2 minutos onde uma pessoa respondeu 5 perguntas provocativas com a câmera ligada.

Você recebe um JSON com:
- 5 perguntas e quanto tempo a pessoa falou em cada uma (audio_activity: 0-1, % de tempo com voz detectada)
- sinais de comportamento detectados em cada pergunta (12 tipos: concordância, segurança, confusão, discordância, distanciamento, presença, frustração, hesitação, interesse, desconfiança, pressão, dúvida)
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

  const resp = await claudeCreate({
    model: ANTHROPIC_MODEL,
    max_tokens: 1400,
    temperature: 0.7,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content.find((c) => c.type === 'text')?.text || '';
  return text.trim();
}

// ============= /v2/report — perfilamento Claude da sessão atual =============
app.options('/v2/report', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': corsAllowOrigin(req),
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.status(204).end();
});
app.post('/v2/report', reportLimiter, requireToken, async (req, res) => {
  if (!checkOrigin(req)) return res.status(403).json({ error: 'origin not allowed' });
  res.set('Access-Control-Allow-Origin', corsAllowOrigin(req));

  const t0 = Date.now();
  const payload = req.body || {};
  const respond = (body) => {
    logEvent('report.request', {
      route: '/v2/report',
      role: req.user?.role,
      ip: clientIp(req),
      bytes: JSON.stringify(payload).length,
      latency_ms: Date.now() - t0,
      source: body.source,
    });
    // EGO Pulse #1 + relatório diário: persiste sessão + perfilamento (best-effort, não bloqueia)
    if (body.markdown) {
      persistSessionAndReport(req.user, payload, body).catch((e) =>
        logEvent('pulse.persist.error', { message: e.message }),
      );
    }
    if (payload.affect_au) body.affect_au = payload.affect_au; // ecoa os sinais faciais FACS agregados
    return res.json(body);
  };

  // Valida schema ANTES de qualquer processamento — payload podre não chega ao Claude.
  const parsed = reportPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    logEvent('report.invalid', {
      route: '/v2/report',
      ip: clientIp(req),
      issues: parsed.error.issues.length,
    });
    return res.status(400).json({
      error: 'invalid_payload',
      details: parsed.error.issues
        .slice(0, 10)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  // Action Units faciais (opcional): MediaPipe (browser, on-device) OU PyAFAR (sidecar) -> sinais psicossociais.
  if (Array.isArray(payload.au_frames) && payload.au_frames.length) {
    const auOpts = payload.au_source === 'pyafar'
      ? { source: 'pyafar/adult', sourceFps: 30, trustBlink: true }
      : { source: 'mediapipe/blendshape', sourceFps: 4, trustBlink: false };
    try { payload.affect_au = aggregateAU(payload.au_frames, auOpts); }
    catch (e) { logEvent('af.aggregate.error', { message: e.message }); }
  }

  if (!anthropic) return respond({ markdown: ruleBasedReport(payload), source: 'fallback-no-ai' });

  // Enriquecer payload da sessão com derived metrics ANTES de passar pro Claude
  const enriched = enrichSessionPayload(payload);
  delete enriched.au_frames; // não envia frames crus (468 landmarks/frame) ao Claude — só o agregado affect_au

  try {
    const md = await callClaudeV2(enriched);
    return respond({ markdown: md, source: 'claude-v2', model: ANTHROPIC_MODEL });
  } catch (e) {
    const timedOut = e.name === 'AbortError' || /abort/i.test(e.message || '');
    logEvent('claude.error', { route: '/v2/report', timedOut, message: e.message });
    return respond({
      markdown: ruleBasedReport(payload),
      source: timedOut ? 'timeout' : 'fallback-error',
      error: e.message,
    });
  }
});

// ============= Enrich session payload — extrai TODAS as variáveis derivadas =============
function enrichSessionPayload(p) {
  const out = { ...p };

  // Best-effort: nunca derruba o report se algum campo faltar.
  try {
    const TENSION = [
      'hesitation',
      'uncertainty',
      'stress',
      'confusion',
      'disagreement',
      'frustration',
      'skepticism',
      'disengagement',
    ];
    const POSITIVE = ['confidence', 'engagement', 'interest', 'agreement'];
    const probWeights = { low: 1, medium: 2, high: 3 };
    const summary = Array.isArray(p.signal_summary) ? p.signal_summary : [];

    // Intensidade média por sinal (1=low, 2=med, 3=high), a partir do signal_summary
    if (Array.isArray(p.top_signals)) {
      out.top_signals = p.top_signals.map((s) => {
        const sum = summary.find((x) => x && x.type === s.type);
        const probs = (sum && sum.probabilities) || [];
        const avg = probs.length
          ? probs.reduce((a, x) => a + (probWeights[x] || 0), 0) / probs.length
          : null;
        return { ...s, avg_intensity: avg != null ? Math.round(avg * 100) / 100 : null };
      });
    }

    // Sinais dominantes por categoria (ancoram o prompt)
    const ranked = [...summary].sort((a, b) => (b.count || 0) - (a.count || 0));
    out.dominant_signal =
      (p.top_signals && p.top_signals[0] && p.top_signals[0].type) ||
      (ranked[0] && ranked[0].type) ||
      null;
    out.tension_signals = ranked
      .filter((s) => TENSION.includes(s.type))
      .slice(0, 3)
      .map((s) => s.type);
    out.positive_signals = ranked
      .filter((s) => POSITIVE.includes(s.type))
      .slice(0, 3)
      .map((s) => s.type);
  } catch {
    /* enriquecimento é opcional — segue com o payload cru */
  }

  // Tempo do dia (sutil, mas útil)
  out.time_of_day = new Date().toISOString();
  out.hour_local = new Date().getHours();

  return out;
}

async function callClaudeV2(payload) {
  const system = `Você é um analista comportamental que escreve perfis densos, surpreendentes e respeitosos a partir de uma LEITURA DE OBSERVAÇÃO de ~1-2 minutos. A pessoa apareceu na câmera e agiu naturalmente — NENHUMA pergunta foi feita. Tudo vem do vídeo e do áudio: postura, expressões do rosto, tom de voz, presença. Você NÃO tem perguntas nem respostas.

QUEM VAI LER: uma pessoa comum, sem conhecimento técnico. O texto é PARA ELA.

Você recebe um JSON com a leitura:
- duration_s (duração), voice_activity_pct (% do tempo em que ela falou), hour_local, time_of_day
- affect_au → LEITURA DO ROSTO (sempre disponível): tom emocional, bem-estar aparente, desconforto, tensão, esforço mental, expressividade, sorriso genuíno, inquietação e pontos de atenção
- cqi → nota de presença 0-100 e 5 leituras: clarity (Clareza), authority (Firmeza), energy (Energia), rapport (Conexão), learning (Abertura)
- engagement_pct → quanto do tempo esteve presente / neutro / distante
- top_signals, signal_summary, dominant_signal, tension_signals[], positive_signals[]
- leitura_local → se for true, a camada avançada NÃO estava disponível: cqi, engagement_pct e os sinais virão vazios/nulos. NESSE CASO baseie TODO o perfil na leitura do rosto (affect_au) + voz (voice_activity_pct) + duração. NÃO mencione indisponibilidade, falha, cota ou serviço externo — apenas escreva o perfil com o que existe, naturalmente.

Use SÓ os dados desta leitura — NUNCA invente perguntas, falas ou comparações. Nunca finja que houve conversa ou entrevista. Se um dado faltar, simplesmente não fale dele.

PROIBIDO no texto final (é um produto para leigos):
- códigos e siglas técnicas: CQI, AU1/AU12/etc., FACS, PyAFAR, Duchenne, blendshape, valência, occRate, embotamento afetivo, affect_flatness
- nomes de campos do JSON (engagement_pct, top_signals, affect_au…) e nomes de sinais em inglês
- jargão clínico ou diagnóstico
TRADUZA sempre: "nota de presença", "tom emocional", "sorriso que chega aos olhos", "testa franzida", "lábios apertados", "quanto seu rosto reage".

REGRAS DE OUTPUT:
- Markdown puro (sem code fences)
- ~350-450 palavras
- Português BR, "você"
- Seções (ordem rígida):

# 🧠 [ARQUÉTIPO em 4-6 palavras provocativas]

[uma linha com os números principais em linguagem simples: nota de presença (se houver), o que mais apareceu, % do tempo falando]

## Como você se apresenta
1 parágrafo (3-4 frases) sobre a leitura geral — presença, energia e o que a câmera capta antes de qualquer palavra.

## O que seu corpo e sua voz entregaram
3-5 observações específicas. Formato:
- **[o que apareceu, em português simples]** → [o que esse padrão sugere]

## Sua fragilidade oculta
1 parágrafo (3-4 frases) sobre o sinal de tensão ou desconforto recorrente que apareceu sem a pessoa perceber.

## Seu superpoder de comunicação
1 parágrafo sobre o ponto mais forte da leitura cruzado com o sinal positivo dominante.

## O conselho que você não pediu
Uma frase acionável e específica, baseada no padrão observado.

TOM: surpreender com insights NÃO-óbvios, jamais ofender, ser específico (use números). Não enrole, não use clichês motivacionais.`;

  const user = `## LEITURA DE OBSERVAÇÃO (só vídeo + áudio, sem perguntas)
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Produz o perfilamento agora, seguindo a estrutura exata.`;

  const resp = await claudeCreate({
    model: ANTHROPIC_MODEL,
    max_tokens: 2400,
    temperature: 0.7,
    system: system + auPromptBlock(payload.affect_au),
    messages: [{ role: 'user', content: user }],
  });
  return (resp.content.find((c) => c.type === 'text')?.text || '').trim();
}

function ruleBasedReport(p) {
  const DIM_PT = { clarity: 'Clareza', authority: 'Firmeza', energy: 'Energia', rapport: 'Conexão', learning: 'Abertura' };
  const a = p.affect_au || null;
  const nota = p.cqi?.quality_index != null ? Math.round(p.cqi.quality_index) : null;
  const voz = p.voice_activity_pct;
  const dims = p.cqi || {};
  const topDim = Object.keys(DIM_PT).filter((d) => dims[d] != null).sort((x, y) => (dims[y] ?? 0) - (dims[x] ?? 0))[0];

  const linhas = [];
  if (nota != null) linhas.push(`nota de presença ${nota}/100`);
  if (a?.valence != null) linhas.push(`tom emocional ${Math.round(a.valence)}/100`);
  if (voz != null) linhas.push(`${voz}% do tempo falando`);
  if (p.duration_s) linhas.push(`${p.duration_s}s de leitura`);

  const obs = [];
  if (a?.expressivity != null) obs.push(`- **Expressividade ${Math.round(a.expressivity)}/100** — o quanto seu rosto reagiu ao longo da leitura.`);
  if (a?.duchenne_rate != null) obs.push(`- **Sorriso genuíno em ${Math.round(a.duchenne_rate * 100)}% do tempo** — sorriso que chega aos olhos.`);
  if (a?.tension_stress != null) obs.push(`- **Tensão ${Math.round(a.tension_stress)}/100** — testa franzida e lábios apertados.`);
  if (topDim) obs.push(`- **${DIM_PT[topDim]} ${Math.round(dims[topDim])}/100** — seu ponto mais forte nesta leitura.`);

  return `# 🧠 Sua leitura

${linhas.join(' · ') || 'Leitura registrada.'}

## O que a câmera captou
${obs.length ? obs.join('\n') : '- Leitura curta demais para destacar um padrão.'}

## Observação
Este é um resumo automático dos sinais desta sessão. É um SINAL de comportamento — não é diagnóstico.`;
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
    logEvent('ws.reject', { clientId, reason: 'origin', origin });
    rejectClient(client, 4403, 'origin_not_allowed', 'origin não permitido');
    return;
  }

  // Auth: aceita token HMAC OU passcode legado (qualquer um válido)
  let authedBy = null;
  let authedEmail = null;
  const tokenPayload = t ? verifyToken(t) : null;
  if (tokenPayload) {
    authedBy = 'token';
    authedEmail = tokenPayload.email;
  } else if (PASSCODE && p === PASSCODE) {
    authedBy = 'passcode';
  }

  if (!authedBy && (PASSCODE || USERS.size)) {
    log(clientId, 'REJECT auth', { origin, hadToken: Boolean(t), hadPasscode: Boolean(p) });
    logEvent('ws.reject', { clientId, reason: 'auth', hadToken: Boolean(t) });
    rejectClient(client, 4401, 'invalid_credentials', 'token ou passcode inválido');
    return;
  }

  log(clientId, 'browser conectado', { origin: origin || '(none)', authedBy, authedEmail });
  logEvent('ws.connect', { clientId, authedBy, origin: origin || null });

  const upstream = new WebSocket(UPSTREAM_URL, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    perMessageDeflate: false,
  });

  let upstreamOpen = false;
  const pendingFromClient = [];

  // Circuit breaker: se o upstream Interhuman não abrir em 10s, fecha o cliente
  // com 4504 (evita ficar pendurado indefinidamente).
  const upstreamTimeout = setTimeout(() => {
    if (!upstreamOpen) {
      logEvent('ws.upstream_timeout', { clientId });
      rejectClient(client, 4504, 'upstream_timeout', 'upstream não respondeu a tempo');
      try {
        upstream.terminate();
      } catch {}
    }
  }, 10000);

  upstream.on('open', () => {
    upstreamOpen = true;
    clearTimeout(upstreamTimeout);
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
    clearTimeout(upstreamTimeout);
    log(clientId, 'upstream CLOSE', code, reason?.toString?.());
    safeSend(
      client,
      JSON.stringify({
        type: 'proxy.upstream_close',
        data: { code, reason: reason?.toString?.() || '' },
      }),
    );
    try {
      client.close();
    } catch {}
  });

  upstream.on('error', (err) => {
    log(clientId, 'upstream ERROR', err.message);
    safeSend(
      client,
      JSON.stringify({
        type: 'proxy.upstream_error',
        data: { message: err.message },
      }),
    );
  });

  client.on('message', (data, isBinary) => {
    const payload = isBinary ? data : data.toString();
    if (upstreamOpen) upstream.send(payload);
    else pendingFromClient.push(payload);
  });

  client.on('close', (code, reason) => {
    clearTimeout(upstreamTimeout);
    log(clientId, 'browser CLOSE', code, reason?.toString?.());
    try {
      upstream.close();
    } catch {}
  });

  client.on('error', (err) => {
    log(clientId, 'browser ERROR', err.message);
    try {
      upstream.close();
    } catch {}
  });
});

function safeSend(ws, data, opts) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(data, opts);
    } catch (e) {
      console.error('send err', e.message);
    }
  }
}

function rejectClient(client, code, reasonCode, reasonText) {
  // Envia mensagem JSON pro browser entender ANTES de fechar (cloudflare etc.
  // costuma stripar custom close codes, então mandar JSON é mais robusto).
  safeSend(
    client,
    JSON.stringify({
      type: 'proxy.auth_rejected',
      data: { code, reason: reasonCode, message: reasonText },
    }),
  );
  try {
    client.close(code, reasonCode);
  } catch {}
}

function log(id, ...args) {
  console.log(`[${new Date().toISOString()}] [${id}]`, ...args);
}

// Inicializa o banco (schema + seed do admin) antes de aceitar conexões.
async function bootstrapDb() {
  try {
    await initDb();
    const seed = await seedAdmin();
    logEvent('db.ready', {
      mode: DB_MODE,
      seededAdmin: seed.seeded,
      note: seed.reason || seed.email,
    });
  } catch (e) {
    logEvent('db.error', { op: 'bootstrap', message: e.message });
    console.error('[db] falha ao inicializar o banco:', e.message);
  }
}

// ============= EGO Pulse (NR-1): persistência, relatório horário + Atera, denúncia anônima =============
mountPulse(app, {
  requireToken,
  corsAllowOrigin,
  checkOrigin,
  clientIp,
  logEvent,
  reportLimiter,
  anthropic,
  claudeCreate,
  ANTHROPIC_MODEL,
});

bootstrapDb().finally(() => {
  server.listen(PORT, () => {
    console.log(`\n  Interhuman Signals proxy + report + auth rodando em :${PORT}`);
    console.log(`  Upstream: ${UPSTREAM_URL}`);
    console.log(`  Chave Interhuman: ${API_KEY.slice(0, 12)}...${API_KEY.slice(-4)}`);
    console.log(
      `  Banco (EGO Pulse): Postgres/Supabase (${DB_MODE})`,
    );
    console.log(`  Passcode WS: ${PASSCODE ? 'EXIGIDO' : 'desligado'}`);
    console.log(
      `  Origins permitidos: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : '(qualquer)'}`,
    );
    console.log(
      `  Auth /auth: banco${USERS.size ? ` + ${USERS.size} usuário(s) legado(s) em env` : ''}`,
    );
    console.log(`  Token TTL: ${TOKEN_TTL_HOURS}h (com rememberMe: 720h)`);
    console.log(
      `  Report IA: ${ANTHROPIC_API_KEY ? `${ANTHROPIC_MODEL} via Anthropic SDK` : 'desligado (fallback rule-based)'}\n`,
    );
  });
});
