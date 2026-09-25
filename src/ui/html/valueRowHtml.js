import { escapeHtml } from '../../text/escapeHtml.js';

/**
 * HTML for a label/value row.
 * @param {string} label Row label.
 * @param {string|number} value Row value.
 * @returns {string} The row.
 */
export function valueRowHtml(label, value) {
  return `<div class="claude-plus-value-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
}
