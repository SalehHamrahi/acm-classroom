import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openSqliteTestDatabase } from './server/sqlite-test-database.js';

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

test('SQLite installs useful query indexes and the student/problem lookup can use its composite index', () => {
  const db = openSqliteTestDatabase({ dbPath: ':memory:' });
  try {
    const indexes = new Set(db.prepare("PRAGMA index_list('submissions')").all().map((item) => item.name));
    assert.ok(indexes.has('idx_submissions_student_problem_ai_created'));
    assert.ok(indexes.has('idx_submissions_student_ai_verdict_problem'));
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM submissions
      WHERE student_id = ? AND problem_id = ? AND ai_flagged = 0`).all('student', 'problem');
    assert.ok(plan.some((item) => String(item.detail).includes('idx_submissions_student_problem_ai_created')),
      JSON.stringify(plan));
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA temp_store').get().temp_store, 2);
  } finally {
    db.close();
  }
});

test('Monaco is lazy-loaded and the service worker cache is aligned with the release', () => {
  const main = read('./src/main.jsx');
  const editor = read('./src/MonacoEditor.jsx');
  const worker = read('./public/sw.js');
  const packageJson = JSON.parse(read('./package.json'));
  assert.match(main, /React\.lazy\(\(\) => import\('\.\/MonacoEditor\.jsx'\)\)/);
  assert.doesNotMatch(main, /from ['"]@monaco-editor\/react['"]/);
  assert.match(main, /React\.Suspense/);
  assert.match(editor, /loader\.config\(\{ paths: \{ vs: '\/monaco\/vs' \} \}\)/);
  assert.match(worker, /CACHE_NAME\s*=\s*`\$\{CACHE_PREFIX\}2\.13\.0`/);
  assert.equal(packageJson.version, '2.13.0');
});


test('course and learning-path modules are absent from the task-and-contest product', () => {
  const app = read('./server/app.js');
  const main = read('./src/main.jsx');
  const schema = read('./server/db.js');
  assert.doesNotMatch(app, /\/api\/learning[-_]paths?/i);
  assert.doesNotMatch(main, /LearningPath|learning-path|مسیر یادگیری/i);
  assert.doesNotMatch(schema, /learning_path|learning_paths/i);
});
