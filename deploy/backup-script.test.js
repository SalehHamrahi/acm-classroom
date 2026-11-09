import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createPostgresBackup, createDatabaseBackup, listDatabaseBackups, resolveDatabaseBackupFile, runPostgresTool } from '../server/backup.js';

const isWindows = process.platform === 'win32';
const testUrl = 'postgresql://acm_test:1234567890abcdef@127.0.0.1:5432/acm_test?sslmode=disable';

function fakePgTools(root, { restoreScript = '' } = {}) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const pgDump = path.join(bin, 'pg_dump');
  const pgRestore = path.join(bin, 'pg_restore');
  fs.writeFileSync(pgDump, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nconst target=args[args.indexOf('--file')+1];\nfs.writeFileSync(target, Buffer.alloc(1024, 7));\n`, { mode: 0o755 });
  fs.writeFileSync(pgRestore, restoreScript || `#!/usr/bin/env node\nprocess.stdout.write(process.argv.includes('--list') ? 'TABLE public.users acm_classroom\\n' : 'restore-ok\\n');\n`, { mode: 0o755 });
  fs.chmodSync(pgDump, 0o755);
  fs.chmodSync(pgRestore, 0o755);
  return { pgDump, pgRestore };
}

function withFakePgTools(t, root, scripts) {
  const tools = fakePgTools(root, scripts);
  const previousDump = process.env.PG_DUMP_BIN;
  const previousRestore = process.env.PG_RESTORE_BIN;
  process.env.PG_DUMP_BIN = tools.pgDump;
  process.env.PG_RESTORE_BIN = tools.pgRestore;
  t.after(() => {
    if (previousDump === undefined) delete process.env.PG_DUMP_BIN; else process.env.PG_DUMP_BIN = previousDump;
    if (previousRestore === undefined) delete process.env.PG_RESTORE_BIN; else process.env.PG_RESTORE_BIN = previousRestore;
  });
  return tools;
}

test('PostgreSQL backup uses custom-format dump and validates it with pg_restore', { skip: isWindows }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-postgres-backup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  withFakePgTools(t, root);
  const backupDir = path.join(root, 'backups');
  const backup = await createPostgresBackup(backupDir, testUrl);
  assert.equal(backup.engine, 'postgres');
  assert.match(backup.filename, /^acm-classroom-\d{8}T\d{6}Z-[a-f0-9]{8}\.dump$/);
  assert.equal(fs.statSync(backup.path).size, 1024);
  assert.equal(fs.statSync(backup.path).mode & 0o777, 0o600);
  assert.equal(listDatabaseBackups(backupDir).length, 1);
  assert.equal(resolveDatabaseBackupFile(backupDir, backup.filename), backup.path);
  assert.equal(resolveDatabaseBackupFile(backupDir, backup.filename.replace(/\.dump$/, '.sqlite')), null);
});

test('PostgreSQL external tools run asynchronously without blocking the event loop', { skip: isWindows }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-async-pg-tool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const command = path.join(root, 'slow-tool');
  fs.writeFileSync(command, '#!/usr/bin/env node\nawait new Promise(resolve => setTimeout(resolve, 160));\nprocess.stdout.write("finished\\n");\n', { mode: 0o755 });
  fs.chmodSync(command, 0o755);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const result = await runPostgresTool(command, [], { databaseUrl: testUrl, timeoutMs: 3000 });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /finished/);
    assert.ok(ticks >= 5, `event loop only advanced ${ticks} times`);
  } finally { clearInterval(timer); }
});

test('production backup rejects non-PostgreSQL database handles', async () => {
  await assert.rejects(createDatabaseBackup({ kind: 'sqlite-test' }, './backups'), /فقط از PostgreSQL/);
});

test('PostgreSQL restore takes a safety snapshot and restores only verified custom-format dumps', { skip: isWindows }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-postgres-restore-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  withFakePgTools(t, root);
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const source = path.join(backupDir, 'acm-classroom-20261109T000000Z-deadbeef.dump');
  fs.writeFileSync(source, Buffer.alloc(1024, 9));
  const script = path.resolve('scripts/restore-backup.js');
  const output = execFileSync(process.execPath, [script, '--backup', path.basename(source), '--yes'], {
    env: { ...process.env, DATABASE_URL: testUrl, BACKUP_DIR: backupDir }, encoding: 'utf8', stdio: 'pipe',
  });
  assert.match(output, /PostgreSQL restored/);
  assert.match(output, /Safety snapshot retained/);
  assert.equal(fs.readdirSync(backupDir).filter((name) => name.endsWith('.dump')).length, 2);
});

test('restore rejects SQLite archives even if they are placed in BACKUP_DIR', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-postgres-only-backup-'));
  try {
    const file = path.join(root, 'acm-classroom-20261109T000000Z-deadbeef.sqlite');
    fs.writeFileSync(file, 'legacy');
    assert.equal(resolveDatabaseBackupFile(root, path.basename(file)), null);
    assert.deepEqual(listDatabaseBackups(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('systemd backup timer runs under app account and uses the shared PostgreSQL backup directory', () => {
  const service = fs.readFileSync(path.resolve('deploy/acm-classroom-backup.service'), 'utf8');
  const setup = fs.readFileSync(path.resolve('deploy/setup-ubuntu-vps.sh'), 'utf8');
  assert.match(service, /^User=acmclassroom$/m);
  assert.match(service, /^Group=acmclassroom$/m);
  assert.doesNotMatch(service, /^Environment=BACKUP_DIR=/m, 'the backup script must read BACKUP_DIR from the shared .env file');
  assert.match(fs.readFileSync(path.resolve('.env.example'), 'utf8'), /^BACKUP_DIR=\.\/backups$/m);
  assert.match(fs.readFileSync(path.resolve('deploy/.env.production.example'), 'utf8'), /^BACKUP_DIR=\/var\/backups\/acm-classroom$/m);
  assert.match(setup, /chown -R acmclassroom:acmclassroom \/var\/backups\/acm-classroom/);
  assert.match(setup, /createdb -U \"?\$POSTGRES_USER\"? acm_classroom_test/);
  assert.match(setup, /npm run test:postgres/);
  assert.match(setup, /RUN_POSTGRES_COMPAT_TESTS/);
});
