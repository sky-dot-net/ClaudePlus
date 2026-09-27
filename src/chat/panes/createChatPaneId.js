/**
 * Creates a unique chat pane id.
 * @returns {string} An id starting with "chat-".
 */
export function createChatPaneId() {
  return `chat-${crypto.randomUUID()}`;
}
