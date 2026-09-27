import { STORAGE_KEYS } from '../../config/STORAGE_KEYS.js';
import { isChatPaneId } from './isChatPaneId.js';

/**
 * Stores which chat panes are open and which conversation each one shows, across visits.
 */
export class ChatPaneStore {
  /**
   * Storage for the open panes.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Creates the store.
   * @param {Preferences} preferences Storage for the open panes.
   */
  constructor(preferences) {
    this.#preferences = preferences;
  }

  /**
   * The well-formed panes stored by the last visit.
   * @returns {Array<{paneId: string, conversationId: ?string}>} The panes; empty when nothing valid is stored.
   */
  read() {
    const storedPanes = this.#preferences.readJson(STORAGE_KEYS.chatPanes);
    return Array.isArray(storedPanes) ? storedPanes.filter(ChatPaneStore.#isValidStoredPane) : [];
  }

  /**
   * Stores the panes.
   * @param {Array<{paneId: string, conversationId: ?string}>} storedPanes Every pane with its conversation.
   * @returns {void}
   */
  write(storedPanes) {
    this.#preferences.writeJson(STORAGE_KEYS.chatPanes, storedPanes);
  }

  /**
   * Whether a stored pane entry is well formed.
   * @param {*} storedPane Stored entry.
   * @returns {boolean} True for an object with a "chat-" pane id and a string or null conversation id.
   */
  static #isValidStoredPane(storedPane) {
    return Boolean(storedPane) && isChatPaneId(storedPane.paneId) && (storedPane.conversationId === null || typeof storedPane.conversationId === 'string');
  }
}
