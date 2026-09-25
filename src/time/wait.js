/**
 * Waits for a given time.
 * @param {number} durationMs Milliseconds to wait.
 * @returns {Promise<void>} Resolves after the delay.
 */
export function wait(durationMs) {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}
