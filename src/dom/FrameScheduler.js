/**
 * Coalesces repeated requests into one callback per animation frame.
 */
export class FrameScheduler {
  /**
   * Work to run.
   * @type {function(): void}
   */
  #callback;

  /**
   * Pending animation frame id, or 0 when none is pending.
   * @type {number}
   */
  #pendingFrameId = 0;

  /**
   * Creates a scheduler for a callback.
   * @param {function(): void} callback Work to run at most once per frame.
   */
  constructor(callback) {
    this.#callback = callback;
  }

  /**
   * Runs the callback on the next animation frame unless already scheduled.
   * @returns {void}
   */
  schedule() {
    if (this.#pendingFrameId) return;
    this.#pendingFrameId = requestAnimationFrame(() => {
      this.#pendingFrameId = 0;
      this.#callback();
    });
  }

  /**
   * Cancels a pending run.
   * @returns {void}
   */
  cancel() {
    cancelAnimationFrame(this.#pendingFrameId);
    this.#pendingFrameId = 0;
  }
}
