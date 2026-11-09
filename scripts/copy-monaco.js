import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve('node_modules/monaco-editor/min/vs');
const target = resolve('public/monaco/vs');
if (!existsSync(source)) {
  console.error('Monaco assets are missing. Run npm ci before starting or building ACM Classroom.');
  process.exit(1);
}
await mkdir(resolve('public/monaco'), { recursive: true });
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log('Monaco editor assets copied to public/monaco/vs');
