import { lastPathSegment } from './lastPathSegment.js';

/**
 * Lower-case extension of a file name or path, ignoring any query string.
 * @param {?string} fileName File name or path.
 * @returns {string} The extension without the dot, or "file" when there is none.
 */
export function fileExtension(fileName) {
  const match = lastPathSegment(fileName).split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : 'file';
}
