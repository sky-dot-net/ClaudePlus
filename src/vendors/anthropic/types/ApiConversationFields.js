/**
 * Field access for an ApiConversation, so callers never read its raw API field names directly.
 */
export class ApiConversationFields {
  /**
   * A conversation's id.
   * @param {ApiConversation} conversation The conversation.
   * @returns {string} Its id.
   */
  static id(conversation) {
    return conversation.uuid;
  }

  /**
   * When a conversation last changed.
   * @param {ApiConversation} conversation The conversation.
   * @returns {string} ISO timestamp of the last change.
   */
  static updatedAt(conversation) {
    return conversation.updated_at;
  }
}
