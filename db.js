// Camada de dados — usuários e papéis, persistidos em libSQL/Turso.
// Em produção usa a URL remota do Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN);
// em dev cai num arquivo SQLite local (data/ego.db). Mesmo cliente, mesmo código.
import { createClient } from '@libsql/client';
import crypto from 'node:crypto';

const url = process.env.TURSO_DATABASE_URL || 'file:./data/ego.db';
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

export const db = createClient({ url, authToken });
export const DB_MODE = url.startsWith('file:') ? 'local' : 'turso';

const ROLES = new Set(['admin', 'user', 'guest']);
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

// ---------- Migração ----------
export async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
}

// ---------- Seed do admin inicial ----------
// Cria o primeiro admin a partir de ADMIN_EMAIL/ADMIN_PASSWORD se a tabela
// estiver vazia (resolve o ovo-e-galinha: precisa de admin pra criar usuários).
export async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return { seeded: false, reason: 'ADMIN_EMAIL/ADMIN_PASSWORD ausentes' };
  const existing = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  if (existing.rows.length) return { seeded: false, reason: 'admin já existe' };
  await createUser({ email, password, role: 'admin' });
  return { seeded: true, email };
}

// ---------- CRUD ----------
function rowToUser(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    email: r.email,
    role: r.role,
    active: Number(r.active) === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function getUserByEmail(email) {
  const r = await db.execute({
    sql: 'SELECT * FROM users WHERE email = ? LIMIT 1',
    args: [String(email).trim().toLowerCase()],
  });
  return r.rows[0] || null; // inclui password_hash — uso interno no /auth
}

export async function listUsers() {
  const r = await db.execute(
    'SELECT id, email, role, active, created_at, updated_at FROM users ORDER BY created_at DESC',
  );
  return r.rows.map(rowToUser);
}

export async function getUserById(id) {
  const r = await db.execute({
    sql: 'SELECT id, email, role, active, created_at, updated_at FROM users WHERE id = ?',
    args: [Number(id)],
  });
  return rowToUser(r.rows[0]);
}

export async function createUser({ email, password, role = 'user' }) {
  const em = String(email).trim().toLowerCase();
  if (!em || !password) throw new Error('email e senha obrigatórios');
  if (!isValidRole(role)) throw new Error('papel inválido');
  const now = new Date().toISOString();
  await db.execute({
    sql: 'INSERT INTO users (email, password_hash, role, active, created_at) VALUES (?, ?, ?, 1, ?)',
    args: [em, hashPassword(password), role, now],
  });
  return getUserByEmail(em).then(rowToUser);
}

export async function updateUser(id, { role, active, password }) {
  const sets = [];
  const args = [];
  if (role !== undefined) {
    if (!isValidRole(role)) throw new Error('papel inválido');
    sets.push('role = ?');
    args.push(role);
  }
  if (active !== undefined) {
    sets.push('active = ?');
    args.push(active ? 1 : 0);
  }
  if (password) {
    sets.push('password_hash = ?');
    args.push(hashPassword(password));
  }
  if (!sets.length) return getUserById(id);
  sets.push('updated_at = ?');
  args.push(new Date().toISOString());
  args.push(Number(id));
  await db.execute({ sql: `UPDATE users SET ${sets.join(', ')} WHERE id = ?`, args });
  return getUserById(id);
}

export async function deleteUser(id) {
  await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [Number(id)] });
}

export async function countUsers() {
  const r = await db.execute('SELECT COUNT(*) AS n FROM users');
  return Number(r.rows[0].n);
}
