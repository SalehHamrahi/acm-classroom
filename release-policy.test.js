import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (file) => readFile(resolve(root, file), 'utf8');

test('Docker is the sole submission runner selected by the server', async () => {
  const source = await read('server/index.js');
  assert.match(source, /runSubmission as runDockerSubmission/);
  assert.match(source, /const runJudge = runDockerSubmission/);
  assert.doesNotMatch(source, /create[A-Za-z]+Runner|backend.*(?:choose|select|switch)/i);
});

test('sample environment contains local Docker images and no backend selector', async () => {
  const source = await read('.env.example');
  assert.match(source, /DOCKER_IMAGE=python:3\.13-alpine/);
  assert.match(source, /DOCKER_CPP_IMAGE=acm-cpp-runner:17/);
  const retiredBackendKey = ['JUDGE', '_BACKEND'].join('');
  assert.equal(source.includes(retiredBackendKey), false);
});

test('glass design system is imported after the existing theme styles', async () => {
  const source = await read('src/main.jsx');
  assert.ok(source.indexOf("import './theme.css';") < source.indexOf("import './glass.css';"));
  assert.match(source, /glass-interface/);
  const css = await read('src/glass.css');
  assert.match(css, /\.glass-interface \.sidebar/);
  assert.match(css, /backdrop-filter:\s*blur/);
  assert.doesNotMatch(css, /theme-gotham|theme-gotham-page|dark glass mode/i);
  assert.match(css, /auth-page \.login-card[\s\S]*backdrop-filter/);
});

test('Monaco editor remains crisp and code input retains monospace', async () => {
  const css = await read('src/glass.css');
  assert.match(css, /\.monaco-student-editor[\s\S]*?backdrop-filter:none/);
  const source = await read('src/main.jsx');
  assert.match(source, /fontFamily:'Consolas/);
});
