import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server/env.js';
import { createPostgresBackup, resolveDatabaseBackupFile, runPostgresTool } from '../server/backup.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(root, '.env'));
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] || '' : ''; };
const backupDir = path.resolve(process.env.BACKUP_DIR || '/var/backups/acm-classroom');
const backupName = option('--backup');
const confirmed = args.includes('--yes');

async function runPostgresRestore(backupPath) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL تنظیم نشده است.');
  const pgRestore = process.env.PG_RESTORE_BIN || 'pg_restore';
  const validation = await runPostgresTool(pgRestore, ['--list', backupPath], { timeoutMs: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (validation.status !== 0 || !String(validation.stdout || '').includes('TABLE')) {
    throw new Error(`فایل پشتیبان PostgreSQL معتبر نیست: ${validation.stderr || 'invalid dump'}`);
  }

  // Stop the application and notification worker before restore. Keep both a
  // pre-restore database snapshot and a rollback path if pg_restore fails.
  const safety = await createPostgresBackup(backupDir, process.env.DATABASE_URL);
  const restoreArgs = ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', backupPath];
  const restored = await runPostgresTool(pgRestore, restoreArgs, { timeoutMs: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  if (restored.status !== 0) {
    const rollback = await runPostgresTool(pgRestore, ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', safety.path], {
      timeoutMs: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
    });
    if (rollback.status !== 0) {
      throw new Error(`بازیابی ناموفق بود و بازگردانی خودکار نسخهٔ ایمنی نیز شکست خورد. فایل ایمنی: ${safety.filename}. خطای بازیابی: ${restored.stderr || restored.status}. خطای بازگردانی: ${rollback.stderr || rollback.status}`);
    }
    throw new Error(`بازیابی ناموفق بود؛ نسخهٔ ایمنی ${safety.filename} با موفقیت دوباره اعمال شد. ${restored.stderr || `exit ${restored.status}`}`);
  }
  console.log(`PostgreSQL restored from ${path.basename(backupPath)}.`);
  console.log(`Safety snapshot retained at ${safety.filename}.`);
}

if (!backupName || !confirmed) {
  console.error('Usage: npm run restore:db -- --backup <backup-filename.dump> --yes');
  console.error('Stop acm-classroom.service before running this command.');
  process.exitCode = 2;
} else {
  const backupPath = resolveDatabaseBackupFile(backupDir, backupName);
  if (!backupPath) {
    console.error('Only verified PostgreSQL .dump backups inside BACKUP_DIR can be restored.');
    process.exitCode = 1;
  } else {
    try { await runPostgresRestore(backupPath); }
    catch (error) {
      console.error(`Restore failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
