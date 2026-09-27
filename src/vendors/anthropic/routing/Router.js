import { NEW_CHAT_PATH } from '../config/NEW_CHAT_PATH.js';
import { conversationIdFromPath } from './conversationIdFromPath.js';
import { conversationPath } from './conversationPath.js';

/**
 * Keeps the URL in sync with the focused pane's conversation and handles back/forward navigation.
 */
export class Router {
  /**
   * Chat panes.
   * @type {ChatPaneManager}
   */
  #paneManager;

  /**
   * Creates the router.
   * @param {ChatPaneManager} paneManager Chat panes.
   */
  constructor(paneManager) {
    this.#paneManager = paneManager;
  }

  /**
   * Opens what the current URL points to in the focused pane and starts following navigation.
   * @returns {Promise<void>} Resolves once the conversation is shown.
   */
  async start() {
    window.addEventListener('popstate', () => this.#openFromUrl());
    this.#paneManager.subscribe('focus', () => this.#updateUrlToFocusedConversation());
    this.#paneManager.subscribe('paneConversations', paneId => this.#onPaneConversationChanged(paneId));
    await this.#openFromUrl();
  }

  /**
   * Opens a conversation in the focused pane as a user navigation, adding a history entry.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<void>} Resolves once the conversation is shown.
   */
  openConversation(conversationId) {
    if (conversationIdFromPath(location.pathname) !== conversationId) history.pushState(null, '', conversationPath(conversationId));
    return this.#paneManager.openInFocusedPane(conversationId);
  }

  /**
   * Starts a new chat in the focused pane as a user navigation, adding a history entry.
   * @returns {void}
   */
  startNewConversation() {
    if (location.pathname !== NEW_CHAT_PATH) history.pushState(null, '', NEW_CHAT_PATH);
    this.#paneManager.startNewInFocusedPane();
  }

  /**
   * Opens the conversation in the URL, or a new chat, in the focused pane.
   * @returns {Promise<void>} Resolves once a conversation is shown.
   */
  async #openFromUrl() {
    const conversationId = conversationIdFromPath(location.pathname);
    if (conversationId) await this.#paneManager.openInFocusedPane(conversationId);
    else this.#paneManager.startNewInFocusedPane();
  }

  /**
   * Follows conversation changes of the focused pane only.
   * @param {string} paneId Pane whose conversation changed.
   * @returns {void}
   */
  #onPaneConversationChanged(paneId) {
    if (paneId === this.#paneManager.focusedPaneId) this.#updateUrlToFocusedConversation();
  }

  /**
   * Points the URL at the focused pane's conversation, replacing the history entry rather than adding one.
   * @returns {void}
   */
  #updateUrlToFocusedConversation() {
    const openId = this.#paneManager.focusedSession.openConversationId;
    if (openId === conversationIdFromPath(location.pathname)) return;
    history.replaceState(null, '', openId ? conversationPath(openId) : NEW_CHAT_PATH);
  }
}
