import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('PWA manifest declares a Persian standalone application with root scope', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.name.startsWith('ACM Classroom'), true);
  assert.equal(manifest.short_name, 'ACM');
  assert.equal(manifest.lang, 'fa');
  assert.equal(manifest.dir, 'rtl');
  assert.equal(manifest.start_url, '/?source=pwa');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
});

test('PWA icons exist and match their declared PNG dimensions', () => {
  const expected = [
    ['public/icons/icon-192.png', 192],
    ['public/icons/icon-512.png', 512],
    ['public/icons/icon-maskable-512.png', 512],
    ['public/icons/apple-touch-icon.png', 180],
  ];
  for (const [relative, size] of expected) {
    const buffer = fs.readFileSync(path.join(root, relative));
    assert.equal(buffer.toString('hex', 0, 8), '89504e470d0a1a0a', `${relative} must be a PNG`);
    assert.equal(buffer.readUInt32BE(16), size, `${relative} width`);
    assert.equal(buffer.readUInt32BE(20), size, `${relative} height`);
  }
});

test('service worker caches only the public app shell and bypasses private APIs', () => {
  const worker = read('public/sw.js');
  assert.match(worker, /url\.pathname === '\/api' \|\| url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker, /request\.mode === 'navigate'/);
  assert.match(worker, /startsWith\('\/assets\/'\)/);
  assert.match(worker, /startsWith\('\/monaco\/'\)/);
  assert.match(worker, /never cache private API responses/i);
  assert.doesNotMatch(worker, /caches\.open\([^)]*api/i);
});

test('application registers the root-scoped service worker and offers install guidance', () => {
  const app = read('src/main.jsx');
  const html = read('index.html');
  assert.match(app, /serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)/);
  assert.match(app, /beforeinstallprompt/);
  assert.match(app, /Add to Home Screen/);
  assert.match(app, /Install app/);
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-touch-icon/);
});


test('PWA install action is inside the authenticated sidebar menu only', () => {
  const app = read('src/main.jsx');
  const sidebarStart = app.indexOf('<nav className="side-nav">');
  const installEntry = app.indexOf('<PwaInstallButton menu />');
  const sidebarEnd = app.indexOf('</nav>', sidebarStart);
  assert.ok(sidebarStart >= 0 && installEntry > sidebarStart && installEntry < sidebarEnd,
    'install action must be inside the sidebar navigation');
  assert.doesNotMatch(app.slice(app.indexOf('<header className="topbar">'), app.indexOf('</header>', app.indexOf('<header className="topbar">'))),
    /PwaInstallButton/, 'top toolbar must not contain the install action');
  assert.doesNotMatch(app.slice(app.indexOf('<div className="auth-brand"'), app.indexOf('<div className="auth-layout"')),
    /PwaInstallButton/, 'login header must not contain the install action');
});

test('PWA install action disappears after installation instead of showing an installed badge', () => {
  const app = read('src/main.jsx');
  assert.match(app, /if \(installed\) return null;/);
  assert.doesNotMatch(app, /className="pwa-installed"/);
  assert.match(app, /window\.addEventListener\('appinstalled'/);
  assert.match(app, /navigator\.standalone === true/);
  assert.match(app, /display-mode: standalone/);
});


test('startup skips the branded blocking splash and renders no app icon during session restoration', () => {
  const app = read('src/main.jsx');
  assert.match(app, /if \(booting\) return null;/);
  assert.doesNotMatch(app, /if \(booting\) return <div className="loading-screen"/);
  assert.doesNotMatch(app, /loading-screen[^\n]*brand-mark/);
});

test('install identity icons remain in the manifest because platform installation requires an app identity', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
  assert.match(read('index.html'), /apple-touch-icon/);
  assert.equal(manifest.display, 'standalone');
});

test('PWA app identity uses the submitted trophy-and-code logo across browser and installed app icons', () => {
  const html = read('index.html');
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  const app = read('src/main.jsx');
  assert.match(html, /\/icons\/favicon-32\.png/);
  assert.match(html, /\/icons\/apple-touch-icon\.png/);
  assert.ok(manifest.icons.every((icon) => icon.src.startsWith('/icons/')));
  assert.match(app, /<img src="\/icons\/icon-192\.png"/);
});
