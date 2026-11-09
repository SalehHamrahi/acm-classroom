export class BoundedWorkerPool {
  constructor({ concurrency = 3, maxQueue = 100 } = {}) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.maxQueue = Math.max(0, Math.floor(maxQueue));
    this.queue = [];
    this.active = 0;
    this.completed = 0;
    this.failed = 0;
    this.rejected = 0;
  }
  stats() {
    return { concurrency: this.concurrency, maxQueue: this.maxQueue, active: this.active, queued: this.queue.length, completed: this.completed, failed: this.failed, rejected: this.rejected };
  }
  run(task, { signal } = {}) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('task must be a function'));
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('Aborted'));
    if (this.active >= this.concurrency && this.queue.length >= this.maxQueue) {
      this.rejected += 1;
      const error = new Error('Judge queue is full'); error.code = 'QUEUE_FULL';
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, signal, abortHandler: null, started: false };
      if (signal) {
        item.abortHandler = () => {
          if (item.started) return;
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason || new Error('Aborted'));
          this.#drain();
        };
        signal.addEventListener('abort', item.abortHandler, { once: true });
      }
      this.queue.push(item);
      this.#drain();
    });
  }
  #drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      if (item.signal?.aborted) { item.reject(item.signal.reason || new Error('Aborted')); continue; }
      item.started = true;
      if (item.abortHandler) item.signal.removeEventListener('abort', item.abortHandler);
      this.active += 1;
      Promise.resolve().then(item.task).then((value) => { this.completed += 1; item.resolve(value); }, (error) => { this.failed += 1; item.reject(error); }).finally(() => {
        this.active -= 1;
        this.#drain();
      });
    }
  }
}
