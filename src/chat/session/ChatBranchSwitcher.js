import { ConversationTree } from '../../vendors/anthropic/chat/ConversationTree.js';

/**
 * Moves a chat session between sibling versions of a message (its edits or retried replies).
 */
export class ChatBranchSwitcher {
  /**
   * API client, persisting the chosen branch server-side.
   * @type {ClaudeApi}
   */
  #api;

  /**
   * The session's state.
   * @type {ChatSessionState}
   */
  #state;

  /**
   * Creates the switcher.
   * @param {ClaudeApi} api API client, persisting the chosen branch server-side.
   * @param {ChatSessionState} state The session's state.
   */
  constructor(api, state) {
    this.#api = api;
    this.#state = state;
  }

  /**
   * Position of a message among its siblings, for a branch-switch control. Null when it has no
   * siblings besides itself, or before the conversation has loaded.
   * @param {string} messageId Message id.
   * @returns {?{index: number, count: number}} Its zero-based position and the sibling count, or null.
   */
  branchInfoFor(messageId) {
    const conversation = this.#state.conversation;
    if (!conversation) return null;
    const siblings = ConversationTree.siblingsOf(conversation, messageId);
    if (siblings.length <= 1) return null;
    return { index: siblings.findIndex(sibling => sibling.uuid === messageId), count: siblings.length };
  }

  /**
   * Switches to a sibling version of a message, landing on that version's latest leaf, and
   * persists the choice server-side. Ignored while sending, before the conversation has loaded,
   * or when there is no sibling in that direction.
   * @param {string} messageId Message id.
   * @param {number} step -1 for the previous version, +1 for the next.
   * @returns {Promise<void>} Resolves once switched.
   */
  async switchBranch(messageId, step) {
    const conversation = this.#state.conversation;
    if (this.#state.isSending || !conversation) return;
    const siblings = ConversationTree.siblingsOf(conversation, messageId);
    const target = siblings[siblings.findIndex(sibling => sibling.uuid === messageId) + step];
    if (!target) return;
    const leafId = ConversationTree.latestLeafFrom(conversation, target.uuid);
    await this.#api.setCurrentLeafMessage(this.#state.openConversationId, leafId);
    this.#state.showBranchOf(ConversationTree.withCurrentLeaf(this.#state.conversation, leafId));
  }
}
