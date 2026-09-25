/**
 * Arithmetic mean of a list of numbers.
 * @param {number[]} values The numbers.
 * @returns {number} The mean, or 0 for an empty list.
 */
export function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
