/**
 * FIFO Request Queue to ensure single-tab serialized access
 * preventing browser overload, race conditions, and Z.ai rate limit triggers.
 */

export class FifoQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.currentTaskId = null;
  }

  enqueue(taskFn, metadata = {}) {
    return new Promise((resolve, reject) => {
      const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const queueItem = {
        id: taskId,
        metadata,
        taskFn,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      };

      this.queue.push(queueItem);
      console.log(`[Queue] Enqueued task ${taskId}. Queue length: ${this.queue.length}`);
      this.processNext();
    });
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const item = this.queue.shift();
    this.currentTaskId = item.id;
    const waitTime = Date.now() - item.enqueuedAt;

    console.log(`[Queue] Starting task ${item.id} (waited ${waitTime}ms in queue)`);

    try {
      const result = await item.taskFn();
      item.resolve(result);
    } catch (err) {
      console.error(`[Queue] Task ${item.id} failed:`, err.message);
      item.reject(err);
    } finally {
      this.currentTaskId = null;
      this.isProcessing = false;
      // Yield slightly to event loop before picking next task
      setImmediate(() => this.processNext());
    }
  }

  getStatus() {
    return {
      isProcessing: this.isProcessing,
      currentTaskId: this.currentTaskId,
      pendingCount: this.queue.length,
      queue: this.queue.map(q => ({ id: q.id, enqueuedAt: q.enqueuedAt, metadata: q.metadata })),
    };
  }
}

export const requestQueue = new FifoQueue();
