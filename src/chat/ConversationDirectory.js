import { EventEmitter } from '../core/EventEmitter.js';
import { LIMITS } from '../config/LIMITS.js';
import { LOG_PREFIX } from '../config/LOG_PREFIX.js';
import { UNTITLED } from '../config/UNTITLED.js';

/**
 * The shared list of the user's conversations, as shown in the sidebar.
 * @fires ConversationDirectory#conversations The list changed.
 * @fires ConversationDirectory#conversationDeleted A conversation was deleted; payload is its id.
 */
export class ConversationDirectory extends EventEmitter {
  /**
   * API client.
   * @type {ClaudeApi}
   */
  #api;

  /**
   * Conversations, newest first.
   * @type {ConversationListing[]}
   */
  #conversations = [];

  /**
   * Creates the directory.
   * @param {ClaudeApi} api API client.
   */
  constructor(api) {
    super();
    this.#api = api;
  }

  /**
   * The listed conversations.
   * @returns {ConversationListing[]} Conversations, newest first.
   */
  get conversations() {
    return this.#conversations;
  }

  /**
   * Reloads the list. Failures are logged and leave the current list in place.
   * @returns {Promise<void>} Resolves once reloaded or failed.
   */
  async refresh() {
    try {
      this.#conversations = await this.#api.listConversations(0, LIMITS.sidebarPageSize);
    } catch (error) {
      console.warn(LOG_PREFIX, 'loading conversations failed', error);
    }
    this.publish('conversations');
  }

  /**
   * Display title of a listed conversation.
   * @param {string} conversationId Conversation id.
   * @returns {string} Its title, or UNTITLED when it has none or isn't listed.
   */
  titleOf(conversationId) {
    const conversation = this.#conversations.find(listing => listing.uuid === conversationId);
    return (conversation && conversation.name) || UNTITLED;
  }

  /**
   * Adds a just-created conversation to the top of the list.
   * @param {string} conversationId Conversation id.
   * @param {string} prompt First prompt, used as a provisional title.
   * @returns {void}
   */
  registerNewConversation(conversationId, prompt) {
    const listing = { uuid: conversationId, name: prompt.slice(0, LIMITS.provisionalTitleLength), updated_at: new Date().toISOString() };
    this.#conversations = [listing, ...this.#conversations];
    this.publish('conversations');
  }

  /**
   * Updates a listed conversation's title and time from the server and moves it to the top.
   * @param {ApiConversation} conversation The fetched conversation.
   * @returns {void}
   */
  updateListing(conversation) {
    const existing = this.#conversations.find(listing => listing.uuid === conversation.uuid);
    if (!existing) return;
    const updated = { ...existing, name: conversation.name || existing.name, updated_at: conversation.updated_at || existing.updated_at };
    this.#conversations = [updated, ...this.#conversations.filter(listing => listing !== existing)];
    this.publish('conversations');
  }

  /**
   * Permanently deletes a conversation.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<void>} Resolves once deleted.
   * @throws {ApiError} When the server refuses; nothing changes locally.
   */
  async deleteConversation(conversationId) {
    await this.#api.deleteConversation(conversationId);
    this.#conversations = this.#conversations.filter(conversation => conversation.uuid !== conversationId);
    this.publish('conversations');
    this.publish('conversationDeleted', conversationId);
  }
}
