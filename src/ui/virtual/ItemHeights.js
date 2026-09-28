/**
 * The heights of a long list's items: measured for the ones that have been rendered, estimated
 * (from the average of what has been measured) for the rest. Gives the offsets and spacer sizes a
 * windowed list needs without ever rendering the items in between.
 */
export class ItemHeights {
  /**
   * Fraction of the measured heights dropped from each end before averaging.
   * @type {number}
   */
  static #TRIM_FRACTION = 0.1;

  /**
   * How much the number of measurements must grow, as a factor, before the estimate is recomputed.
   * @type {number}
   */
  static #REFRESH_GROWTH = 1.25;

  /**
   * Measurements added on top of that growth before the estimate is recomputed.
   * @type {number}
   */
  static #REFRESH_SLACK = 4;

  /**
   * Gap after every item, in pixels; counted between items but not after the last one.
   * @type {number}
   */
  #gap;

  /**
   * Height used for an item until any has been measured.
   * @type {number}
   */
  #initialEstimate;

  /**
   * Measured heights by item index; unmeasured items are absent.
   * @type {Array<number|undefined>}
   */
  #measured = [];

  /**
   * Number of measured items.
   * @type {number}
   */
  #measuredCount = 0;

  /**
   * Number of items in the list.
   * @type {number}
   */
  #count = 0;

  /**
   * The current estimate for unmeasured items, kept until enough new measurements have arrived to
   * be worth recomputing it: an estimate that moved with every render would move the whole
   * unrendered part of the list under the view with it.
   * @type {?number}
   */
  #estimateCache = null;

  /**
   * Number of measurements the cached estimate was computed from.
   * @type {number}
   */
  #estimateBasis = 0;

  /**
   * Creates an empty model.
   * @param {number} gap Gap after every item, in pixels.
   * @param {number} initialEstimate Height assumed for items until some have been measured.
   */
  constructor(gap, initialEstimate) {
    this.#gap = gap;
    this.#initialEstimate = initialEstimate;
  }

  /**
   * Number of items in the list.
   * @returns {number} The count.
   */
  get count() {
    return this.#count;
  }

  /**
   * Sets the number of items, forgetting measurements of items beyond it.
   * @param {number} count New item count.
   * @returns {void}
   */
  setCount(count) {
    for (let index = count; index < this.#measured.length; index += 1) this.#forget(index);
    this.#measured.length = Math.min(this.#measured.length, count);
    this.#count = count;
  }

  /**
   * Forgets every measurement, keeping the current average as the estimate for all items.
   * @returns {void}
   */
  clear() {
    this.#initialEstimate = this.#estimate();
    this.#measured = [];
    this.#measuredCount = 0;
    this.#estimateCache = null;
    this.#estimateBasis = 0;
  }

  /**
   * Records an item's measured height.
   * @param {number} index Item index.
   * @param {number} height Measured height in pixels.
   * @returns {boolean} True when it differs from what was known before.
   */
  record(index, height) {
    const previous = this.#measured[index];
    if (previous === height) return false;
    this.#forget(index);
    this.#measured[index] = height;
    this.#measuredCount += 1;
    return true;
  }

  /**
   * An item's height, measured if known, else estimated.
   * @param {number} index Item index.
   * @returns {number} The height in pixels.
   */
  heightOf(index) {
    return this.#measured[index] ?? this.#estimate();
  }

  /**
   * Distance from the top of the list to the top of an item.
   * @param {number} index Item index.
   * @returns {number} The offset in pixels.
   */
  offsetOf(index) {
    return this.#slotsBetween(0, index);
  }

  /**
   * The index of the item covering an offset.
   * @param {number} offset Distance from the top of the list, in pixels.
   * @returns {number} The item's index, clamped to the list; 0 for an empty list.
   */
  indexAt(offset) {
    const estimate = this.#estimate();
    let covered = 0;
    for (let index = 0; index < this.#count; index += 1) {
      covered += (this.#measured[index] ?? estimate) + this.#gap;
      if (covered > offset) return index;
    }
    return Math.max(0, this.#count - 1);
  }

  /**
   * The size of the empty space standing in for a run of unrendered items: their heights and the
   * gaps between them, less the one gap the neighbouring rendered item's own margin supplies.
   * @param {number} from First item index of the run.
   * @param {number} until Index after the run's last item.
   * @returns {number} The space in pixels; 0 for an empty run.
   */
  spanBetween(from, until) {
    return from < until ? this.#slotsBetween(from, until) - this.#gap : 0;
  }

  /**
   * Total height of every item and the gaps between them.
   * @returns {number} The height in pixels.
   */
  get totalHeight() {
    return this.#count > 0 ? this.#slotsBetween(0, this.#count) - this.#gap : 0;
  }

  /**
   * Height of every item in a range, each with its trailing gap.
   * @param {number} from First item index.
   * @param {number} until Index after the last item.
   * @returns {number} The sum in pixels.
   */
  #slotsBetween(from, until) {
    const estimate = this.#estimate();
    let sum = 0;
    for (let index = from; index < until; index += 1) sum += (this.#measured[index] ?? estimate) + this.#gap;
    return sum;
  }

  /**
   * The height assumed for an unmeasured item.
   * @returns {number} The trimmed average of the measured heights, refreshed only once the number
   * of measurements has grown by a quarter; the initial estimate before any measurement.
   */
  #estimate() {
    if (this.#measuredCount === 0) return this.#initialEstimate;
    if (this.#estimateCache === null || this.#measuredCount > this.#estimateBasis * ItemHeights.#REFRESH_GROWTH + ItemHeights.#REFRESH_SLACK) {
      this.#estimateCache = this.#trimmedAverage();
      this.#estimateBasis = this.#measuredCount;
    }
    return this.#estimateCache;
  }

  /**
   * The average of the measured heights without the tallest and shortest tenth, so a few enormous
   * (or empty) items don't drag the estimate for all the others.
   * @returns {number} The average in pixels.
   */
  #trimmedAverage() {
    const heights = this.#measured.filter(height => height !== undefined).sort((first, second) => first - second);
    const trim = Math.floor(heights.length * ItemHeights.#TRIM_FRACTION);
    const kept = heights.slice(trim, heights.length - trim);
    return kept.reduce((sum, height) => sum + height, 0) / kept.length;
  }

  /**
   * Drops one item's measurement from the running totals.
   * @param {number} index Item index.
   * @returns {void}
   */
  #forget(index) {
    const previous = this.#measured[index];
    if (previous === undefined) return;
    this.#measuredCount -= 1;
    this.#measured[index] = undefined;
  }
}
