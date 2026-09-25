import { EventEmitter } from '../core/EventEmitter.js';
import { TIMING } from '../config/TIMING.js';

/**
 * Latest known usage windows, from polling and from message_limit stream events.
 * @fires RateLimitMonitor#rateLimits The limits changed.
 */
export class RateLimitMonitor extends EventEmitter {
  /**
   * API client.
   * @type {ClaudeApi}
   */
  #api;

  /**
   * Creates the monitor.
   * @param {ClaudeApi} api API client.
   */
  constructor(api) {
    super();
    this.#api = api;
    this.limits = null;
  }

  /**
   * Polls now and then every TIMING.rateLimitPollMs.
   * @returns {void}
   */
  start() {
    this.#fetchLimits();
    setInterval(() => this.#fetchLimits(), TIMING.rateLimitPollMs);
  }

  /**
   * Replaces the known limits.
   * @param {RateLimits} limits New limits.
   * @returns {void}
   */
  setLimits(limits) {
    this.limits = limits;
    this.publish('rateLimits');
  }

  /**
   * Fetches the limits; on failure the last known values stay and the next poll retries.
   * @returns {Promise<void>} Resolves once fetched or failed.
   */
  async #fetchLimits() {
    try {
      this.setLimits(await this.#api.getUsage());
    } catch {
      return;
    }
  }
}
