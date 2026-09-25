import { CHAT_PATH_PATTERN } from '../config/CHAT_PATH_PATTERN.js';

/**
 * Extracts the conversation id from a page path.
 * @param {string} pathname Path such as "/chat/<uuid>".
 * @returns {?string} The conversation id, or null when the path isn't a conversation page.
 */
export function conversationIdFromPath(pathname) {
  const match = pathname.match(CHAT_PATH_PATTERN);
  return match ? match[1] : null;
}
