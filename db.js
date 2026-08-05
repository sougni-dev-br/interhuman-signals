// Camada de dados — Postgres (Supabase) via supabase-js com service_role.
// Migrado de libSQL/Turso p/ Postgres na virada EGO Pulse. O backend usa a
// service key (bypass de RLS); a autorização é feita no código. RLS fica ligada
// como 2a camada (Data API pública devolve zero).
//
// Auth continua Node-nativo (scrypt + token HMAC no server.js). Papéis:
// admin | gestor_rh | colaborador | guest.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

// Client criado sob demanda (lazy) via Proxy — assim o env (dotenv) já está
// carregado quando a 1a query roda, independentemente da ordem de imports do ESM.
let _client = null;
function client() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no ambiente');
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
export const supa = new Proxy(
  {},
  {
    get: (_t, prop) => {
      const c = client();
      const v = c[prop];
      return typeof v === 'function' ? v.bind(c) : v;
    },
  },
);
export const DB_MODE = 'postgres';

const ROLES = new Set(['admin', 'gestor_rh', 'colaborador', 'guest']);
export function isValidRole(r) {
  return ROLES.has(r);
}
export const VALID_ROLES = [...ROLES];

// ---------- Hashing de senha (scrypt, sem dependência externa) ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
export function verifyPassword(password, stored) {
  try {
    const [saltHex, hashHex] = String(stored).split(':');
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const hash = Buffer.from(hashHex, 'hex');
    const test = crypto.scryptSync(String(password), salt, hash.length);
    return hash.length === test.length && crypto.timingSafeEqual(hash, test);
  } catch {
    return false;
  }
}

