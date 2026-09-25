import { escapeHtml } from '../../text/escapeHtml.js';

/**
 * HTML for an empty-state message.
 * @param {string} message The message.
 * @returns {string} A div with the message.
 */
export function emptyStateHtml(message) {
  return `<div class="claude-plus-empty-state">${escapeHtml(message)}</div>`;
}
