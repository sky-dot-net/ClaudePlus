import { TIMING } from '../config/TIMING.js';
import { createElement } from '../dom/createElement.js';

/**
 * Lets the browser save text as a file.
 * @param {string} fileName Suggested file name.
 * @param {string} content File content.
 * @param {string} mimeType MIME type of the content.
 * @returns {void}
 */
export function downloadTextFile(fileName, content, mimeType) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
  const link = createElement('a', { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), TIMING.downloadUrlLifetimeMs);
}
