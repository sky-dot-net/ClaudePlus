/**
 * Last segment of a slash-separated path.
 * @param {?string} path The path.
 * @returns {string} The last segment, or an empty string.
 */
export function lastPathSegment(path) {
  return (path || '').split('/').pop();
}
