import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTestCases } from './src/testcase-utils.js';

test('normalizes testcase fields and defaults hidden to false', () => {
  assert.deepEqual(normalizeTestCases([{ input: '2 3\n', output: '5\n' }]), [
    { input: '2 3\n', output: '5\n', hidden: false },
  ]);
});

test('preserves hidden flag and exact whitespace/newlines', () => {
  assert.deepEqual(normalizeTestCases([{ input: ' 10 12\n', output: '22\n\n', hidden: true, ignored: 'value' }]), [
    { input: ' 10 12\n', output: '22\n\n', hidden: true },
  ]);
});

test('rejects malformed JSON shapes, missing strings, and more than 20 tests', () => {
  assert.throws(() => normalizeTestCases({ input: 'x', output: 'y' }), /آرایه/);
  assert.throws(() => normalizeTestCases([null]), /ساختار تست/);
  assert.throws(() => normalizeTestCases([{ input: 5, output: '5' }]), /باید رشته باشند/);
  assert.throws(() => normalizeTestCases(Array.from({ length: 21 }, () => ({ input: '', output: '' }))), /20/);
});
