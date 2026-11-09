import crypto from 'node:crypto';
import { openPostgresDatabase } from './postgres-database.js';

/**
 * Production database boundary.
 * PostgreSQL is the only supported application database. SQLite lives in
 * sqlite-test-database.js and is imported explicitly by isolated unit tests.
 */
export function openDatabase(options = {}) {
  if (Object.keys(options || {}).length) {
    throw new Error('گزینه‌های دیتابیس محلی حذف شده‌اند؛ ACM Classroom فقط از PostgreSQL استفاده می‌کند.');
  }
  const driver = String(process.env.DATABASE_DRIVER || '').trim().toLowerCase();
  if (driver !== 'postgres') {
    throw new Error('ACM Classroom فقط از PostgreSQL پشتیبانی می‌کند. مقدار DATABASE_DRIVER=postgres را در فایل .env تنظیم کن.');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL تنظیم نشده است. ابتدا PostgreSQL را اجرا و نشانی اتصال را در فایل .env ثبت کن.');
  }
  return openPostgresDatabase({ databaseUrl: process.env.DATABASE_URL });
}

export function createId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [salt, expectedHex] = String(encoded || '').split(':');
    if (!salt || !expectedHex) return false;
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function logAudit(db, actorId, action, targetType, targetId = '', details = '') {
  await db.prepare('INSERT INTO audit_log(actor_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actorId || null, action, targetType, String(targetId || ''), String(details || '').slice(0, 1000), nowIso());
}

export async function createUser(db, { username, displayName, role, password, mustChangePassword = false }) {
  const id = createId();
  await db.prepare(`INSERT INTO users(id, username, display_name, role, password_hash, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, username.trim().toLowerCase(), displayName.trim(), role, hashPassword(password), mustChangePassword ? 1 : 0, nowIso());
  return id;
}
