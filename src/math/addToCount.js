/**
 * Adds to a counter in a count map, creating it at zero first.
 * @param {Object<string, number>} counts The count map; modified in place.
 * @param {string} key Counter to increase.
 * @param {number} amount Amount to add.
 * @returns {void}
 */
export function addToCount(counts, key, amount) {
  counts[key] = (counts[key] ?? 0) + amount;
}
