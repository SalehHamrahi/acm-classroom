import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server/env.js';
import { openDatabase } from '../server/db.js';
import { createDatabaseBackup, pruneDatabaseBackups } from '../server/backup.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(root, '.env'));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const backupDir = path.resolve(option('--backup-dir', process.env.BACKUP_DIR || '/var/backups/acm-classroom'));
const retentionDays = Math.max(1, Math.min(365, Number(option('--retention-days', process.env.BACKUP_RETENTION_DAYS || 30)) || 30));
const db = await openDatabase();
try {
  const backup = await createDatabaseBackup(db, backupDir);
  const pruned = pruneDatabaseBackups(backupDir, retentionDays);
  console.log(`Verified ${backup.engine || db.kind} backup created: ${backup.path} (${backup.size} bytes); pruned: ${pruned}`);
} finally {
  await db.close();
}
