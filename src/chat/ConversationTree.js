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

  /**
   * Every message sharing a message's parent, itself included, oldest first: the versions a
   * branch-switch control cycles through (the original and each edit or retry of it).
   * @param {ApiConversation} conversation The conversation.
   * @param {string} messageId A message in the group.
   * @returns {ApiMessage[]} The sibling group, oldest first; empty if messageId isn't found.
   */
  static siblingsOf(conversation, messageId) {
    const messages = conversation.chat_messages ?? [];
    const target = messages.find(message => message.uuid === messageId);
    if (!target) return [];
    return messages
      .filter(message => message.parent_message_uuid === target.parent_message_uuid)
      .sort((earlier, later) => (earlier.created_at ?? '').localeCompare(later.created_at ?? ''));
  }

  /**
   * The leaf reached by following each level's most recently created child from a message, so
   * switching to a sibling branch lands on its latest edit or retry rather than its first reply.
   * @param {ApiConversation} conversation The conversation.
   * @param {string} messageId Message to descend from.
   * @returns {string} The leaf message's id; messageId itself when it has no children.
   */
  static latestLeafFrom(conversation, messageId) {
    const messages = conversation.chat_messages ?? [];
    let current = messageId;
    for (
      let children = ConversationTree.#childrenOf(messages, current);
      children.length > 0;
      children = ConversationTree.#childrenOf(messages, current)
    ) {
      current = ConversationTree.#latestOf(children).uuid;
    }
    return current;
  }

  /**
   * Direct children of a message.
   * @param {ApiMessage[]} messages Every message of the conversation.
   * @param {string} parentId Parent message id.
   * @returns {ApiMessage[]} Its children, in no particular order.
   */
  static #childrenOf(messages, parentId) {
    return messages.filter(message => message.parent_message_uuid === parentId);
  }

  /**
   * The most recently created of a group of messages.
   * @param {ApiMessage[]} messages A non-empty group.
   * @returns {ApiMessage} The latest one.
   */
  static #latestOf(messages) {
    return messages.reduce((latest, message) => ((message.created_at ?? '') > (latest.created_at ?? '') ? message : latest));
  }
}
