import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEnv } from '../server/env.js';
import { openDatabase } from '../server/db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(root, '.env'));
const db = await openDatabase();
try {
  const row = await db.prepare(`SELECT current_database() AS database, current_setting('server_version') AS version`).get();
  console.log(`Database reachable: ${db.kind}${row?.version ? ` (${row.version})` : ''}`);
} finally {
  await db.close();
}
