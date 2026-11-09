import test from 'node:test';
import assert from 'node:assert/strict';
import { toLatinDigits, formatNumber, formatPersianDateTime } from './src/number-format.js';

test('converts Persian and Arabic-Indic digits to English digits', () => {
  assert.equal(toLatinDigits('۱۴۰۵/۰۸/۱۲'), '1405/08/12');
  assert.equal(toLatinDigits('١٢٣٤'), '1234');
  assert.equal(toLatinDigits('09:30'), '09:30');
});

test('formats numbers with English digits', () => {
  assert.equal(formatNumber(123456), '123456');
  assert.equal(formatNumber(0), '0');
});

test('keeps Persian calendar labels while showing English digits in dates', () => {
  const formatted = formatPersianDateTime('2026-10-29T12:00:00.000Z');
  assert.match(formatted, /1405/);
  assert.match(formatted, /[0-9]/);
  assert.doesNotMatch(formatted, /[۰-۹٠-٩]/);
});
