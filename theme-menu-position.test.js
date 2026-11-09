import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateThemeMenuPosition } from './src/theme-menu-position.js';

test('mobile theme menu is kept inside the viewport and aligned to the trigger', () => {
  const position = calculateThemeMenuPosition({ left: 280, right: 326, top: 28, bottom: 70 }, { width: 632, height: 405 }, 260);
  assert.equal(position.position, 'fixed');
  assert.equal(position.left, 126);
  assert.equal(position.width, 200);
  assert.equal(position.top, 79);
  assert.ok(position.left + position.width <= 632 - 12);
  assert.ok(position.top + 260 <= 405 - 12);
});

test('small phone widths keep the menu within horizontal safe margins', () => {
  const position = calculateThemeMenuPosition({ left: 250, right: 292, top: 20, bottom: 62 }, { width: 320, height: 640 }, 250);
  assert.equal(position.left, 92);
  assert.equal(position.width, 200);
  assert.ok(position.left + position.width <= 308);
});

test('theme menu flips above a low trigger when there is not enough space below', () => {
  const position = calculateThemeMenuPosition({ left: 210, right: 252, top: 550, bottom: 592 }, { width: 390, height: 640 }, 270);
  assert.equal(position.width, 200);
  assert.equal(position.top, 271);
  assert.ok(position.top + 270 <= 628);
});

test('short viewports constrain menu height and keep it within safe margins', () => {
  const position = calculateThemeMenuPosition({ left: 100, right: 142, top: 20, bottom: 62 }, { width: 360, height: 150 }, 400);
  assert.equal(position.maxHeight, 126);
  assert.equal(position.top, 12);
});


test('theme menu stays at 200px except when the viewport itself is narrower', () => {
  const position = calculateThemeMenuPosition({ left: 80, right: 122, top: 16, bottom: 58 }, { width: 180, height: 500 }, 240);
  assert.equal(position.width, 156);
  assert.equal(position.left, 12);
  assert.ok(position.left + position.width <= 168);
});
