import { EventEmitter } from '../core/EventEmitter.js';

/**
 * The conversation list shown everywhere in the app: live conversations from the vendor directory,
 * plus imported ones merged in, tagged isImported so the UI can tell them apart. Presents the same
 * shape a live-only directory already does, so every existing consumer (the Chats list, search,
 * pane manager) needs no changes beyond receiving this instead of the vendor directory directly.
 * @fires CombinedConversationDirectory#conversations The list changed.
 * @fires CombinedConversationDirectory#conversationDeleted A conversation was deleted; payload is its id.
 */
export class CombinedConversationDirectory extends EventEmitter {
  /**
   * Live conversations.
   * @type {ConversationDirectory}
   */
  #liveDirectory;

  /**
   * Imported conversations.
   * @type {ImportedConversationStore}
   */
  #importedConversations;

  /**
   * Imported listings, refreshed independently of the live directory.
   * @type {ConversationListing[]}
   */
  #importedListings = [];

  /**
   * Wraps a live directory and an imported store into one combined list.
   * @param {ConversationDirectory} liveDirectory Live conversations.
   * @param {ImportedConversationStore} importedConversations Imported conversations.
   */
  constructor(liveDirectory, importedConversations) {
    super();
    this.#liveDirectory = liveDirectory;
    this.#importedConversations = importedConversations;
    liveDirectory.subscribe('conversations', () => this.publish('conversations'));
    liveDirectory.subscribe('conversationDeleted', conversationId => this.publish('conversationDeleted', conversationId));
  }

  /**
   * The combined listings.
   * @returns {ConversationListing[]} Live conversations, then imported ones.
   */
  get conversations() {
    return [...this.#liveDirectory.conversations, ...this.#importedListings];
  }

  /**
   * Reloads the live list.
   * @returns {Promise<void>} Resolves once reloaded or failed.
   */
  refresh() {
    return this.#liveDirectory.refresh();
  }

  /**
   * Reloads the imported listings from local storage.
   * @returns {Promise<void>} Resolves once reloaded.
   */
  async refreshImported() {
    this.#importedListings = await this.#importedConversations.listings();
    this.publish('conversations');
  }

  /**
   * Display title of a listed conversation, live or imported.
   * @param {string} conversationId Conversation id.
   * @returns {string} Its title, or UNTITLED when it has none or isn't listed.
   */
  titleOf(conversationId) {
    const imported = this.#importedListings.find(listing => listing.uuid === conversationId);
    return imported ? imported.name : this.#liveDirectory.titleOf(conversationId);
  }

  /**
   * Adds a just-created live conversation to the top of the list.
   * @param {string} conversationId Conversation id.
   * @param {string} prompt First prompt, used as a provisional title.
   * @returns {void}
   */
  registerNewConversation(conversationId, prompt) {
    this.#liveDirectory.registerNewConversation(conversationId, prompt);
  }

  /**
   * Updates a live listing's title and time from the server.
   * @param {ApiConversation} conversation The fetched conversation.
   * @returns {void}
   */
  updateListing(conversation) {
    this.#liveDirectory.updateListing(conversation);
  }

  /**
   * Deletes a conversation: permanently through the live API for a live one, or from the local
   * store alone for an imported one.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<void>} Resolves once deleted.
   * @throws {ApiError} When a live delete is refused; nothing changes locally.
   */
  async deleteConversation(conversationId) {
    if (this.#importedListings.some(listing => listing.uuid === conversationId)) {
      await this.#deleteImported(conversationId);
    } else {
      await this.#liveDirectory.deleteConversation(conversationId);
    }
  }

  /**
   * Removes an imported conversation from the local store and its listing, then announces it the
   * same way a live delete does.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<void>} Resolves once removed.
   */
  async #deleteImported(conversationId) {
    await this.#importedConversations.remove(conversationId);
    this.#importedListings = this.#importedListings.filter(listing => listing.uuid !== conversationId);
    this.publish('conversations');
    this.publish('conversationDeleted', conversationId);
  }
}
