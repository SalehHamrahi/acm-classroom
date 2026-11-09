import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedWorkerPool } from './server/worker-pool.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('bounded worker pool respects concurrency and preserves FIFO order', async () => {
  const pool = new BoundedWorkerPool({ concurrency: 1, maxQueue: 2 });
  const gate = deferred(); const order = [];
  const a = pool.run(async () => { order.push('a'); await gate.promise; return 'A'; });
  const b = pool.run(async () => { order.push('b'); return 'B'; });
  const c = pool.run(async () => { order.push('c'); return 'C'; });
  assert.deepEqual(pool.stats().active, 1); assert.equal(pool.stats().queued, 2);
  gate.resolve();
  assert.deepEqual(await Promise.all([a, b, c]), ['A', 'B', 'C']);
  assert.deepEqual(order, ['a', 'b', 'c']); assert.equal(pool.stats().completed, 3);
});

test('bounded worker pool rejects beyond queue bound and records failed jobs', async () => {
  const pool = new BoundedWorkerPool({ concurrency: 1, maxQueue: 0 });
  const gate = deferred(); const active = pool.run(() => gate.promise);
  await assert.rejects(pool.run(() => 2), (err) => err.code === 'QUEUE_FULL');
  gate.resolve(); await active; await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(pool.run(() => { throw new Error('worker failed'); }), /worker failed/);
  assert.equal(pool.stats().rejected, 1); assert.equal(pool.stats().failed, 1);
});

test('queued work can be cancelled before it starts', async () => {
  const pool = new BoundedWorkerPool({ concurrency: 1, maxQueue: 2 });
  const gate = deferred(); const active = pool.run(() => gate.promise);
  const controller = new AbortController(); let ran = false;
  const queued = pool.run(() => { ran = true; }, { signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(queued, /cancelled/);
  gate.resolve(); await active;
  assert.equal(ran, false); assert.equal(pool.stats().queued, 0);
});
