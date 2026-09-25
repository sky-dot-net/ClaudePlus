import { FILE_NAME_FORBIDDEN_CHARACTERS } from '../config/FILE_NAME_FORBIDDEN_CHARACTERS.js';
import { LIMITS } from '../config/LIMITS.js';

/**
 * Makes a conversation title usable in a file name.
 * @param {string} title Conversation title.
 * @returns {string} The title without forbidden characters and shortened, or "conversation" if nothing remains.
 */
export function fileNameFromTitle(title) {
  const cleaned = title.replace(FILE_NAME_FORBIDDEN_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, LIMITS.exportFileNameLength).trim() || 'conversation';
}
