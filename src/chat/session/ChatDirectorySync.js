import { LOG_PREFIX } from '../../config/LOG_PREFIX.js';

/**
 * Keeps the shared conversation list in step with what a chat session creates and sends: lists a
 * just-created conversation, and refreshes a conversation from the server after each send.
 */
export class ChatDirectorySync {
  /**
   * API client.
   * @type {ClaudeApi}
   */
  #api;

  /**
   * Shared conversation list.
   * @type {CombinedConversationDirectory}
   */
  #directory;

  /**
   * The session's state.
   * @type {ChatSessionState}
   */
  #state;

  /**
   * Publishes a session event with an optional payload.
   * @type {function(string, *=): void}
   */
  #publish;

  /**
   * Creates the sync.
   * @param {object} parts Sync parts.
   * @param {ClaudeApi} parts.api API client.
   * @param {CombinedConversationDirectory} parts.directory Shared conversation list.
   * @param {ChatSessionState} parts.state The session's state.
   * @param {function(string, *=): void} parts.publish Publishes a session event with an optional payload.
   */
  constructor({ api, directory, state, publish }) {
    this.#api = api;
    this.#directory = directory;
    this.#state = state;
    this.#publish = publish;
  }

  /**
   * Lists a just-created conversation and makes it the open one.
   * @param {string} conversationId Conversation id.
   * @param {string} prompt First prompt, used as a provisional title.
   * @returns {void}
   */
  registerNewConversation(conversationId, prompt) {
    this.#directory.registerNewConversation(conversationId, prompt);
    this.#state.setOpenConversation(conversationId);
  }

  /**
   * Fetches the conversation after a send to update the list and the stats, and replaces the
   * optimistic messages with the server's copy (real tool blocks and parent ids).
   * @param {string} conversationId Conversation id.
   * @param {boolean} replaceMessages False after a failure, so the error stays on screen.
   * @returns {Promise<void>} Resolves once done; failures are logged.
   */
  async reloadAfterSend(conversationId, replaceMessages) {
    try {
      const conversation = await this.#api.getConversation(conversationId);
      this.#directory.updateListing(conversation);
      this.#publish('conversationLoaded', { conversation, isImported: false });
      if (replaceMessages && this.#state.isOpenAndIdle(conversationId)) this.#state.showBranchOf(conversation);
    } catch (error) {
      console.warn(LOG_PREFIX, 'refreshing conversation failed', error);
    }
  }
}
