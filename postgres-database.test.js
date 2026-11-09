import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresEnvironmentFromUrl } from './server/postgres-config.js';
import { openPostgresDatabase, compilePostgresQuery, POSTGRES_MIGRATIONS, readPostgresSchemaStatements } from './server/postgres-database.js';
import { openDatabase } from './server/db.js';
import { isUniqueConstraint } from './server/db-errors.js';
import { SCHEMA as SQLITE_TEST_SCHEMA } from './server/sqlite-test-database.js';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));

class FakeClient {
  constructor(pool) { this.pool = pool; this.released = false; }
  async query(query) { return this.pool.handle(query, 'client'); }
  release(error) { if (!this.released) { this.released = true; this.pool.releasedClients += 1; if (error) { this.pool.destroyedClients += 1; this.pool.totalCount = Math.max(0, this.pool.totalCount - 1); } else this.pool.idleCount += 1; } }
}

class FakePool {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.events = [];
    this.handlers = new Map();
    this.totalCount = 0;
    this.idleCount = 0;
    this.waitingCount = 0;
    this.releasedClients = 0;
    this.destroyedClients = 0;
    this.ended = false;
    this.serializationFailures = 0;
    FakePool.instances.push(this);
  }
  on(event, callback) { this.handlers.set(event, callback); return this; }
  async query(query) { return this.handle(query, 'pool'); }
  async connect() { if (this.idleCount > 0) this.idleCount -= 1; else this.totalCount += 1; return new FakeClient(this); }
  async end() { this.ended = true; }
  async handle(query, source) {
    const text = typeof query === 'string' ? query : query.text;
    const values = typeof query === 'string' ? [] : (query.values || []);
    const name = typeof query === 'string' ? null : query.name;
    this.events.push({ text, values, name, source });
    if (/SIMULATE_DUPLICATE/.test(text)) {
      const error = new Error('duplicate key value violates unique constraint');
      error.code = '23505';
      throw error;
    }
    if (/SIMULATE_CONNECTION_LOSS/.test(text)) {
      const error = new Error('connection reset by peer');
      error.code = 'ECONNRESET';
      throw error;
    }
    if (/SERIALIZATION_RETRY/.test(text) && this.serializationFailures > 0) {
      this.serializationFailures -= 1;
      const error = new Error('could not serialize access due to concurrent update');
      error.code = '40001';
      throw error;
    }
    if (/SELECT\s+version\s+FROM\s+acm_schema_migrations/i.test(text)) return { rows: [], rowCount: 0, command: 'SELECT' };
    if (/SELECT\s+\$1\s+AS\s+"displayName"/i.test(text)) return { rows: [{ displayName: values[0] }], rowCount: 1, command: 'SELECT' };
    if (/SELECT\s+42::integer\s+AS\s+value/i.test(text)) return { rows: [{ value: 42 }], rowCount: 1, command: 'SELECT' };
    if (/SELECT\s+true\s+AS\s+on_client/i.test(text)) return { rows: [{ on_client: source === 'client' }], rowCount: 1, command: 'SELECT' };
    if (/INSERT\s+INTO\s+fake_table/i.test(text)) return { rows: [], rowCount: 1, command: 'INSERT' };
    if (/SELECT\s+\$1\s+AS\s+value/i.test(text)) return { rows: [{ value: values[0] }], rowCount: 1, command: 'SELECT' };
    const command = String(text).trim().split(/\s+/, 1)[0]?.toUpperCase() || 'EMPTY';
    return { rows: [], rowCount: ['INSERT', 'UPDATE', 'DELETE'].includes(command) ? 1 : 0, command };
  }
}

async function openFakeDatabase(options = {}) {
  FakePool.instances.length = 0;
  const db = await openPostgresDatabase({
    databaseUrl: 'postgresql://acm_test:test@127.0.0.1:5432/acm_test?sslmode=disable',
    PoolClass: FakePool,
    ...options,
  });
  return { db, pool: FakePool.instances.at(-1) };
}

