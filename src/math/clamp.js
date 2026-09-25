/**
 * Limits a number to a range.
 * @param {number} value The number.
 * @param {number} minimum Lower bound.
 * @param {number} maximum Upper bound.
 * @returns {number} The value, raised to the minimum or lowered to the maximum if outside the range.
 */
export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
