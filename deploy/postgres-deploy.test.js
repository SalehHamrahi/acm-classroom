import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (name) => fs.readFileSync(path.resolve(name), 'utf8');

test('production PostgreSQL is persistent, private to loopback and health-checked', () => {
  const compose = read('compose.yaml');
  assert.match(compose, /image:\s*postgres:16-alpine/);
  assert.match(compose, /127\.0\.0\.1:5432:5432/);
  assert.match(compose, /acm-classroom-postgres-data:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /pg_isready/);
  assert.match(compose, /restart:\s*unless-stopped/);
});

test('production installer provisions a strong PostgreSQL password, starts the database and checks it before service use', () => {
  const setup = read('deploy/setup-ubuntu-vps.sh');
  assert.match(setup, /postgresql-client-16/);
  assert.match(setup, /openssl rand -hex 32/);
  assert.match(setup, /POSTGRES_PASSWORD must be 64 hexadecimal characters/);
  assert.match(setup, /DATABASE_DRIVER postgres/);
  assert.match(setup, /docker compose up -d postgres/);
  assert.match(setup, /npm run db:check/);
  assert.match(setup, /SQLite files are deliberately left untouched/);
  assert.doesNotMatch(setup, /docker compose down\s+-v/, 'installer must never delete a persistent database volume');
});

test('systemd validates PostgreSQL before app start and allows verified backups to be downloaded', () => {
  const app = read('deploy/acm-classroom.service');
  const backup = read('deploy/acm-classroom-backup.service');
  assert.match(app, /^ExecStartPre=\/usr\/bin\/node \/opt\/acm-classroom\/scripts\/check-db\.js$/m);
  assert.match(app, /^ReadWritePaths=.*\/var\/backups\/acm-classroom/m);
  assert.match(backup, /^User=acmclassroom$/m);
  assert.match(backup, /^EnvironmentFile=\/opt\/acm-classroom\/\.env$/m);
});

test('fresh-install environment examples select PostgreSQL and keep backup configuration', () => {
  for (const file of ['.env.example', 'deploy/.env.production.example']) {
    const env = read(file);
    assert.match(env, /^DATABASE_DRIVER=postgres$/m);
    assert.match(env, /^DATABASE_URL=postgresql:\/\//m);
    assert.match(env, /^POSTGRES_PASSWORD=/m);
    assert.match(env, /^BACKUP_DIR=/m);
  }
});

test('database check command opens the configured engine and reports version without credentials', () => {
  const script = read('scripts/check-db.js');
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['db:check'], 'node scripts/check-db.js');
  assert.match(script, /openDatabase\(\)/);
  assert.match(script, /Database reachable/);
  assert.doesNotMatch(script, /PGPASSWORD|DATABASE_URL.*console/);
});

test('installer bash syntax is valid', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync('bash', ['-n', path.resolve('deploy/setup-ubuntu-vps.sh')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'bash -n failed');
});