// ---------- Organização default ----------
let _defaultOrgId = null;
export async function getDefaultOrgId() {
  if (_defaultOrgId) return _defaultOrgId;
  const { data, error } = await supa
    .from('organizations')
    .select('id')
    .eq('slug', 'sougni')
    .maybeSingle();
  if (error) throw error;
  _defaultOrgId = data?.id || null;
  return _defaultOrgId;
}
export async function getOrgByComplaintSlug(slug) {
  const { data, error } = await supa
    .from('organizations')
    .select('id, name, min_n')
    .eq('complaint_slug', String(slug).toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ---------- Migração / connectividade ----------
export async function initDb() {
  // Schema é aplicado via migrations/001_ego_pulse.sql. Aqui só validamos conexão.
  const { error } = await supa.from('organizations').select('id').limit(1);
  if (error) throw error;
}

// ---------- Seed do admin inicial ----------
export async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return { seeded: false, reason: 'ADMIN_EMAIL/ADMIN_PASSWORD ausentes' };
  const existing = await getUserByEmail(email);
  if (existing) return { seeded: false, reason: 'admin já existe' };
  await createUser({ email, password, role: 'admin' });
  return { seeded: true, email };
}

// ---------- CRUD de usuários ----------
function rowToUser(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    email: r.email,
    role: r.role,
    department: r.department || null,
    active: r.active === true || Number(r.active) === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function getUserByEmail(email) {
  const em = String(email).trim().toLowerCase();
  const { data, error } = await supa.from('app_users').select('*').eq('email', em).maybeSingle();
  if (error) throw error;
  return data || null; // inclui password_hash — uso interno no /auth
}

export async function listUsers() {
  const { data, error } = await supa
    .from('app_users')
    .select('id, email, role, department, active, created_at, updated_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToUser);
}

export async function getUserById(id) {
  const { data, error } = await supa
    .from('app_users')
    .select('id, email, role, department, active, created_at, updated_at')
    .eq('id', Number(id))
    .maybeSingle();
  if (error) throw error;
  return rowToUser(data);
}

export async function createUser({ email, password, role = 'colaborador', department = null }) {
  const em = String(email).trim().toLowerCase();
  if (!em || !password) throw new Error('email e senha obrigatórios');
  if (!isValidRole(role)) throw new Error('papel inválido');
  const org_id = await getDefaultOrgId();
  const { data, error } = await supa
    .from('app_users')
    .insert({ email: em, password_hash: hashPassword(password), role, department, org_id })
    .select('id, email, role, department, active, created_at, updated_at')
    .single();
  if (error) throw error;
  return rowToUser(data);
}

export async function updateUser(id, { role, active, password, department }) {
  const patch = {};
  if (role !== undefined) {
    if (!isValidRole(role)) throw new Error('papel inválido');
    patch.role = role;
  }
  if (active !== undefined) patch.active = !!active;
  if (department !== undefined) patch.department = department;
  if (password) patch.password_hash = hashPassword(password);
  if (Object.keys(patch).length === 0) return getUserById(id);
  patch.updated_at = new Date().toISOString();
  const { error } = await supa.from('app_users').update(patch).eq('id', Number(id));
  if (error) throw error;
  return getUserById(id);
}

export async function deleteUser(id) {
  const { error } = await supa.from('app_users').delete().eq('id', Number(id));
  if (error) throw error;
}

export async function countUsers() {
  const { count, error } = await supa.from('app_users').select('id', { count: 'exact', head: true });
  if (error) throw error;
  return Number(count || 0);
}

// ---------- #1 Sessões + eventos de sinal ----------
export async function saveSession(sess, events = []) {
  const org_id = await getDefaultOrgId();
  const row = { ...sess, org_id };
  const { data, error } = await supa.from('sessions').insert(row).select('id').single();
  if (error) throw error;
  const sessionId = data.id;
  if (Array.isArray(events) && events.length) {
    const rows = events.slice(0, 5000).map((e) => ({
      session_id: sessionId,
      org_id,
      ts: e.ts || new Date().toISOString(),
      kind: String(e.kind || 'event').slice(0, 80),
      payload: e.payload ?? e,
    }));
    const { error: evErr } = await supa.from('session_signal_events').insert(rows);
    if (evErr) throw evErr;
  }
  return sessionId;
}

export async function getSessionsSince(sinceISO, { userId } = {}) {
  let q = supa.from('sessions').select('*').gte('started_at', sinceISO).order('started_at', { ascending: true });
  if (userId) q = q.eq('user_id', Number(userId));
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ---------- #2 Relatórios ----------
export async function saveReport(rep) {
  const org_id = await getDefaultOrgId();
  const { data, error } = await supa
    .from('reports')
    .insert({ ...rep, org_id })
    .select('id, kind, created_at')
    .single();
  if (error) throw error;
  return data;
}
export async function listReports({ userId, kind, anonymous = false, limit = 30 } = {}) {
  let q = supa.from('reports').select('id, kind, department, markdown, data, source, created_at, period_start, period_end').order('created_at', { ascending: false }).limit(limit);
  if (anonymous) {
    // Relatórios sem dono (agregados anônimos do org, ex.: sinais_horario k-anon).
    q = q.is('user_id', null);
  } else if (userId != null) {
    q = q.eq('user_id', Number(userId));
  } else {
    // Sem userId e sem flag anonymous: NÃO retorna nada. Evita vazar relatórios de TODOS
    // os usuários quando o chamador não tem cadastro (ex.: token guest).
    return [];
  }
  if (kind) q = q.eq('kind', kind);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function lastReportOfKind(userId, kind) {
  const { data, error } = await supa
    .from('reports')
    .select('id, created_at')
    .eq('user_id', Number(userId))
    .eq('kind', kind)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ---------- #3.2 Denúncias (anônimas) ----------
export async function createComplaint({ orgId, type, description, extra_info, sentiment_label, sentiment_score, criticality }) {
  const { data, error } = await supa
    .from('complaints')
    .insert({
      org_id: orgId,
      type: String(type).slice(0, 80),
      description,
      extra_info: extra_info || null,
      sentiment_label: sentiment_label || null,
      sentiment_score: sentiment_score ?? null,
      criticality: criticality || null,
    })
    .select('id, created_at')
    .single();
  if (error) throw error;
  return data;
}
export async function listComplaints({ orgId, status } = {}) {
  let q = supa.from('complaints').select('*').order('created_at', { ascending: false });
  if (orgId) q = q.eq('org_id', orgId);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function updateComplaint(id, { status, resolution_notes }) {
  const patch = {};
  if (status !== undefined) patch.status = status;
  if (resolution_notes !== undefined) patch.resolution_notes = resolution_notes;
  const { data, error } = await supa.from('complaints').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  return data;
}
export async function complaintStats(orgId) {
  const rows = await listComplaints({ orgId });
  const total = rows.length;
  const abertas = rows.filter((r) => r.status === 'aberta' || r.status === 'em_analise').length;
  const resolvidas = rows.filter((r) => r.status === 'resolvida').length;
  const criticas = rows.filter((r) => r.criticality === 'critica' || r.criticality === 'alta').length;
  const negativas = rows.filter((r) => r.sentiment_label === 'negativo' || r.sentiment_label === 'critico').length;
  const scores = rows.map((r) => Number(r.sentiment_score)).filter((n) => !Number.isNaN(n));
  const sentimento_medio = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  return { total, abertas, resolvidas, criticas, negativas, sentimento_medio };
}

// ---------- #2 Atera runs ----------
export async function recordAteraRun(run) {
  const org_id = await getDefaultOrgId();
  const { data, error } = await supa.from('atera_runs').insert({ ...run, org_id }).select('id').single();
  if (error) throw error;
  return data.id;
}

// ---------- Auditoria ----------
export async function audit(actor, action, entity, entity_id, meta = null) {
  try {
    const org_id = await getDefaultOrgId();
    await supa.from('audit_log').insert({ org_id, actor, action, entity, entity_id: entity_id != null ? String(entity_id) : null, meta });
  } catch {
    /* auditoria é best-effort, nunca derruba a operação */
  }
}
