// pulse.js — Plataforma EGO Pulse (NR-1) montada sobre o backend existente.
// #1 persistência de sessão+sinais · #2 relatório horário só-sinais + trigger Atera
// · #3.2 canal de denúncia anônimo. Enquadramento: SINAL, não diagnóstico.
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import {
  getUserByEmail,
  getDefaultOrgId,
  getOrgByComplaintSlug,
  saveSession,
  saveReport,
  listReports,
  getSessionsSince,
  createComplaint,
  listComplaints,
  updateComplaint,
  complaintStats,
  recordAteraRun,
  audit,
} from './db.js';

// Lidas em runtime (não no load do módulo) p/ o dotenv já ter populado o env.
const ateraSecret = () => process.env.ATERA_SECRET || '';
const minN = () => Number(process.env.PULSE_MIN_N || 5); // k-anon

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---------- Mapeia o payload do frontend p/ uma linha de `sessions` ----------
function sessionRowFromPayload(payload, userId, department) {
  const cqi = payload.cqi || {};
  const durS = num(payload.duration_s);
  const nowMs = Date.now();
  return {
    user_id: userId,
    department: department || null,
    started_at: new Date(nowMs - (durS ? durS * 1000 : 0)).toISOString(),
    ended_at: new Date(nowMs).toISOString(),
    duration_s: durS,
    cqi: num(cqi.quality_index),
    cqi_clarity: num(cqi.clarity),
    cqi_authority: num(cqi.authority),
    cqi_energy: num(cqi.energy),
    cqi_rapport: num(cqi.rapport),
    cqi_learning: num(cqi.learning),
    engagement_pct: payload.engagement_pct ?? null,
    voice_activity_pct: num(payload.voice_activity_pct),
    raw_signal_count: num(payload.raw_signal_count),
    top_signals: payload.top_signals ?? null,
    signal_summary: payload.signal_summary ?? null,
    source: payload.mode || 'observation',
  };
}

// Persiste a sessão + o relatório DIÁRIO (perfilamento). Best-effort, chamado pelo /v2/report.
export async function persistSessionAndReport(user, payload, reportBody = {}) {
  const dbUser = user?.email ? await getUserByEmail(user.email) : null;
  const userId = dbUser ? Number(dbUser.id) : null;
  const department = dbUser?.department || null;

  const events = Array.isArray(payload.raw_events)
    ? payload.raw_events.slice(0, 5000).map((e) => ({
        ts: e.ts || e.t || new Date().toISOString(),
        kind: e.kind || e.type || 'event',
        payload: e.data ?? e,
      }))
    : [];

  const sessRow = sessionRowFromPayload(payload, userId, department);
  const sessionId = await saveSession(sessRow, events);

  // só grava relatório se veio conteúdo (o /pulse/session avulso passa {} e não gera relatório)
  if (reportBody && reportBody.markdown) {
    await saveReport({
      user_id: userId,
      department,
      kind: 'perfilamento_diario',
      period_start: sessRow.started_at,
      period_end: sessRow.ended_at,
      markdown: reportBody.markdown,
      source: reportBody.source || null,
      model: reportBody.model || null,
      session_ids: sessionId ? [sessionId] : null,
    });
  }
  return sessionId;
}

