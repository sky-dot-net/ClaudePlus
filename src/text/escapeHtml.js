import { HTML_ENTITIES } from '../config/HTML_ENTITIES.js';

/**
 * Escapes a value for safe insertion into HTML text or attribute values.
 * @param {*} value Value to escape; null and undefined become an empty string.
 * @returns {string} The escaped string.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => HTML_ENTITIES[character]);
}
