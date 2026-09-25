/**
 * Parses a date string into epoch milliseconds.
 * @param {?string} isoDate ISO date string.
 * @returns {number} Epoch milliseconds, or 0 when missing or invalid.
 */
export function toEpochMs(isoDate) {
  return Date.parse(isoDate) || 0;
}
