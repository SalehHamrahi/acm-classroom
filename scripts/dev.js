import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { loadEnv } from '../server/env.js';

loadEnv();
process.env.NODE_ENV = 'development';
const api = spawn(process.execPath, ['server/index.js'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' }, windowsHide: true });
let vite;
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  api.kill();
  if (vite) await vite.close().catch(() => {});
  process.exitCode = code;
}
api.on('exit', (code) => { if (!shuttingDown) shutdown(code || 0); });
try {
  vite = await createServer({ server: { host: '127.0.0.1', port: 5173 }, appType: 'spa' });
  await vite.listen();
  const info = vite.httpServer.address();
  console.log(`Vite frontend available at http://127.0.0.1:${info.port}`);
} catch (error) {
  console.error(error);
  await shutdown(1);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
