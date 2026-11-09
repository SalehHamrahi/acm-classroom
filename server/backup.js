import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { postgresEnvironmentFromUrl } from './postgres-config.js';

const POSTGRES_BACKUP_PATTERN = /^acm-classroom-(\d{8}T\d{6}Z)-([a-f0-9]{8})\.dump$/;

/** Execute pg_dump/pg_restore without blocking the web server's event loop. */
export function runPostgresTool(command, args, {
  databaseUrl = process.env.DATABASE_URL,
  timeoutMs = 60_000,
  maxBuffer = 16 * 1024 * 1024,
} = {}) {
  if (!databaseUrl) return Promise.reject(new Error('DATABASE_URL برای اجرای ابزار PostgreSQL تنظیم نشده است.'));
  const env = postgresEnvironmentFromUrl(databaseUrl);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let terminalError = null;
    let timeout = null;
    let forceKill = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
    };
    const collect = (target, stream) => {
      stream.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maxBuffer) {
          if (!terminalError) {
            terminalError = new Error(`خروجی ابزار ${command} از حد مجاز ${maxBuffer} بایت بیشتر شد.`);
            child.kill('SIGTERM');
            forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
            forceKill.unref?.();
          }
          return;
        }
        target.push(chunk);
      });
    };
    collect(stdout, child.stdout);
    collect(stderr, child.stderr);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result = {
        status: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (terminalError) reject(terminalError);
      else if (timedOut) reject(new Error(`اجرای ${command} پس از ${timeoutMs} میلی‌ثانیه متوقف شد.`));
      else resolve(result);
    });

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
      forceKill.unref?.();
    }, timeoutMs);
    timeout.unref?.();
  });
}

export async function createPostgresBackup(backupDir, databaseUrl = process.env.DATABASE_URL, now = Date.now()) {
  if (!databaseUrl) throw new Error('DATABASE_URL برای پشتیبان‌گیری PostgreSQL تنظیم نشده است.');
  const directory = path.resolve(backupDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* platform may not support POSIX permissions */ }
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const filename = `acm-classroom-${stamp}-${crypto.randomBytes(4).toString('hex')}.dump`;
  const target = path.join(directory, filename);
  try {
    const dump = await runPostgresTool(process.env.PG_DUMP_BIN || 'pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', target], {
      databaseUrl, timeoutMs: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
    });
    if (dump.status !== 0) throw new Error(`pg_dump ناموفق بود: ${dump.stderr || `exit ${dump.status}`}`);
    if (!fs.existsSync(target) || fs.statSync(target).size < 512) throw new Error('فایل پشتیبان PostgreSQL ایجاد نشد یا اندازهٔ آن غیرعادی است.');
    const validation = await runPostgresTool(process.env.PG_RESTORE_BIN || 'pg_restore', ['--list', target], {
      databaseUrl, timeoutMs: 60_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (validation.status !== 0 || !String(validation.stdout || '').includes('TABLE')) {
      throw new Error(`اعتبارسنجی فایل پشتیبان PostgreSQL ناموفق بود: ${validation.stderr || 'ساختار dump معتبر نیست.'}`);
    }
    try { fs.chmodSync(target, 0o600); } catch { /* platform may not support POSIX permissions */ }
    return { filename, path: target, size: fs.statSync(target).size, createdAt: new Date(now).toISOString(), engine: 'postgres' };
  } catch (error) {
    try { fs.rmSync(target, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}

export async function createDatabaseBackup(db, backupDir, now = Date.now()) {
  if (db?.kind !== 'postgres') throw new Error('پشتیبان‌گیری تولیدی فقط از PostgreSQL پشتیبانی می‌کند.');
  return createPostgresBackup(backupDir, db.databaseUrl || process.env.DATABASE_URL, now);
}

export function listDatabaseBackups(backupDir) {
  const directory = path.resolve(backupDir);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && POSTGRES_BACKUP_PATTERN.test(entry.name))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      const stat = fs.statSync(filePath);
      return { filename: entry.name, size: stat.size, createdAt: stat.mtime.toISOString(), engine: 'postgres' };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function resolveDatabaseBackupFile(backupDir, filename) {
  if (typeof filename !== 'string' || !POSTGRES_BACKUP_PATTERN.test(filename) || path.basename(filename) !== filename) return null;
  const target = path.resolve(backupDir, filename);
  const base = `${path.resolve(backupDir)}${path.sep}`;
  return target.startsWith(base) && fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
}

export function pruneDatabaseBackups(backupDir, retentionDays = 30, now = Date.now()) {
  const keepAfter = now - Math.max(1, Number(retentionDays) || 30) * 86400000;
  let removed = 0;
  for (const backup of listDatabaseBackups(backupDir)) {
    const createdAt = Date.parse(backup.createdAt);
    if (!Number.isFinite(createdAt) || createdAt >= keepAfter) continue;
    fs.rmSync(path.join(path.resolve(backupDir), backup.filename), { force: true });
    removed += 1;
  }
  return removed;
}
