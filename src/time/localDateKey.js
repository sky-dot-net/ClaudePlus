import { toEpochMs } from './toEpochMs.js';

/**
 * Calendar day of a timestamp in local time.
 * @param {?string} isoDate ISO timestamp.
 * @returns {string} The day as YYYY-MM-DD, or an empty string when missing or invalid.
 */
export function localDateKey(isoDate) {
  const epochMs = toEpochMs(isoDate);
  if (!epochMs) return '';
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