// ---------- Agregação anônima de sinais p/ o relatório horário (k-anon) ----------
function aggregateSignals(sessions) {
  const avg = (arr) => {
    const v = arr.filter((x) => Number.isFinite(x));
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const cqi = avg(sessions.map((s) => Number(s.cqi)));
  const dims = {
    clarity: avg(sessions.map((s) => Number(s.cqi_clarity))),
    authority: avg(sessions.map((s) => Number(s.cqi_authority))),
    energy: avg(sessions.map((s) => Number(s.cqi_energy))),
    rapport: avg(sessions.map((s) => Number(s.cqi_rapport))),
    learning: avg(sessions.map((s) => Number(s.cqi_learning))),
  };
  const voice = avg(sessions.map((s) => Number(s.voice_activity_pct)));

  const counts = {};
  for (const s of sessions) {
    const summ = Array.isArray(s.signal_summary) ? s.signal_summary : [];
    for (const item of summ) {
      if (!item || !item.type) continue;
      counts[item.type] = (counts[item.type] || 0) + (Number(item.count) || 0);
    }
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const TENSION = ['hesitation', 'uncertainty', 'stress', 'confusion', 'disagreement', 'frustration', 'skepticism', 'disengagement'];
  const POSITIVE = ['confidence', 'engagement', 'interest', 'agreement'];

  let eng = { engaged: 0, neutral: 0, disengaged: 0 };
  let engN = 0;
  for (const s of sessions) {
    const e = s.engagement_pct;
    if (e && typeof e === 'object') {
      eng.engaged += Number(e.engaged) || 0;
      eng.neutral += Number(e.neutral) || 0;
      eng.disengaged += Number(e.disengaged) || 0;
      engN++;
    }
  }
  if (engN) eng = { engaged: Math.round(eng.engaged / engN), neutral: Math.round(eng.neutral / engN), disengaged: Math.round(eng.disengaged / engN) };

  return {
    n: sessions.length,
    cqi,
    dims,
    voice_activity_pct: voice,
    dominant: ranked.slice(0, 5).map(([t, c]) => ({ type: t, count: c })),
    tension: ranked.filter(([t]) => TENSION.includes(t)).slice(0, 3).map(([t, c]) => ({ type: t, count: c })),
    positive: ranked.filter(([t]) => POSITIVE.includes(t)).slice(0, 3).map(([t, c]) => ({ type: t, count: c })),
    engagement: eng,
  };
}

// ---------- Prompt HORÁRIO — SÓ SINAIS (curto, factual, NR-1, agregado) ----------
async function buildSignalsReport(agg, deps) {
  const { anthropic, claudeCreate, ANTHROPIC_MODEL } = deps;
  if (!anthropic) {
    return {
      data: { ...agg, leitura: null },
      markdown: `Leitura horária agregada (${agg.n} sessões). CQI médio ${agg.cqi ?? '—'}. Voz ${agg.voice_activity_pct ?? '—'}%.`,
      source: 'fallback-no-ai',
    };
  }
  const system = `Você é o motor de leitura de SINAL do EGO Pulse (gestão de riscos psicossociais NR-1). Recebe um AGREGADO ANÔNIMO de sinais coletivos de uma equipe na última hora (câmera+áudio, detecção Interhuman). Produza uma leitura CURTA, factual e NÃO-DIAGNÓSTICA — é SINAL, não diagnóstico clínico. NUNCA rotule indivíduos (o dado já vem agregado por time). Não invente nada fora do JSON de entrada.

Responda em JSON puro (SEM code fences), formato EXATO:
{
  "tom_geral": "positivo|neutro|tensionado|alerta",
  "resumo": "1-2 frases factuais sobre o clima agregado da hora",
  "sinais_dominantes": ["..."],
  "tensao": {"nivel":"baixa|media|alta","sinais":["..."]},
  "engajamento": "descrição curta baseada no engagement agregado",
  "alerta_precoce": {"ativo": true, "motivo": "curto"}
}
Regra NR-1: se houver concentração de sinais de tensão (stress/frustration/disengagement) OU engajamento majoritariamente disengaged, marque alerta_precoce.ativo=true com motivo objetivo; senão false e motivo "".`;
  const user = `Agregado anônimo da última hora (${agg.n} sessões):\n\`\`\`json\n${JSON.stringify(agg, null, 2)}\n\`\`\`\nProduza SÓ o JSON.`;
  const resp = await claudeCreate({ model: ANTHROPIC_MODEL, max_tokens: 700, temperature: 0.4, system, messages: [{ role: 'user', content: user }] });
  const text = (resp.content.find((c) => c.type === 'text')?.text || '').replace(/^```json\s*|\s*```$/g, '').trim();
  let leitura = null;
  try {
    leitura = JSON.parse(text);
  } catch {
    leitura = { raw: text };
  }
  return { data: { ...agg, leitura }, markdown: null, source: 'claude-signals' };
}

// ---------- Classificação de denúncia (sentimento + criticidade) ----------
function keywordCriticality(text) {
  const t = (text || '').toLowerCase();
  const grave = ['estupro', 'abuso sexual', 'assédio sexual', 'assedio sexual', 'ameaç', 'ameac', 'violência', 'violencia', 'agress', 'arma', 'suicíd', 'suicid', 'apalp', 'sexual'];
  return grave.some((k) => t.includes(k)) ? 'critica' : null;
}
async function classifyComplaint(text, deps) {
  const { anthropic, claudeCreate, ANTHROPIC_MODEL } = deps;
  const kw = keywordCriticality(text);
  if (!anthropic) return { sentiment_label: 'negativo', sentiment_score: 0.3, criticality: kw || 'media' };
  const system = `Classifique uma denúncia trabalhista ANÔNIMA. Responda JSON puro (sem code fences):
{"sentiment_label":"positivo|neutro|negativo|critico","sentiment_score":0..1,"criticality":"baixa|media|alta|critica"}
sentiment_score: 0=muito negativo, 1=muito positivo. criticality=critica p/ violência, assédio sexual, ameaça, risco à integridade. Não invente. Só o JSON.`;
  try {
    const resp = await claudeCreate({ model: ANTHROPIC_MODEL, max_tokens: 200, temperature: 0, system, messages: [{ role: 'user', content: String(text).slice(0, 4000) }] });
    const raw = (resp.content.find((c) => c.type === 'text')?.text || '').replace(/^```json\s*|\s*```$/g, '').trim();
    const j = JSON.parse(raw);
    if (kw === 'critica') j.criticality = 'critica'; // keyword só ELEVA, nunca reduz
    return j;
  } catch {
    return { sentiment_label: 'negativo', sentiment_score: 0.3, criticality: kw || 'media' };
  }
}

// ---------- Montagem dos endpoints ----------
export function mountPulse(app, deps) {
  const { requireToken, corsAllowOrigin, checkOrigin, clientIp, logEvent, reportLimiter } = deps;
  const setCors = (req, res) => res.set('Access-Control-Allow-Origin', corsAllowOrigin(req));

  // gestor_rh OU admin
  function requireGestor(req, res, next) {
    requireToken(req, res, () => {
      if (req.user?.role !== 'gestor_rh' && req.user?.role !== 'admin') {
        logEvent('pulse.forbidden', { email: req.user?.email, ip: clientIp(req) });
        return res.status(403).json({ error: 'forbidden' });
      }
      next();
    });
  }

  const denunciaLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 8, // até 8 denúncias/hora por IP (IP usado só p/ rate-limit, NUNCA armazenado)
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'rate_limit_exceeded' }),
  });

  app.options(
    ['/pulse/session', '/pulse/atera/tick', '/pulse/denuncia', '/pulse/denuncia/:slug', '/pulse/complaints', '/pulse/complaints/:id', '/pulse/reports'],
    (req, res) => {
      res.set({
        'Access-Control-Allow-Origin': corsAllowOrigin(req),
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Atera-Secret',
        'Access-Control-Max-Age': '600',
      });
      res.status(204).end();
    },
  );

  // ==== #1 /pulse/session — persiste sessão avulsa (o /v2/report já persiste tudo) ====
  app.post('/pulse/session', reportLimiter, requireToken, async (req, res) => {
    if (!checkOrigin(req)) return res.status(403).json({ error: 'origin not allowed' });
    setCors(req, res);
    try {
      const id = await persistSessionAndReport(req.user, req.body || {}, {});
      res.status(201).json({ ok: true, session_id: id });
    } catch (e) {
      logEvent('pulse.session.error', { message: e.message });
      res.status(500).json({ error: 'db_error' });
    }
  });

  // ==== #2 /pulse/atera/tick — relatório HORÁRIO só-sinais (disparado pelo Atera) ====
  app.post('/pulse/atera/tick', async (req, res) => {
    const secret = req.get('X-Atera-Secret') || req.query.secret || '';
    const ATERA_SECRET = ateraSecret();
    if (!ATERA_SECRET || secret !== ATERA_SECRET) {
      logEvent('pulse.atera.reject', { ip: clientIp(req) });
      return res.status(401).json({ error: 'unauthorized' });
    }
    const MIN_N = minN();
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 60 * 60 * 1000);
    const ps = periodStart.toISOString();
    const pe = periodEnd.toISOString();
    try {
      const sessions = await getSessionsSince(ps);
      if (sessions.length < MIN_N) {
        await recordAteraRun({ period_start: ps, period_end: pe, reports_generated: 0, status: 'suppressed_k_anon' });
        return res.json({ ok: true, generated: 0, suppressed: true, reason: `n<${MIN_N}`, n: sessions.length });
      }
      const agg = aggregateSignals(sessions);
      const rep = await buildSignalsReport(agg, deps);
      await saveReport({
        user_id: null,
        department: null,
        kind: 'sinais_horario',
        period_start: ps,
        period_end: pe,
        markdown: rep.markdown,
        data: rep.data,
        source: rep.source,
        model: deps.ANTHROPIC_MODEL,
        session_ids: null,
      });
      await recordAteraRun({ period_start: ps, period_end: pe, reports_generated: 1, status: 'ok' });
      logEvent('pulse.atera.tick', { n: sessions.length, source: rep.source });
      res.json({ ok: true, generated: 1, n: sessions.length, source: rep.source });
    } catch (e) {
      logEvent('pulse.atera.error', { message: e.message });
      try {
        await recordAteraRun({ period_start: ps, period_end: pe, reports_generated: 0, status: 'error', error: e.message });
      } catch {}
      res.status(500).json({ error: 'atera_error' });
    }
  });

  // ==== #3.2 /pulse/denuncia[/:slug] — canal ANÔNIMO (público). SEM IP/identidade armazenados. ====
  app.post(['/pulse/denuncia', '/pulse/denuncia/:slug'], denunciaLimiter, async (req, res) => {
    if (!checkOrigin(req)) return res.status(403).json({ error: 'origin not allowed' });
    setCors(req, res);
    const schema = z.object({
      type: z.string().min(2).max(80),
      description: z.string().min(5).max(8000),
      extra_info: z.string().max(8000).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
    try {
      const slug = (req.params.slug || 'sougni').toLowerCase();
      const org = await getOrgByComplaintSlug(slug);
      const orgId = org?.id || (await getDefaultOrgId());
      const cls = await classifyComplaint(`${parsed.data.description}\n${parsed.data.extra_info || ''}`, deps);
      const row = await createComplaint({
        orgId,
        type: parsed.data.type,
        description: parsed.data.description,
        extra_info: parsed.data.extra_info || null,
        sentiment_label: cls.sentiment_label,
        sentiment_score: cls.sentiment_score,
        criticality: cls.criticality,
      });
      logEvent('pulse.denuncia', { criticality: cls.criticality }); // nada identificável no log
      res.status(201).json({ ok: true, protocolo: String(row.id).slice(0, 8) });
    } catch (e) {
      logEvent('pulse.denuncia.error', { message: e.message });
      res.status(500).json({ error: 'db_error' });
    }
  });

  // ==== /pulse/complaints — lista + stats (gestor_rh/admin) ====
  app.get('/pulse/complaints', requireGestor, async (req, res) => {
    setCors(req, res);
    try {
      const orgId = await getDefaultOrgId();
      const [items, stats] = await Promise.all([listComplaints({ orgId }), complaintStats(orgId)]);
      res.json({ ok: true, stats, complaints: items });
    } catch (e) {
      logEvent('pulse.complaints.error', { message: e.message });
      res.status(500).json({ error: 'db_error' });
    }
  });
  app.patch('/pulse/complaints/:id', requireGestor, async (req, res) => {
    setCors(req, res);
    const schema = z.object({
      status: z.enum(['aberta', 'em_analise', 'resolvida', 'arquivada']).optional(),
      resolution_notes: z.string().max(8000).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
    try {
      const row = await updateComplaint(req.params.id, parsed.data);
      await audit(req.user.email, 'complaint.update', 'complaint', req.params.id, parsed.data);
      res.json({ ok: true, complaint: row });
    } catch (e) {
      logEvent('pulse.complaint.update.error', { message: e.message });
      res.status(500).json({ error: 'db_error' });
    }
  });

  // ==== /pulse/reports — relatórios do próprio usuário (diário) + horário do org ====
  app.get('/pulse/reports', requireToken, async (req, res) => {
    setCors(req, res);
    try {
      const dbUser = await getUserByEmail(req.user.email);
      const mine = await listReports({ userId: dbUser ? Number(dbUser.id) : null, kind: req.query.kind, limit: 20 });
      res.json({ ok: true, reports: mine });
    } catch (e) {
      logEvent('pulse.reports.error', { message: e.message });
      res.status(500).json({ error: 'db_error' });
    }
  });

  logEvent('pulse.mounted', { ateraEnabled: Boolean(ateraSecret()), minN: minN() });
}
