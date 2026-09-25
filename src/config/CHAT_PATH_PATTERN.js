/**
 * Matches a conversation page path and captures the conversation id.
 * @type {RegExp}
 */
export const CHAT_PATH_PATTERN = /^\/chat\/([0-9a-f-]{36})/i;
