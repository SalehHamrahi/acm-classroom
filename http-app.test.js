import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHttpApp } from './server/http-app.js';

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('HTTP responses include baseline browser security headers', async () => {
  const app = createHttpApp();
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.get('/api/private', (_req, res) => res.json({ ok: true }));
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/ok`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    const privateResponse = await fetch(`${base}/api/private`);
    assert.equal(privateResponse.headers.get('cache-control'), 'no-store');
  });
});

test('malformed percent-encoded paths return 400 instead of throwing out of request handler', async () => {
  const app = createHttpApp();
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/%E0%A4%A`);
    assert.equal(response.status, 400);
  });
});

test('static PWA assets use the correct manifest MIME type and revalidate the service worker', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { staticFiles } = await import('./server/http-app.js');
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'acm-pwa-'));
  await fs.promises.writeFile(path.join(directory, 'manifest.webmanifest'), '{"name":"ACM Classroom"}');
  await fs.promises.writeFile(path.join(directory, 'sw.js'), 'self.addEventListener("install", () => {});');
  await fs.promises.mkdir(path.join(directory, 'assets'));
  await fs.promises.writeFile(path.join(directory, 'assets', 'app-0123456789abcdef.js'), 'export const ready = true;');
  const app = createHttpApp();
  app.use(staticFiles(directory, { maxAge: 3600 }));
  try {
    await withServer(app, async (base) => {
      const manifest = await fetch(`${base}/manifest.webmanifest`);
      assert.match(manifest.headers.get('content-type') || '', /application\/manifest\+json/);
      const worker = await fetch(`${base}/sw.js`);
      assert.match(worker.headers.get('content-type') || '', /javascript/);
      assert.match(worker.headers.get('cache-control') || '', /no-cache/);
      assert.equal(worker.headers.get('service-worker-allowed'), '/');
      const assetUrl = `${base}/assets/app-0123456789abcdef.js`;
      const asset = await fetch(assetUrl);
      assert.match(asset.headers.get('cache-control') || '', /max-age=31536000/);
      assert.match(asset.headers.get('cache-control') || '', /immutable/);
      const etag = asset.headers.get('etag');
      assert.ok(etag);
      const revalidated = await fetch(assetUrl, { headers: { 'If-None-Match': etag } });
      assert.equal(revalidated.status, 304);
    });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
