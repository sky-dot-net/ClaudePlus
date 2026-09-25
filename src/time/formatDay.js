import { toEpochMs } from './toEpochMs.js';

/**
 * A timestamp as local date.
 * @param {?string} isoDate ISO timestamp.
 * @returns {string} The formatted date, or an empty string when missing or invalid.
 */
export function formatDay(isoDate) {
  const epochMs = toEpochMs(isoDate);
  return epochMs ? new Date(epochMs).toLocaleDateString() : '';
}
