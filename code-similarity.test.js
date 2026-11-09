import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSimilarityFingerprint, compareFingerprints, findSimilarPairs } from './server/code-similarity.js';

test('similarity ignores comments, literal values and variable naming', () => {
  const left = buildSimilarityFingerprint('def add(a, b):\n    # comment\n    total = a + b\n    print(total)\n', 'python');
  const right = buildSimilarityFingerprint('def sum_values(x, y):\n    result = x + y\n    print(result)\n', 'python');
  assert.ok(compareFingerprints(left, right).score >= 70);
});

test('similarity remains language-scoped', () => {
  const py = buildSimilarityFingerprint('print(1 + 2)', 'python');
  const cpp = buildSimilarityFingerprint('int main(){ return 1 + 2; }', 'cpp');
  assert.equal(findSimilarPairs([{ studentId: 'a', problemId: 'p', language: 'python', fingerprint: py }, { studentId: 'b', problemId: 'p', language: 'cpp', fingerprint: cpp }]).length, 0);
});

test('pair scan never compares a student with their own attempts', () => {
  const fp = buildSimilarityFingerprint('print(1 + 2 + 3 + 4)', 'python');
  assert.equal(findSimilarPairs([{ studentId: 'a', problemId: 'p', language: 'python', fingerprint: fp }, { studentId: 'a', problemId: 'p', language: 'python', fingerprint: fp }]).length, 0);
});
