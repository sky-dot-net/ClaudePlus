/**
 * Runs at most a fixed number of async tasks at once, queuing the rest to start as slots free up.
 */
export class ConcurrencyLimiter {
  /**
   * Tasks allowed to run at once.
   * @type {number}
   */
  #maxConcurrent;

  /**
   * Tasks currently running.
   * @type {number}
   */
  #activeCount = 0;

  /**
   * Callbacks waiting for a free slot, in arrival order.
   * @type {Array<function(): void>}
   */
  #waiters = [];

  /**
   * Creates the limiter.
   * @param {number} maxConcurrent Tasks allowed to run at once.
   */
  constructor(maxConcurrent) {
    this.#maxConcurrent = maxConcurrent;
  }

  /**
   * Runs a task once a slot is free, releasing the slot once it settles either way.
   * @param {function(): Promise<*>} task The task.
   * @returns {Promise<*>} The task's result.
   */
  async run(task) {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  /**
   * Reserves a slot, waiting in line if none are free.
   * @returns {Promise<void>} Resolves once a slot is reserved.
   */
  #acquire() {
    if (this.#activeCount < this.#maxConcurrent) {
      this.#activeCount += 1;
      return Promise.resolve();
    }
    return new Promise(resolve => this.#waiters.push(resolve));
  }

  /**
   * Frees a slot, handing it straight to the next waiter if one is queued.
   * @returns {void}
   */
  #release() {
    const nextWaiter = this.#waiters.shift();
    if (nextWaiter) nextWaiter();
    else this.#activeCount -= 1;
  }
}
