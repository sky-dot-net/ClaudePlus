import { DATABASE } from '../config/DATABASE.js';

/**
 * Persisted imported conversations, read as the app's own conversation shape so they load through
 * the same pipeline as a live fetch, and listed alongside live conversations in the directory.
 */
export class ImportedConversationStore {
  /**
   * Backing storage.
   * @type {IndexedDbStore}
   */
  #database;

  /**
   * Creates the store on top of the shared database.
   * @param {IndexedDbStore} database Backing storage.
   */
  constructor(database) {
    this.#database = database;
  }

  /**
   * An imported conversation, ready to render.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<?ApiConversation>} The conversation, or null when it isn't an imported one.
   */
  async get(conversationId) {
    const record = await this.getRecord(conversationId);
    return record ? ImportedConversationStore.toApiConversation(record) : null;
  }

  /**
   * A conversation's stored record, for merging a newly imported export against it.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<?ImportedConversationRecord>} The record, or undefined when not imported yet.
   */
  getRecord(conversationId) {
    return this.#database.read(DATABASE.stores.importedConversations, conversationId);
  }

  /**
   * Listings of every imported conversation, for merging into the directory.
   * @returns {Promise<ConversationListing[]>} The listings, each tagged isImported.
   */
  async listings() {
    const records = await this.#database.readAll(DATABASE.stores.importedConversations);
    return records.map(record => ({ uuid: record.conversationId, name: record.title, updated_at: record.updatedAt, isImported: true }));
  }

  /**
   * Stores a merged conversation record.
   * @param {ImportedConversationRecord} record The record.
   * @returns {Promise<void>} Resolves once written.
   */
  write(record) {
    return this.#database.write(DATABASE.stores.importedConversations, record);
  }

  /**
   * Removes an imported conversation from the local store.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<void>} Resolves once removed.
   */
  remove(conversationId) {
    return this.#database.remove(DATABASE.stores.importedConversations, conversationId);
  }

  /**
   * A stored record as the app's own conversation shape, for rendering or re-indexing.
   * @param {ImportedConversationRecord} record The record.
   * @returns {ApiConversation} The conversation.
   */
  static toApiConversation(record) {
    return { uuid: record.conversationId, name: record.title, updated_at: record.updatedAt, current_leaf_message_uuid: record.currentLeafId, chat_messages: record.messages };
  }
}
