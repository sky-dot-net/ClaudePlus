import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import stylesheet from './emptyStateHtml.css';

StyleRegistry.register(stylesheet);

/**
 * HTML for an empty-state message.
 * @param {string} message The message.
 * @returns {string} A div with the message.
 */
export function emptyStateHtml(message) {
  return `<div class="claude-plus-empty-state">${escapeHtml(message)}</div>`;
}
