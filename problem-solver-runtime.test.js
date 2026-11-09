import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('./src/main.jsx', import.meta.url), 'utf8');
const glass = await readFile(new URL('./src/glass.css', import.meta.url), 'utf8');

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `missing start marker: ${startText}`);
  assert.notEqual(end, -1, `missing end marker: ${endText}`);
  return source.slice(start, end);
}

test('student problem solver owns all state used by public-output modal', () => {
  const component = sliceBetween(main, 'function StudentProblem(', '\nfunction TeacherAssignments(');
  assert.match(component, /const \[viewingTestOutputs,setViewingTestOutputs\]\s*=\s*useState\(null\)/);
  assert.match(component, /const \[testOutputsBusy,setTestOutputsBusy\]\s*=\s*useState\(false\)/);
  assert.match(main, /function PublicTestOutputsModal/);
  assert.match(component, /viewingTestOutputs&&<PublicTestOutputsModal/);
  assert.match(component, /testOutputsBusy\?/);
});

test('student problem payload is validated before rendering problem fields', () => {
  const component = sliceBetween(main, 'function StudentProblem(', '\nfunction TeacherAssignments(');
  assert.match(component, /if \(!r\?\.problem \|\| typeof r\.problem !== 'object'\) throw new Error/);
  assert.match(component, /if \(!p \|\| typeof p !== 'object'\) return <EmptyState/);
});

test('a render error on a page no longer unmounts the complete application shell', () => {
  assert.match(main, /class PageErrorBoundary extends React\.Component/);
  assert.match(main, /componentDidCatch\(error, info\)/);
  assert.match(main, /<PageErrorBoundary[\s\S]*?\{renderCurrent\(\)\}<\/PageErrorBoundary>/);
  assert.match(main, /بازگشت به پیشخوان/);
});

test('admin account modal uses its own responsive action bar instead of the generic modal footer', () => {
  assert.match(main, /form className="form-grid admin-user-create-form"/);
  assert.match(main, /className="admin-user-create-actions"/);
  const createFormStart = main.indexOf('form className="form-grid admin-user-create-form"');
  const createFormEnd = main.indexOf('</form></Modal>', createFormStart);
  const createForm = main.slice(createFormStart, createFormEnd);
  assert.ok(createFormEnd > createFormStart);
  assert.doesNotMatch(createForm, /modal-footer form-full/);
  assert.match(glass, /\.admin-user-create-actions\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;[\s\S]*?border-top/);
  assert.match(glass, /@media \(max-width: 760px\)[\s\S]*?\.admin-user-create-form\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});
