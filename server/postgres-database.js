import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const POSTGRES_SCHEMA_PATH = fileURLToPath(new URL('./postgres-schema.sql', import.meta.url));
const POSTGRES_SCHEMA = fs.readFileSync(POSTGRES_SCHEMA_PATH, 'utf8');

function quoteCamelCaseAliases(sql) {
  const source = String(sql || '');
  let output = '';
  let index = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockDepth = 0;
  let dollarTag = null;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      output += char; index += 1;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockDepth > 0) {
      output += char; index += 1;
      if (char === '/' && next === '*') { output += next; index += 1; blockDepth += 1; }
      else if (char === '*' && next === '/') { output += next; index += 1; blockDepth -= 1; }
      continue;
    }
    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        output += dollarTag; index += dollarTag.length; dollarTag = null;
      } else { output += char; index += 1; }
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '-' && next === '-') {
      output += '--'; index += 2; lineComment = true; continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '/' && next === '*') {
      output += '/*'; index += 2; blockDepth = 1; continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '$') {
      const match = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; output += dollarTag; index += dollarTag.length; continue; }
    }
    if (!doubleQuoted && char === "'") {
      output += char; index += 1;
      if (singleQuoted && next === "'") { output += next; index += 1; }
      else singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && char === '"') {
      output += char; index += 1;
      if (doubleQuoted && next === '"') { output += next; index += 1; }
      else doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && /[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      const token = source.slice(start, index);
      output += token;
      if (token.toUpperCase() !== 'AS') continue;
      let whitespaceEnd = index;
      while (whitespaceEnd < source.length && /\s/.test(source[whitespaceEnd])) whitespaceEnd += 1;
      const match = source.slice(whitespaceEnd).match(/^([A-Za-z_][A-Za-z0-9_$]*)/);
      if (!match) continue;
      const alias = match[1];
      if (!/^_*[a-z][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*$/.test(alias)) continue;
      output += source.slice(index, whitespaceEnd) + `"${alias}"`;
      index = whitespaceEnd + alias.length;
      continue;
    }
    output += char; index += 1;
  }
  return output;
}

/** Convert the application's positional `?` placeholders to node-postgres `$n` placeholders.
 * Quoted literals, quoted identifiers, comments and PostgreSQL dollar-quoted strings are skipped.
 */
export function compilePostgresQuery(sql, params = []) {
  const source = quoteCamelCaseAliases(String(sql || '').trim());
  let text = '';
  let parameterIndex = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockDepth = 0;
  let dollarTag = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      text += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockDepth > 0) {
      text += char;
      if (char === '/' && next === '*') { text += next; index += 1; blockDepth += 1; }
      else if (char === '*' && next === '/') { text += next; index += 1; blockDepth -= 1; }
      continue;
    }
    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) { text += dollarTag; index += dollarTag.length - 1; dollarTag = null; }
      else text += char;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '-' && next === '-') {
      text += '--'; index += 1; lineComment = true; continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '/' && next === '*') {
      text += '/*'; index += 1; blockDepth = 1; continue;
    }
    if (!doubleQuoted && char === "'") {
      text += char;
      if (singleQuoted && next === "'") { text += next; index += 1; }
      else singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && char === '"') {
      text += char;
      if (doubleQuoted && next === '"') { text += next; index += 1; }
      else doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '$') {
      const match = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; text += dollarTag; index += dollarTag.length - 1; continue; }
    }
    if (!singleQuoted && !doubleQuoted && char === '?') {
      if (parameterIndex >= params.length) throw new TypeError(`برای پرس‌وجوی دیتابیس پارامتر شمارهٔ ${parameterIndex + 1} ارسال نشده است.`);
      parameterIndex += 1;
      text += `$${parameterIndex}`;
      continue;
    }
    text += char;
  }
  if (parameterIndex !== params.length) throw new TypeError(`تعداد پارامترهای دیتابیس نادرست است؛ ${parameterIndex} جای‌نگهدار و ${params.length} مقدار دریافت شد.`);
  if (/^\s*PRAGMA\b/i.test(text)) throw new Error('PRAGMA در PostgreSQL پشتیبانی نمی‌شود؛ از SQL بومی PostgreSQL استفاده کن.');
  if (/INSERT\s+OR\s+IGNORE|COLLATE\s+NOCASE|json_group_array|BEGIN\s+IMMEDIATE/i.test(text)) {
    throw new Error('عبارت مخصوص SQLite در SQL تولیدی شناسایی شد؛ کوئری باید به PostgreSQL مهاجرت کند.');
  }
  return { text, values: params };
}

