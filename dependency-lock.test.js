import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readJson = (file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));

test('Browserslist lock avoids the unpublished baseline-browser-mapping range', () => {
  const pkg = readJson('./package.json');
  const lock = readJson('./package-lock.json');
  const root = lock.packages[''];
  const browserslist = lock.packages['node_modules/browserslist'];
  const baseline = lock.packages['node_modules/baseline-browser-mapping'];

  assert.equal(pkg.version, '2.13.0');
  assert.equal(pkg.devDependencies.browserslist, '4.29.3');
  assert.equal(root.devDependencies.browserslist, '4.29.3');
  assert.equal(browserslist.version, '4.29.3');
  assert.equal(browserslist.resolved, 'https://registry.npmjs.org/browserslist/-/browserslist-4.29.3.tgz');
  assert.equal(browserslist.dependencies['baseline-browser-mapping'], '^2.11.26');
  assert.equal(baseline.version, '2.11.30');
  assert.ok(browserslist.dependencies['baseline-browser-mapping'].startsWith('^2.11.'));
  assert.notEqual(browserslist.dependencies['baseline-browser-mapping'], '^2.11.39');

  const pg = lock.packages['node_modules/pg'];
  assert.equal(pkg.dependencies.pg, '^8.23.1');
  assert.equal(pg.version, '8.23.1');
  for (const name of ['pg-cloudflare', 'pg-connection-string', 'pg-int8', 'pg-pool', 'pg-protocol', 'pg-types', 'pgpass', 'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'split2']) {
    assert.ok(lock.packages[`node_modules/${name}`], `missing locked PostgreSQL dependency: ${name}`);
  }
});

test('PostgreSQL interval parser runtime dependency is fully represented in the npm lockfile', () => {
  const lock = readJson('./package-lock.json');
  const interval = lock.packages['node_modules/postgres-interval'];
  const xtend = lock.packages['node_modules/xtend'];

  assert.equal(interval.dependencies.xtend, '^4.0.0');
  assert.equal(xtend.version, '4.0.2');
  assert.equal(xtend.resolved, 'https://registry.npmjs.org/xtend/-/xtend-4.0.2.tgz');
  assert.equal(
    xtend.integrity,
    'sha512-LKYU1iAXJXUgAXn9URjiu+MWhyUXHsvfp7mcuYm9dSUKK0/CjtrUwFAxD82/mCWbtLsGjFIad0wIsod4zrTAEQ=='
  );
});

