/**
 * The heights of a long list's items: measured for the ones that have been rendered, estimated
 * (from the average of what has been measured) for the rest. Gives the offsets and spacer sizes a
 * windowed list needs without ever rendering the items in between.
 */
export class ItemHeights {
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
   * Sum of every measured height.
   * @type {number}
   */
  #measuredSum = 0;

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
    const estimate = this.#estimate();
    this.#measured = [];
    this.#measuredSum = 0;
    this.#measuredCount = 0;
    this.#initialEstimate = estimate;
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
    this.#measuredSum += height;
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
   * @returns {number} The average measured height, or the initial estimate before any measurement.
   */
  #estimate() {
    return this.#measuredCount > 0 ? this.#measuredSum / this.#measuredCount : this.#initialEstimate;
  }

  /**
   * Drops one item's measurement from the running totals.
   * @param {number} index Item index.
   * @returns {void}
   */
  #forget(index) {
    const previous = this.#measured[index];
    if (previous === undefined) return;
    this.#measuredSum -= previous;
    this.#measuredCount -= 1;
    this.#measured[index] = undefined;
  }
}
