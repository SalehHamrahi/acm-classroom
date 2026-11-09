import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

export function resolveClientIp(remoteAddress, forwardedFor = '') {
  const remote = String(remoteAddress || 'unknown');
  const normalizedRemote = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  const isLoopbackProxy = normalizedRemote === '127.0.0.1' || normalizedRemote === '::1';
  if (!isLoopbackProxy) return remote;
  const forwarded = String(forwardedFor || '').split(',')[0].trim();
  return isIP(forwarded) ? forwarded : remote;
}

function decorateResponse(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (value) => {
    if (res.writableEnded) return res;
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
    return res;
  };
  res.send = (value) => {
    if (res.writableEnded) return res;
    if (Buffer.isBuffer(value)) res.end(value);
    else if (typeof value === 'object' && value !== null) return res.json(value);
    else {
      if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(String(value ?? ''));
    }
    return res;
  };
  res.cookie = (name, value, options = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`];
    if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge / 1000))}`);
    if (options.httpOnly) parts.push('HttpOnly');
    if (options.secure) parts.push('Secure');
    if (options.sameSite) parts.push(`SameSite=${String(options.sameSite).replace(/^./, (c) => c.toUpperCase())}`);
    res.setHeader('Set-Cookie', parts.join('; '));
    return res;
  };
  res.clearCookie = (name, options = {}) => {
    const parts = [`${name}=`, `Path=${options.path || '/'}`, 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
    if (options.httpOnly) parts.push('HttpOnly');
    if (options.secure) parts.push('Secure');
    if (options.sameSite) parts.push(`SameSite=${String(options.sameSite).replace(/^./, (c) => c.toUpperCase())}`);
    res.setHeader('Set-Cookie', parts.join('; '));
    return res;
  };
  res.sendFile = (file) => {
    if (res.writableEnded) return res;
    const ext = path.extname(file).toLowerCase();
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    if (path.basename(file).toLowerCase() === 'index.html' && !res.hasHeader('Cache-Control')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => { if (!res.writableEnded) { res.statusCode = 404; res.end('Not found'); } });
    stream.pipe(res);
    return res;
  };
}

