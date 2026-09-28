import { STORAGE_KEYS } from '../config/STORAGE_KEYS.js';

/**
 * Settings remembered per conversation, such as whether its in-chat search reads a regular
 * expression, kept in one stored object keyed by conversation id.
 */
export class ConversationSettings {
  /**
   * Storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Creates the store.
   * @param {Preferences} preferences Storage.
   */
  constructor(preferences) {
    this.#preferences = preferences;
  }

  /**
   * A conversation's setting.
   * @param {?string} conversationId Conversation id; null for a chat that has not been saved yet.
   * @param {string} name Setting name.
   * @param {*} fallback Value when the conversation has none stored.
   * @returns {*} The stored value, or the fallback.
   */
  get(conversationId, name, fallback) {
    const stored = conversationId ? this.#preferences.readJson(STORAGE_KEYS.conversationSettings)?.[conversationId] : null;
    return stored && name in stored ? stored[name] : fallback;
  }

  /**
   * Remembers a conversation's setting; skipped for a chat that has not been saved yet.
   * @param {?string} conversationId Conversation id.
   * @param {string} name Setting name.
   * @param {*} value JSON-serializable value.
   * @returns {void}
   */
  set(conversationId, name, value) {
    if (!conversationId) return;
    const stored = this.#preferences.readJson(STORAGE_KEYS.conversationSettings) ?? {};
    stored[conversationId] = { ...stored[conversationId], [name]: value };
    this.#preferences.writeJson(STORAGE_KEYS.conversationSettings, stored);
  }
}