test('PostgreSQL URL is parsed into a minimal libpq environment without leaking unrelated app secrets', () => {
  const env = postgresEnvironmentFromUrl('postgresql://acm_user:p%40ss%3Aword@127.0.0.1:5544/acm_db?sslmode=disable&application_name=acm-test&options=-csearch_path%3Dacm_test%2Cpublic', {
    PATH: '/bin', HOME: '/tmp', BALE_BOT_TOKEN: 'must-not-be-forwarded', DATABASE_URL: 'must-not-be-forwarded',
  });
  assert.equal(env.PGHOST, '127.0.0.1');
  assert.equal(env.PGPORT, '5544');
  assert.equal(env.PGDATABASE, 'acm_db');
  assert.equal(env.PGUSER, 'acm_user');
  assert.equal(env.PGPASSWORD, 'p@ss:word');
  assert.equal(env.PGSSLMODE, 'disable');
  assert.equal(env.PGAPPNAME, 'acm-test');
  assert.equal(env.PGOPTIONS, '-csearch_path=acm_test,public');
  assert.equal(env.PGCONNECT_TIMEOUT, '8');
  assert.equal(env.BALE_BOT_TOKEN, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.throws(() => postgresEnvironmentFromUrl('mysql://localhost/db'), /postgresql/);
  assert.throws(() => postgresEnvironmentFromUrl('postgresql:///missing-user'), /میزبان/);
});

test('PostgreSQL query compiler binds values without interpolation and preserves aliases and SQL literals', () => {
  assert.deepEqual(compilePostgresQuery('SELECT ? AS value, ? AS enabled', [42, true]), {
    text: 'SELECT $1 AS value, $2 AS enabled', values: [42, true],
  });
  assert.equal(compilePostgresQuery('SELECT display_name AS displayName, created_at AS createdAt FROM users').text,
    'SELECT display_name AS "displayName", created_at AS "createdAt" FROM users');
  assert.equal(compilePostgresQuery('CREATE TABLE identity_probe (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY)').text,
    'CREATE TABLE identity_probe (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY)');
  assert.equal(compilePostgresQuery('SELECT score AS totalScore, user_id AS userId FROM results').text,
    'SELECT score AS "totalScore", user_id AS "userId" FROM results');
  assert.equal(compilePostgresQuery('SELECT password_hash AS _passwordHash FROM users').text,
    'SELECT password_hash AS "_passwordHash" FROM users');
  assert.equal(compilePostgresQuery('SELECT 1 AS VALUE').text, 'SELECT 1 AS VALUE');
  assert.equal(compilePostgresQuery("SELECT 'AS displayName ?' AS note, display_name AS displayName -- AS createdAt ?\nWHERE id=?", ['x']).text,
    "SELECT 'AS displayName ?' AS note, display_name AS \"displayName\" -- AS createdAt ?\nWHERE id=$1");
  assert.deepEqual(compilePostgresQuery("SELECT $$? AS ignored$$ AS note, ? AS value", ['safe']), {
    text: 'SELECT $$? AS ignored$$ AS note, $1 AS value', values: ['safe'],
  });
  assert.equal(compilePostgresQuery('DO $body$ BEGIN PERFORM 1 AS totalScore; END $body$;').text,
    'DO $body$ BEGIN PERFORM 1 AS totalScore; END $body$;');
  assert.throws(() => compilePostgresQuery('SELECT ? AS value', []), /پارامتر/);
  assert.throws(() => compilePostgresQuery('SELECT 1', [1]), /تعداد پارامتر/);
  assert.throws(() => compilePostgresQuery('PRAGMA foreign_keys'), /PRAGMA در PostgreSQL/);
  assert.throws(() => compilePostgresQuery('INSERT OR IGNORE INTO items(id) VALUES(?)', ['x']), /SQLite/);
});

test('nullable SQL filters explicitly type NULL parameters for PostgreSQL', () => {
  const appSource = fs.readFileSync(path.join(root, 'server', 'app.js'), 'utf8');
  assert.doesNotMatch(appSource, /\(\?\s+IS\s+NULL/i, 'untyped nullable placeholders can fail with PostgreSQL parameter type inference');
  assert.equal((appSource.match(/CAST\(\?\s+AS\s+TEXT\)\s+IS\s+NULL/gi) || []).length, 8);
  assert.equal((appSource.match(/AND\s+\(CAST\(\?\s+AS\s+TEXT\)\s+IS\s+NULL/gi) || []).length, 8, 'optional OR filters must retain their grouping');
  assert.doesNotMatch(appSource, /AND\s+CAST\(\?\s+AS\s+TEXT\)\s+IS\s+NULL\s+OR/i);
  assert.deepEqual(compilePostgresQuery('SELECT 1 WHERE CAST(? AS TEXT) IS NULL OR id = ?', [null, 'item-1']), {
    text: 'SELECT 1 WHERE CAST($1 AS TEXT) IS NULL OR id = $2',
    values: [null, 'item-1'],
  });
});

test('PostgreSQL unique violations are normalized for conflict API responses', () => {
  assert.equal(isUniqueConstraint({ code: '23505', message: 'duplicate key value violates unique constraint "users_username_key"' }), true);
  assert.equal(isUniqueConstraint({ code: '23503', message: 'foreign key violation' }), false);
  assert.equal(isUniqueConstraint({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed: users.username' }), true);
});

test('PostgreSQL-native schema contains all application tables, foreign keys and production indexes only', () => {
  const statements = readPostgresSchemaStatements();
  const ddl = statements.join('\n');
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS assignments/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS contests/);
  assert.match(ddl, /GENERATED BY DEFAULT AS IDENTITY/);
  assert.match(ddl, /ALTER TABLE problems ADD CONSTRAINT fk_problems_session_id/);
  assert.match(ddl, /idx_submissions_student_problem_ai_created/);
  assert.match(ddl, /idx_users_username_casefold/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS login_sessions[\s\S]*expires_at BIGINT NOT NULL/);
  assert.doesNotMatch(ddl, /expires_at INTEGER NOT NULL/);
  const expiryMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === '2.11.1');
  assert.ok(expiryMigration);
  assert.match(expiryMigration.statements.join('\n'), /ALTER TABLE login_sessions ALTER COLUMN expires_at TYPE BIGINT/);
  const nativeMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === '2.12.0');
  assert.ok(nativeMigration);
  assert.match(nativeMigration.statements.join('\n'), /information_schema\.columns[\s\S]*data_type = 'integer'[\s\S]*TYPE BIGINT/);
  assert.ok(nativeMigration.statements.some((statement) => /CREATE INDEX IF NOT EXISTS idx_submissions_student_problem_ai_created/i.test(statement)));
  assert.doesNotMatch(ddl, /PRAGMA|AUTOINCREMENT|COLLATE NOCASE|learning_path/i);
  assert.ok(ddl.indexOf('CREATE TABLE IF NOT EXISTS problems') < ddl.indexOf('ALTER TABLE problems ADD CONSTRAINT fk_problems_session_id'));
});

test('PostgreSQL schema has exact table parity with the isolated test model', () => {
  const extract = (sql) => [...String(sql).matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)].map((match) => match[1]).sort();
  assert.deepEqual(extract(readPostgresSchemaStatements().join('\n')), extract(SQLITE_TEST_SCHEMA));
  assert.equal(extract(readPostgresSchemaStatements().join('\n')).some((name) => /course|learning_path/i.test(name)), false);
});

test('PostgreSQL API test runner rejects the production database before spawning tests', () => {
  const runner = path.join(root, 'scripts', 'run-postgres-api-tests.js');
  const databaseUrl = 'postgresql://acm_user:secret@127.0.0.1:5432/acm_classroom?sslmode=disable';
  const result = spawnSync(process.execPath, [runner], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /دیتابیس جداگانه|دیتابیس تولیدی/);
});

test('PostgreSQL API test runner requires a test-named database', () => {
  const runner = path.join(root, 'scripts', 'run-postgres-api-tests.js');
  const result = spawnSync(process.execPath, [runner], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://acm_user:secret@127.0.0.1:5432/acm_classroom?sslmode=disable',
      TEST_DATABASE_URL: 'postgresql://acm_user:secret@127.0.0.1:5432/acm_scratch?sslmode=disable',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /نام دیتابیس آزمایشی باید شامل test باشد/);
});

test('continuous integration runs the complete API compatibility suite on a real PostgreSQL 16 service', () => {
  const workflowPath = path.join(root, '.github', 'workflows', 'postgres-compatibility.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /image:\s*postgres:16/);
  assert.match(workflow, /npm run test:postgres/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /acm_classroom_test/);
});

test('production database uses pg Pool and contains no worker or psql query bridge', () => {
  const dbSource = fs.readFileSync(path.join(root, 'server', 'db.js'), 'utf8');
  const postgresSource = fs.readFileSync(path.join(root, 'server', 'postgres-database.js'), 'utf8');
  assert.doesNotMatch(dbSource, /from ['"]\.\/sqlite-test-database/);
  assert.match(postgresSource, /import\('pg'\)/);
  assert.match(postgresSource, /new PoolClass/);
  assert.match(postgresSource, /pool\.connect\(\)/);
  assert.match(postgresSource, /AsyncLocalStorage/);
  assert.doesNotMatch(postgresSource, /worker_threads|spawnSync|psqlBin|postgres-worker/);
  assert.equal(fs.existsSync(path.join(root, 'server', 'postgres-worker.js')), false);
  assert.match(postgresSource, /postgres-schema\.sql/);
  const appSource = fs.readFileSync(path.join(root, 'server', 'app.js'), 'utf8');
  assert.doesNotMatch(appSource, /db\.(?:prepare|exec)\([^)]*PRAGMA/i);
  assert.doesNotMatch(appSource, /INSERT\s+OR\s+IGNORE|COLLATE\s+NOCASE|json_group_array/i);
});

test('async pg Pool performs schema bootstrap, prepared queries and pooled reads/writes', async (t) => {
  const { db, pool } = await openFakeDatabase({ poolOptions: { max: 6 } });
  t.after(async () => db.close());
  assert.equal(db.kind, 'postgres');
  assert.equal(pool.options.max, 6);
  assert.equal(pool.options.connectionString.startsWith('postgresql://'), true);
  assert.ok(pool.events.some((event) => /CREATE TABLE IF NOT EXISTS acm_schema_migrations/.test(event.text)));
  assert.ok(pool.events.some((event) => /GENERATED BY DEFAULT AS IDENTITY/.test(event.text)));
  assert.deepEqual(await db.prepare('SELECT 42::integer AS value').get(), { value: 42 });
  assert.deepEqual(await db.prepare('SELECT 42::integer AS value').all(), [{ value: 42 }]);
  assert.deepEqual(await db.prepare('SELECT ? AS displayName').get('Saleh'), { displayName: 'Saleh' });
  assert.deepEqual(await db.prepare('INSERT INTO fake_table(value) VALUES(?)').run('x'), { changes: 1, rows: [] });
  const prepared = pool.events.filter((event) => event.text.includes('SELECT 42::integer AS value')).at(-1);
  assert.match(prepared.name, /^acm_[a-f0-9]{24}$/);
  assert.deepEqual(db.poolStats, { total: 1, idle: 1, waiting: 0, max: 6 });
});

test('async transactions pin every query to one client across awaits and nested savepoints', async (t) => {
  const { db, pool } = await openFakeDatabase();
  t.after(async () => db.close());
  const releasedBefore = pool.releasedClients;
  const result = await db.transaction(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const row = await db.prepare('SELECT true AS on_client').get();
    const write = await db.prepare('INSERT INTO fake_table(value) VALUES(?)').run('x');
    const nested = await db.transaction(async () => db.prepare('SELECT 42::integer AS value').get())();
    return { row, write, nested };
  })();
  assert.deepEqual(result, { row: { on_client: true }, write: { changes: 1, rows: [] }, nested: { value: 42 } });
  assert.ok(pool.events.some((event) => event.text.startsWith('SAVEPOINT acm_sp_') && event.source === 'client'));
  assert.ok(pool.events.some((event) => event.text === 'COMMIT' && event.source === 'client'));
  assert.equal(pool.releasedClients, releasedBefore + 1);
});

test('async transactions roll back, use savepoint rollback and retry serialization failures', async (t) => {
  const { db, pool } = await openFakeDatabase();
  t.after(async () => db.close());
  await assert.rejects(db.transaction(async () => { throw new Error('rollback-probe'); })(), /rollback-probe/);
  assert.ok(pool.events.some((event) => event.text === 'ROLLBACK' && event.source === 'client'));

  await db.transaction(async () => {
    await assert.rejects(db.transaction(async () => { throw new Error('nested-probe'); })(), /nested-probe/);
    await db.prepare('SELECT 42::integer AS value').get();
  })();
  assert.ok(pool.events.some((event) => /ROLLBACK TO SAVEPOINT acm_sp_/.test(event.text)));

  pool.serializationFailures = 1;
  const retried = await db.transaction(async () => db.prepare('SELECT 1 /* SERIALIZATION_RETRY */').get(), { retries: 2 })();
  assert.equal(retried, undefined);
});

test('async transactions normalize isolation levels and discard broken clients', async (t) => {
  const { db, pool } = await openFakeDatabase();
  t.after(async () => db.close());
  await db.transaction(async () => db.prepare('SELECT 42::integer AS value').get(), { isolationLevel: 'read committed' })();
  assert.ok(pool.events.some((event) => event.text === 'BEGIN ISOLATION LEVEL READ COMMITTED'));
  const destroyedBefore = pool.destroyedClients;
  await assert.rejects(db.transaction(async () => db.prepare('SELECT SIMULATE_CONNECTION_LOSS').get())(), (error) => error.code === 'ECONNRESET');
  assert.equal(pool.destroyedClients, destroyedBefore + 1);
});

test('async pg Pool propagates SQLSTATE errors and can be closed cleanly', async () => {
  const { db, pool } = await openFakeDatabase();
  await assert.rejects(db.prepare('SELECT SIMULATE_DUPLICATE').get(), (error) => error.code === '23505');
  await db.prepare('SELECT 42::integer AS value').get();
  await db.close();
  assert.equal(pool.ended, true);
});

test('production database refuses every non-PostgreSQL or incomplete configuration', () => {
  const previousDriver = process.env.DATABASE_DRIVER;
  const previousUrl = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_DRIVER;
    delete process.env.DATABASE_URL;
    assert.throws(() => openDatabase(), /فقط از PostgreSQL/);
    process.env.DATABASE_DRIVER = 'sqlite';
    assert.throws(() => openDatabase(), /فقط از PostgreSQL/);
    process.env.DATABASE_DRIVER = 'postgres';
    assert.throws(() => openDatabase(), /DATABASE_URL/);
    assert.throws(() => openDatabase({ dbPath: ':memory:' }), /گزینه‌های دیتابیس محلی/);
  } finally {
    if (previousDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = previousDriver;
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
  }
});

test('PostgreSQL aggregate queries explicitly group joined display columns', () => {
  const source = fs.readFileSync(path.join(root, 'server', 'app.js'), 'utf8');
  assert.match(source, /GROUP BY s\.id, s\.title, c\.title, s\.is_contest, s\.is_assignment, s\.created_at ORDER BY s\.created_at DESC/);
  assert.match(source, /WHERE ap\.assignment_id=\? GROUP BY u\.id, u\.username, u\.display_name, ap\.source_class_id, c\.title, ap\.student_id, ap\.assignment_id ORDER BY u\.display_name/);
  assert.match(source, /GROUP BY u\.id, u\.username, u\.display_name ORDER BY points DESC/);
  assert.match(source, /GROUP BY c\.id, c\.title/);
  assert.match(source, /GROUP BY ct\.id, ct\.title/);
  assert.match(source, /SELECT "classId","classTitle",SUM\(submissions\)/);
  assert.match(source, /GROUP BY "classId","classTitle" ORDER BY "classTitle"/);
});
