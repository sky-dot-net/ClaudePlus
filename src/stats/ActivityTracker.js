import { DATABASE } from '../config/DATABASE.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { LOG_PREFIX } from '../config/LOG_PREFIX.js';
import { TIMING } from '../config/TIMING.js';

/**
 * Counts time the tab is visible and receiving input, per day. Time is added to the stored day
 * total rather than overwriting it, so several open tabs accumulate.
 * @fires ActivityTracker#activity After every sample.
 */
export class ActivityTracker extends EventEmitter {
  /**
   * Events that count as user input.
   * @type {string[]}
   */
  static #INPUT_EVENTS = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'];

  /**
   * Activity storage.
   * @type {IndexedDbStore}
   */
  #database;

  /**
   * Day being counted, as YYYY-MM-DD in UTC.
   * @type {string}
   */
  #countedDay = ActivityTracker.#today();

  /**
   * Epoch milliseconds of the last input.
   * @type {number}
   */
  #lastInputTime = Date.now();

  /**
   * Active milliseconds not yet written to storage.
   * @type {number}
   */
  #unsavedMs = 0;

  /**
   * Creates the tracker.
   * @param {IndexedDbStore} database Activity storage.
   */
  constructor(database) {
    super();
    this.#database = database;
    this.activeTodayMs = 0;
    this.activeAllTimeMs = 0;
    this.isIdle = false;
  }

  /**
   * The current day key.
   * @returns {string} Today as YYYY-MM-DD in UTC.
   */
  static #today() {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Loads stored totals and starts sampling and periodic saving. Also saves when the tab is hidden
   * or closed.
   * @returns {Promise<void>} Resolves once started.
   */
  async start() {
    await this.#loadTotals();
    for (const eventType of ActivityTracker.#INPUT_EVENTS) document.addEventListener(eventType, this.#recordInput, { passive: true });
    document.addEventListener('visibilitychange', this.#saveWhenHidden);
    window.addEventListener('pagehide', () => this.#saveUnsavedTime());
    setInterval(() => this.#sampleActivity(), TIMING.activitySampleMs);
    setInterval(() => this.#saveUnsavedTime(), TIMING.activitySaveMs);
    this.publish('activity');
  }

  /**
   * Records the time of user input.
   * @returns {void}
   */
  #recordInput = () => {
    this.#lastInputTime = Date.now();
  };

  /**
   * Saves unsaved time when the tab becomes hidden.
   * @returns {void}
   */
  #saveWhenHidden = () => {
    if (document.visibilityState === 'hidden') this.#saveUnsavedTime();
  };

  /**
   * Reads today's and the all-time totals, ignoring malformed records. Failures are logged and leave both at zero.
   * @returns {Promise<void>} Resolves once loaded or failed.
   */
  async #loadTotals() {
    try {
      const records = (await this.#database.readAll(DATABASE.stores.activity)).filter(record => Boolean(record) && Number.isFinite(record.activeMs));
      const todayRecord = records.find(record => record.day === this.#countedDay);
      this.activeTodayMs = todayRecord ? todayRecord.activeMs : 0;
      this.activeAllTimeMs = records.reduce((sum, record) => sum + record.activeMs, 0);
    } catch (error) {
      console.warn(LOG_PREFIX, 'reading activity failed', error);
    }
  }

  /**
   * Takes one sample: rolls over at midnight, then counts the interval if the user is active.
   * @returns {void}
   */
  #sampleActivity() {
    if (ActivityTracker.#today() !== this.#countedDay) this.#startNewDay();
    this.isIdle = !this.#isUserActive();
    if (!this.isIdle) this.#addActiveTime(TIMING.activitySampleMs);
    this.publish('activity');
  }

  /**
   * Saves the finished day and starts counting a new one.
   * @returns {void}
   */
  #startNewDay() {
    this.#saveUnsavedTime();
    this.#countedDay = ActivityTracker.#today();
    this.activeTodayMs = 0;
  }

  /**
   * Whether the tab is visible and had input within the idle timeout.
   * @returns {boolean} True when the user counts as active.
   */
  #isUserActive() {
    return document.visibilityState === 'visible' && Date.now() - this.#lastInputTime <= TIMING.idleAfterMs;
  }

  /**
   * Adds active time to the totals and to the unsaved amount.
   * @param {number} durationMs Time to add.
   * @returns {void}
   */
  #addActiveTime(durationMs) {
    this.activeTodayMs += durationMs;
    this.activeAllTimeMs += durationMs;
    this.#unsavedMs += durationMs;
  }

  /**
   * Adds unsaved time to the stored day total. On failure the time is kept for the next attempt
   * unless the day has changed.
   * @returns {Promise<void>} Resolves once saved or failed.
   */
  async #saveUnsavedTime() {
    if (this.#unsavedMs === 0) return;
    const day = this.#countedDay;
    const durationMs = this.#unsavedMs;
    this.#unsavedMs = 0;
    try {
      await this.#database.update(DATABASE.stores.activity, day, record => ({ day, activeMs: (record ? record.activeMs : 0) + durationMs }));
    } catch (error) {
      this.#keepUnsavedTime(day, durationMs);
      console.warn(LOG_PREFIX, 'saving activity failed', error);
    }
  }

  /**
   * Puts back time that failed to save, if it belongs to the day still being counted.
   * @param {string} day Day the time belongs to.
   * @param {number} durationMs Time that failed to save.
   * @returns {void}
   */
  #keepUnsavedTime(day, durationMs) {
    if (day === this.#countedDay) this.#unsavedMs += durationMs;
  }
}
