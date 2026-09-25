import { XML_FORBIDDEN_CHARACTERS } from '../config/XML_FORBIDDEN_CHARACTERS.js';
import { escapeHtml } from './escapeHtml.js';

/**
 * Escapes a value for XML text or attribute values and drops characters XML can't contain.
 * @param {*} value Value to escape; null and undefined become an empty string.
 * @returns {string} The escaped string.
 */
export function escapeXml(value) {
  return escapeHtml(String(value ?? '').replace(XML_FORBIDDEN_CHARACTERS, ''));
}
