/**
 * Whether an id belongs to a chat pane.
 * @param {*} panelId Panel id.
 * @returns {boolean} True for ids starting with "chat-".
 */
export function isChatPaneId(panelId) {
  return String(panelId).startsWith('chat-');
}
