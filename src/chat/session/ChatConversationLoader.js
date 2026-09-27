import { LOG_PREFIX } from '../../config/LOG_PREFIX.js';
import { NavigationCounter } from '../NavigationCounter.js';
import { createErrorNotice } from '../createErrorNotice.js';

/**
 * Switches a chat session between conversations: stops any reply, clears what was shown, then
 * loads the conversation (its imported copy if it has one, else fetched live). Responses arriving
 * after the user has navigated elsewhere are dropped.
 */
export class ChatConversationLoader {
  /**
   * API client.
   * @type {ClaudeApi}
   */
  #api;

  /**
   * Imported conversations, checked before the live API.
   * @type {ImportedConversationStore}
   */
  #importedConversations;

  /**
   * The session's state.
   * @type {ChatSessionState}
   */
  #state;

  /**
   * Stops the reply in progress.
   * @type {function(): void}
   */
  #stopReply;

  /**
   * Numbers navigations, so late responses for an old one are dropped.
   * @type {NavigationCounter}
   */
  #navigations = new NavigationCounter();

  /**
   * Creates the loader.
   * @param {object} parts Loader parts.
   * @param {ClaudeApi} parts.api API client.
   * @param {ImportedConversationStore} parts.importedConversations Imported conversations, checked before the live API.
   * @param {ChatSessionState} parts.state The session's state.
   * @param {function(): void} parts.stopReply Stops the reply in progress.
   */
  constructor({ api, importedConversations, state, stopReply }) {
    this.#api = api;
    this.#importedConversations = importedConversations;
    this.#state = state;
    this.#stopReply = stopReply;
  }

  /**
   * Opens a conversation. A load failure is shown as an error notice.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<void>} Resolves once the messages or the error notice are shown.
   */
  async open(conversationId) {
    const navigation = this.beginNavigation(conversationId);
    try {
      const { conversation, isImported } = await this.#load(conversationId);
      if (this.#navigations.isLatest(navigation)) this.#state.showConversation(conversation, isImported);
    } catch (error) {
      this.#showLoadError(navigation, error);
    }
  }

  /**
   * Stops any reply, clears the messages and makes a conversation (or a new chat) open.
   * @param {?string} conversationId Conversation to open, or null for a new chat.
   * @returns {number} Number identifying this navigation.
   */
  beginNavigation(conversationId) {
    this.#stopReply();
    const navigation = this.#navigations.begin();
    this.#state.reset(conversationId);
    return navigation;
  }

  /**
   * Loads a conversation: its imported copy if it has one, else fetched live.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<{conversation: ApiConversation, isImported: boolean}>} The conversation and
   * whether it came from the imported store.
   * @throws {ApiError} When it isn't imported and the live fetch fails.
   */
  async #load(conversationId) {
    const imported = await this.#importedConversations.get(conversationId);
    return { conversation: imported ?? await this.#api.getConversation(conversationId), isImported: Boolean(imported) };
  }

  /**
   * Shows a conversation load failure, unless the user has navigated away since.
   * @param {number} navigation Number of the failed navigation, from NavigationCounter.begin().
   * @param {Error} error The failure.
   * @returns {void}
   */
  #showLoadError(navigation, error) {
    if (!this.#navigations.isLatest(navigation)) return;
    console.warn(LOG_PREFIX, 'loading conversation failed', error);
    this.#state.setMessages([createErrorNotice(`Could not load this conversation (${error.message}).`)]);
  }
}
