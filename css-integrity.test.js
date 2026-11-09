import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cssFiles = ['src/style.css', 'src/theme.css', 'src/glass.css'];

function validateCssStructure(source, file) {
  const stack = [];
  let quote = null;
  let comment = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (comment) {
      if (char === '*' && next === '/') {
        comment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '*') {
      comment = true;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{' || char === '(' || char === '[') {
      stack.push({ char, index: i });
      continue;
    }
    if (char === '}' || char === ')' || char === ']') {
      const expected = char === '}' ? '{' : char === ')' ? '(' : '[';
      const opening = stack.pop();
      assert.equal(opening?.char, expected, `${file}: unexpected ${char} at offset ${i}`);
    }
  }

  assert.equal(comment, false, `${file}: unterminated CSS comment`);
  assert.equal(quote, null, `${file}: unterminated CSS string`);
  assert.equal(stack.length, 0, `${file}: unclosed CSS block or delimiter`);
  assert.doesNotMatch(source.trimEnd(), /,$/, `${file}: CSS ends with an incomplete selector list`);
}

test('all application stylesheets are structurally complete at EOF', async () => {
  for (const file of cssFiles) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    validateCssStructure(source, file);
  }
});


test('login screen has desktop two-column layout, bounded brand mark and themed submit control', async () => {
  const source = await readFile(new URL('./src/glass.css', import.meta.url), 'utf8');
  assert.match(source, /\.glass-ui-page \.auth-layout\s*\{[^}]*display:\s*grid/s);
  assert.match(source, /grid-template-columns:\s*minmax\(0,\s*1\.12fr\)\s+minmax\(360px,\s*\.88fr\)/);
  assert.match(source, /\.glass-ui-page \.auth-brand \.brand-mark\s*\{[^}]*width:\s*64px/s);
  assert.match(source, /\.glass-ui-page \.auth-page \.login-form \.btn-primary\s*\{[^}]*background:\s*linear-gradient/s);
  assert.match(source, /@media \(max-width:\s*760px\)[\s\S]*?\.glass-ui-page \.auth-page \.auth-intro \{\s*display:\s*none/s);
});


test('authenticated application restores its desktop shell and constrains the sidebar logo', async () => {
  const base = await readFile(new URL('./src/style.css', import.meta.url), 'utf8');
  const glass = await readFile(new URL('./src/glass.css', import.meta.url), 'utf8');
  assert.match(base, /\.app-shell\s*\{[^}]*display:\s*flex/s);
  assert.match(base, /\.sidebar\s*\{[^}]*width:\s*264px;[^}]*display:\s*flex;[^}]*flex-direction:\s*column/s);
  assert.match(base, /\.main-column\s*\{[^}]*flex:\s*1;[^}]*display:\s*flex;[^}]*flex-direction:\s*column/s);
  assert.match(base, /\.brand-mark\s*\{[^}]*width:\s*43px;[^}]*height:\s*43px/s);
  assert.match(glass, /\.brand-mark img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*cover/s);
});
