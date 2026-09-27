/**
 * Page path of a conversation.
 * @param {string} conversationId Conversation id.
 * @returns {string} The path.
 */
export function conversationPath(conversationId) {
  return `/chat/${conversationId}`;
}
