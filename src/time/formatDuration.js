/**
 * Formats a duration compactly, e.g. "2h 5m", "3m 12s" or "40s".
 * @param {number} durationMs Duration in milliseconds; negative values count as zero.
 * @returns {string} The formatted duration.
 */
export function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
