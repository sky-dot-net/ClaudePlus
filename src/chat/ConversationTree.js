/**
 * Selects the branch of a conversation tree that claude.ai shows.
 */
export class ConversationTree {
  /**
   * The messages from the root to the current leaf. Falls back to every message when the tree
   * fields aren't present.
   * @param {ApiConversation} conversation The conversation.
   * @returns {ApiMessage[]} The branch, oldest first.
   */
  static currentBranch(conversation) {
    const messages = conversation.chat_messages ?? [];
    const messagesById = new Map(messages.map(message => [message.uuid, message]));
    const leafMessage = messagesById.get(conversation.current_leaf_message_uuid);
    return ConversationTree.#hasTreeFields(messages, leafMessage) ? ConversationTree.#pathToRoot(leafMessage, messagesById) : messages;
  }

  /**
   * Whether the messages carry enough information to walk the tree.
   * @param {ApiMessage[]} messages All messages.
   * @param {ApiMessage|undefined} leafMessage The current leaf, if found.
   * @returns {boolean} True when the leaf exists and every message has a parent field.
   */
  static #hasTreeFields(messages, leafMessage) {
    return Boolean(leafMessage) && messages.every(message => 'parent_message_uuid' in message);
  }

  /**
   * Follows parent links from a message to the root, stopping at a missing or repeated message.
   * @param {ApiMessage} leafMessage Starting message.
   * @param {Map<string, ApiMessage>} messagesById Every message by id.
   * @returns {ApiMessage[]} The path, root first.
   */
  static #pathToRoot(leafMessage, messagesById) {
    const path = [];
    const visitedIds = new Set();
    for (let message = leafMessage; message && !visitedIds.has(message.uuid); message = messagesById.get(message.parent_message_uuid)) {
      visitedIds.add(message.uuid);
      path.push(message);
    }
    return path.reverse();
  }
}
