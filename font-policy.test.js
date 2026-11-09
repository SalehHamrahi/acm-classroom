import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('./src/theme.css', import.meta.url), 'utf8');

test('all visible interface elements use Vazirmatn', () => {
  assert.match(css, /html, body, button, input, textarea, select,[\s\S]*font-family: 'Vazirmatn', Tahoma, sans-serif !important;/);
});

test('only code and raw test-data surfaces retain a monospace font', () => {
  for (const selector of [
    '.student-code', '.source-code-view', '.test-json', '.testcase-value-input',
    '.testcase-json-textarea', '.problem-preview-code', '.sample-block pre',
    '.statement-block code', '.testcase-help pre', '.auth-code-art code',
  ]) {
    assert.ok(css.includes(`body ${selector}`), `Missing monospace exception: ${selector}`);
  }
  assert.match(css, /font-family:\s*Consolas,\s*'Cascadia Code',\s*monospace\s*!important;/);
});