const POSTGRES_INDEX_MIGRATION = [...POSTGRES_SCHEMA.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS[\s\S]*?;/gi)]
  .map((match) => match[0].trim());

export const POSTGRES_MIGRATIONS = Object.freeze([
  {
    version: '2.11.1',
    statements: [
      'ALTER TABLE login_sessions ALTER COLUMN expires_at TYPE BIGINT USING expires_at::BIGINT;',
    ],
  },
  {
    version: '2.12.0',
    statements: [
      `DO $acm_migrate$
DECLARE column_row RECORD;
BEGIN
  FOR column_row IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND data_type = 'integer'
      AND is_identity = 'NO'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE BIGINT USING %I::BIGINT',
      column_row.table_schema, column_row.table_name, column_row.column_name, column_row.column_name);
  END LOOP;
END
$acm_migrate$;`,
      ...POSTGRES_INDEX_MIGRATION,
    ],
  },
]);

export function readPostgresSchemaStatements() {
  const withoutLineComments = POSTGRES_SCHEMA.replace(/^\s*--.*$/gm, '');
  return withoutLineComments.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => `${statement};`);
}

function makeStatementName(text) {
  return `acm_${crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)}`;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function openPostgresDatabase({
  databaseUrl = process.env.DATABASE_URL,
  PoolClass,
  poolOptions = {},
  logger = console,
} = {}) {
  if (!databaseUrl) throw new Error('برای استفاده از PostgreSQL، متغیر DATABASE_URL را در فایل .env تنظیم کن.');
  let pgTypes = null;
  if (!PoolClass) {
    try {
      const pg = await import('pg');
      PoolClass = pg.Pool || pg.default?.Pool;
      pgTypes = pg.types || pg.default?.types || null;
    } catch (error) {
      throw new Error(`درایور رسمی PostgreSQL نصب نیست. دستور npm install را اجرا کن. جزئیات: ${error.message}`);
    }
  }
  // node-postgres normally returns int8/BIGINT as strings. The former JSON bridge
  // exposed safe integer values as JavaScript numbers, so preserve that contract
  // without losing precision for values outside Number's safe range.
  if (pgTypes?.setTypeParser && pgTypes?.getTypeParser) {
    const originalInt8Parser = pgTypes.getTypeParser(20, 'text');
    pgTypes.setTypeParser(20, 'text', (value) => {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : originalInt8Parser(value);
    });
  }
  if (typeof PoolClass !== 'function') throw new TypeError('کلاس Pool معتبر از درایور pg دریافت نشد.');

  const max = Math.max(2, Math.min(50, Math.trunc(Number(poolOptions.max ?? process.env.PG_POOL_MAX) || 10)));
  const idleTimeoutMillis = Math.max(1000, Math.trunc(Number(poolOptions.idleTimeoutMillis ?? process.env.PG_IDLE_TIMEOUT_MS) || 30000));
  const connectionTimeoutMillis = Math.max(1000, Math.trunc(Number(poolOptions.connectionTimeoutMillis ?? process.env.PG_CONNECTION_TIMEOUT_MS) || 8000));
  const pool = new PoolClass({
    ...poolOptions,
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    keepAlive: true,
    allowExitOnIdle: false,
    application_name: 'acm-classroom',
  });
  const context = new AsyncLocalStorage();
  const activeQuery = () => context.getStore()?.client || pool;

  pool.on?.('error', (error) => logger.error?.('[PostgreSQL pool] idle client error:', error));

  const execute = async (sql, params = [], { prepared = true } = {}) => {
    const compiled = compilePostgresQuery(sql, params);
    if (!compiled.text) return { rows: [], rowCount: 0, command: 'EMPTY' };
    const query = prepared
      ? { name: makeStatementName(compiled.text), text: compiled.text, values: compiled.values }
      : { text: compiled.text, values: compiled.values };
    return activeQuery().query(query);
  };

  const db = {
    kind: 'postgres',
    databaseUrl,
    pool,
    get poolStats() { return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max }; },
    prepare(sql) {
      const statement = String(sql);
      return {
        async get(...params) {
          const result = await execute(statement, params);
          return result.rows[0];
        },
        async all(...params) {
          const result = await execute(statement, params);
          return result.rows;
        },
        async run(...params) {
          const result = await execute(statement, params);
          return { changes: Number(result.rowCount || 0), rows: result.rows || [] };
        },
      };
    },
    async exec(sql) {
      const compiled = compilePostgresQuery(sql, []);
      if (!compiled.text.trim()) return;
      // Schema and migration batches are intentionally sent as simple-query text.
      return activeQuery().query(compiled.text);
    },
    transaction(fn, { isolationLevel = 'SERIALIZABLE', retries = 3 } = {}) {
      if (typeof fn !== 'function') throw new TypeError('تابع تراکنش باید معتبر باشد.');
      return async (...args) => {
        const parent = context.getStore();
        if (parent?.client) {
          const savepoint = `acm_sp_${crypto.randomBytes(6).toString('hex')}`;
          await parent.client.query(`SAVEPOINT ${savepoint}`);
          try {
            const value = await fn(...args);
            await parent.client.query(`RELEASE SAVEPOINT ${savepoint}`);
            return value;
          } catch (error) {
            try { await parent.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch { /* preserve original error */ }
            throw error;
          }
        }

        const allowedIsolation = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);
        const normalizedIsolation = String(isolationLevel).trim().toUpperCase();
        if (!allowedIsolation.has(normalizedIsolation)) throw new TypeError('سطح isolation تراکنش معتبر نیست.');
        const retryLimit = Math.max(1, Math.min(10, Math.trunc(Number(retries) || 1)));
        const isConnectionFailure = (error) => Boolean(
          /^08/.test(String(error?.code || ''))
          || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', '57P01', '57P02', '57P03'].includes(error?.code)
        );
        let lastError;
        for (let attempt = 0; attempt < retryLimit; attempt += 1) {
          const client = await pool.connect();
          let releaseError;
          let retryDelay = 0;
          try {
            await client.query(`BEGIN ISOLATION LEVEL ${normalizedIsolation}`);
            const value = await context.run({ client }, () => fn(...args));
            await client.query('COMMIT');
            return value;
          } catch (error) {
            lastError = error;
            if (isConnectionFailure(error)) releaseError = error;
            try { await client.query('ROLLBACK'); } catch (rollbackError) {
              if (isConnectionFailure(rollbackError)) releaseError = rollbackError;
            }
            const retryable = ['40001', '40P01'].includes(error?.code);
            if (!retryable || attempt + 1 >= retryLimit) throw error;
            retryDelay = 20 * (2 ** attempt) + Math.floor(Math.random() * 20);
          } finally {
            // node-postgres destroys a client when release(error) is used,
            // preventing a broken socket from being returned to the idle pool.
            client.release(releaseError);
          }
          if (retryDelay) await delay(retryDelay);
        }
        throw lastError;
      };
    },
    async close() { await pool.end(); },
  };

  try {
    await pool.query('SELECT 1');
    await db.exec('CREATE TABLE IF NOT EXISTS acm_schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);');
    const applied = new Set((await db.prepare('SELECT version FROM acm_schema_migrations').all()).map((row) => row.version));
    if (!applied.has('2.11.0')) {
      await db.transaction(async () => {
        for (const statement of readPostgresSchemaStatements()) await db.exec(statement);
        await db.prepare('INSERT INTO acm_schema_migrations(version) VALUES(?) ON CONFLICT(version) DO NOTHING').run('2.11.0');
      })();
    }
    for (const migration of POSTGRES_MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await db.transaction(async () => {
        for (const statement of migration.statements) await db.exec(statement);
        await db.prepare('INSERT INTO acm_schema_migrations(version) VALUES(?) ON CONFLICT(version) DO NOTHING').run(migration.version);
      })();
    }
  } catch (error) {
    try { await db.close(); } catch { /* preserve schema initialization error */ }
    throw new Error(`آماده‌سازی PostgreSQL ناموفق بود: ${error.message}`, { cause: error });
  }
  return db;
}
