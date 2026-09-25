/**
 * The browser's IANA time zone.
 * @returns {string} The time zone name, or "UTC" when unavailable.
 */
export function currentTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
