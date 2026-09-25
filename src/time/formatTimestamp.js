import { toEpochMs } from './toEpochMs.js';

/**
 * A timestamp as local date and time.
 * @param {?string} isoDate ISO timestamp.
 * @returns {string} The formatted date and time, or an empty string when missing or invalid.
 */
export function formatTimestamp(isoDate) {
  const epochMs = toEpochMs(isoDate);
  return epochMs ? new Date(epochMs).toLocaleString() : '';
}
