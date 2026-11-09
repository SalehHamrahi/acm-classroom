import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleVisibleInterval } from './polling.js';

function createHost(initialVisibility = 'visible') {
  let intervalCallback = null;
  let intervalId = 0;
  const listeners = new Map();
  const host = {
    setInterval(callback) { intervalCallback = callback; intervalId += 1; return intervalId; },
    clearInterval(id) { if (id === intervalId) intervalCallback = null; },
    document: {
      visibilityState: initialVisibility,
      addEventListener(name, callback) { listeners.set(name, callback); },
      removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
    },
    tick() { intervalCallback?.(); },
    changeVisibility(value) { host.document.visibilityState = value; listeners.get('visibilitychange')?.(); },
    get hasTimer() { return Boolean(intervalCallback); },
    get hasVisibilityListener() { return listeners.has('visibilitychange'); },
  };
  return host;
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('visible polling skips hidden tabs and refreshes immediately when visible again', async () => {
  const host = createHost('hidden');
  let calls = 0;
  const stop = scheduleVisibleInterval(() => { calls += 1; }, 5000, host);
  host.tick();
  await flush();
  assert.equal(calls, 0);
  host.changeVisibility('visible');
  await flush();
  assert.equal(calls, 1);
  host.tick();
  await flush();
  assert.equal(calls, 2);
  stop();
  assert.equal(host.hasTimer, false);
  assert.equal(host.hasVisibilityListener, false);
});

test('visible polling never overlaps an asynchronous refresh', async () => {
  const host = createHost();
  let release;
  let calls = 0;
  const stop = scheduleVisibleInterval(() => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  }, 5000, host);
  host.tick();
  await flush();
  host.tick();
  host.changeVisibility('hidden');
  host.changeVisibility('visible');
  await flush();
  assert.equal(calls, 1);
  release();
  await flush();
  host.tick();
  await flush();
  assert.equal(calls, 2);
  release();
  stop();
});

test('visible polling rejects invalid callbacks and clamps too-frequent timers', () => {
  assert.throws(() => scheduleVisibleInterval(null, 1000), /callback must be a function/);
  const host = createHost();
  const originalSetInterval = host.setInterval;
  let seenInterval = 0;
  host.setInterval = (callback, interval) => { seenInterval = interval; return originalSetInterval(callback, interval); };
  const stop = scheduleVisibleInterval(() => {}, 10, host);
  assert.equal(seenInterval, 250);
  stop();
});
