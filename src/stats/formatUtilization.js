/**
 * Formats a usage window's utilization as a percentage rounded to two decimals.
 * @param {?UsageWindow} usageWindow The window, or null when unknown.
 * @returns {string} The percentage, or "–" when unknown.
 */
export function formatUtilization(usageWindow) {
  if (!usageWindow) return '–';
  return `${Math.round((usageWindow.utilization || 0) * 100) / 100}%`;
}