function compileRoute(route) {
  if (route === '/{*splat}' || route === '*splat') return { regex: /^\/(.*)$/, names: ['splat'] };
  if (route === '*') return { regex: /^\/(.*)$/, names: ['splat'] };
  const names = [];
  const pieces = route.split('/').map((piece) => {
    if (piece.startsWith(':')) { names.push(piece.slice(1)); return '([^/]+)'; }
    return piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { regex: new RegExp(`^${pieces.join('/')}/?$`), names };
}
function matchLayer(layer, req) {
  if (layer.kind === 'middleware') {
    if (!layer.prefix) return true;
    return req.path === layer.prefix || req.path.startsWith(`${layer.prefix.replace(/\/$/, '')}/`);
  }
  if (req.method !== layer.method && !(req.method === 'HEAD' && layer.method === 'GET')) return false;
  const match = layer.compiled.regex.exec(req.path);
  if (!match) return false;
  const params = {};
  layer.compiled.names.forEach((name, index) => {
    try { params[name] = decodeURIComponent(match[index + 1]); } catch { params[name] = match[index + 1]; }
  });
  req.params = params;
  return true;
}
async function runHandlers(handlers, req, res) {
  for (const handler of handlers) {
    if (res.writableEnded) return 'stop';
    let nextCalled = false;
    let resolveNext;
    let rejectNext;
    const nextPromise = new Promise((resolve, reject) => { resolveNext = resolve; rejectNext = reject; });
    // Mark the promise as handled immediately; it is only awaited if next() is called.
    nextPromise.catch(() => {});
    const next = (error) => {
      nextCalled = true;
      if (error) rejectNext(error); else resolveNext('next');
      return nextPromise;
    };
    let result;
    try { result = handler(req, res, next); }
    catch (error) { throw error; }
    if (result && typeof result.then === 'function') {
      const outcome = await Promise.race([result.then(() => 'done'), nextPromise]);
      if (outcome === 'next') continue;
      return 'stop';
    }
    if (nextCalled) { await nextPromise; continue; }
    return 'stop';
  }
  return 'next';
}

export function createHttpApp() {
  const layers = [];
  const app = (req, res) => {
    decorateResponse(res);
    // Baseline browser protections; avoid a restrictive CSP here because Monaco and
    // the generated Vite bundle have their own asset-loading requirements.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    let parsed;
    try { parsed = new URL(req.url, 'http://localhost'); }
    catch { res.statusCode = 400; res.end('Bad Request'); return; }
    try { req.path = decodeURIComponent(parsed.pathname); }
    catch { res.statusCode = 400; res.end('Bad Request'); return; }
    // API responses contain account-specific and educational records; never let
    // browser or intermediary caches retain them across logins or permissions.
    if (req.path === '/api' || req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    req.query = Object.fromEntries(parsed.searchParams.entries());
    req.params = {};
    req.ip = resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);
    req.get = (name) => req.headers[String(name).toLowerCase()];
    req.header = req.get;

    const dispatch = async (startAt = 0) => {
      if (res.writableEnded) return;
      for (let index = startAt; index < layers.length; index += 1) {
        const layer = layers[index];
        if (!matchLayer(layer, req)) continue;
        try {
          const outcome = await runHandlers(layer.handlers, req, res);
          if (res.writableEnded) return;
          if (outcome === 'next') return dispatch(index + 1);
          return;
        } catch (error) {
          console.error('[http app error]', error?.stack || error);
          if (!res.writableEnded) {
            res.statusCode = Number(error?.status) >= 400 ? Number(error.status) : 500;
            if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: res.statusCode >= 500 ? 'خطای داخلی سرور رخ داد.' : (error.message || 'درخواست نامعتبر است.') }));
          }
          return;
        }
      }
      if (!res.writableEnded) { res.statusCode = 404; res.end('Not found'); }
    };

    const parseBody = async () => {
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) { req.body = {}; return; }
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('application/json')) { req.body = {}; return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { const err = new Error('بدنهٔ درخواست بیش از 2 مگابایت است.'); err.status = 413; throw err; }
        chunks.push(chunk);
      }
      if (!size) { req.body = {}; return; }
      try { req.body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { const err = new Error('قالب JSON درخواست معتبر نیست.'); err.status = 400; throw err; }
    };
    parseBody().then(() => dispatch(0)).catch((error) => {
      if (res.writableEnded) return;
      res.statusCode = Number(error?.status) >= 400 ? Number(error.status) : 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: error.message || 'درخواست نامعتبر است.' }));
    });
  };
  app.disable = () => app;
  app.use = (pathOrHandler, ...handlers) => {
    const prefix = typeof pathOrHandler === 'string' ? pathOrHandler : '';
    const fns = typeof pathOrHandler === 'function' ? [pathOrHandler, ...handlers] : handlers;
    layers.push({ kind: 'middleware', prefix, handlers: fns });
    return app;
  };
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    app[method.toLowerCase()] = (route, ...handlers) => {
      layers.push({ kind: 'route', method, route, compiled: compileRoute(route), handlers });
      return app;
    };
  }
  return app;
}

export function staticFiles(rootDirectory, { maxAge = 0, index = false } = {}) {
  const root = path.resolve(rootDirectory);
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let requested = req.path;
    try { requested = decodeURIComponent(requested); } catch { return next(); }
    if (requested.includes('\0') || requested.split('/').some((part) => part === '..')) return next();
    if (requested === '/' && index) requested = '/index.html';
    const target = path.resolve(root, `.${requested}`);
    if (!target.startsWith(root + path.sep) && target !== root) return next();
    let stats;
    try { stats = await fs.promises.stat(target); } catch { return next(); }
    if (!stats.isFile()) return next();
    const ext = path.extname(target).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', String(stats.size));
    const modifiedAt = new Date(stats.mtimeMs);
    const etag = `W/\"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}\"`;
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', modifiedAt.toUTCString());
    if (requested === '/sw.js') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
    } else if (requested === '/manifest.webmanifest') {
      res.setHeader('Cache-Control', 'public, max-age=300');
    } else if (requested.startsWith('/assets/') && /(?:^|[-.])[a-z0-9_-]{8,}\.[^.]+$/i.test(path.basename(requested))) {
      // Vite's fingerprinted assets never change at the same URL.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', maxAge === 0 ? 'no-store' : `public, max-age=${typeof maxAge === 'number' ? maxAge : 3600}`);
    }
    const ifNoneMatch = req.headers['if-none-match'];
    const ifModifiedSince = req.headers['if-modified-since'];
    const notModified = ifNoneMatch ? (ifNoneMatch === '*' || ifNoneMatch.split(',').map((value) => value.trim()).includes(etag))
      : Boolean(ifModifiedSince && modifiedAt.getTime() <= Date.parse(ifModifiedSince) + 999);
    if (notModified) {
      res.statusCode = 304;
      res.removeHeader('Content-Length');
      res.end();
      return;
    }
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(target).pipe(res);
  };
}
