import { localDateKey } from './localDateKey.js';

/**
 * An inclusive range of calendar days in local time; either end may be open.
 */
export class DateRange {
  /**
   * First day, as YYYY-MM-DD, or an empty string for no lower bound.
   * @type {string}
   */
  #firstDay;

  /**
   * Last day, as YYYY-MM-DD, or an empty string for no upper bound.
   * @type {string}
   */
  #lastDay;

  /**
   * Creates the range.
   * @param {?string} firstDay First day as YYYY-MM-DD; empty or missing for no lower bound.
   * @param {?string} lastDay Last day as YYYY-MM-DD; empty or missing for no upper bound.
   */
  constructor(firstDay, lastDay) {
    this.#firstDay = firstDay || '';
    this.#lastDay = lastDay || '';
  }

  /**
   * Whether a timestamp falls on a day inside the range. With both ends open everything matches;
   * otherwise missing or invalid timestamps never match.
   * @param {?string} isoDate ISO timestamp.
   * @returns {boolean} True when inside the range.
   */
  contains(isoDate) {
    if (!this.#firstDay && !this.#lastDay) return true;
    const day = localDateKey(isoDate);
    return day !== '' && this.#isNotBeforeFirstDay(day) && this.#isNotAfterLastDay(day);
  }

  /**
   * Whether a day is on or after the first day.
   * @param {string} day Day as YYYY-MM-DD.
   * @returns {boolean} True when there is no lower bound or the day isn't before it.
   */
  #isNotBeforeFirstDay(day) {
    return !this.#firstDay || day >= this.#firstDay;
  }

  /**
   * Whether a day is on or before the last day.
   * @param {string} day Day as YYYY-MM-DD.
   * @returns {boolean} True when there is no upper bound or the day isn't after it.
   */
  #isNotAfterLastDay(day) {
    return !this.#lastDay || day <= this.#lastDay;
  }
}
