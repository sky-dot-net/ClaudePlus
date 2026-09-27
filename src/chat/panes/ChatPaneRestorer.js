import { createChatPaneId } from './createChatPaneId.js';

/**
 * Recreates the chat panes stored by the last visit, then reopens their conversations once the
 * data they need has loaded.
 */
export class ChatPaneRestorer {
  /**
   * Stored panes.
   * @type {ChatPaneStore}
   */
  #store;

  /**
   * Creates an undocked pane with a given id.
   * @type {function(string): {session: ChatSession, panel: ChatPanel}}
   */
  #createPane;

  /**
   * Conversations to reopen in restored panes, by pane id.
   * @type {Map<string, {session: ChatSession, conversationId: string}>}
   */
  #conversationsToRestore = new Map();

  /**
   * Creates the restorer.
   * @param {ChatPaneStore} store Stored panes.
   * @param {function(string): {session: ChatSession, panel: ChatPanel}} createPane Creates an undocked pane with a given id.
   */
  constructor(store, createPane) {
    this.#store = store;
    this.#createPane = createPane;
  }

  /**
   * Recreates the stored panes, or one empty pane, remembering their conversations for
   * openRemaining.
   * @param {?string} preferredConversationId Conversation in the URL, or null.
   * @returns {string} Id of the pane to focus: the one that showed the preferred conversation, otherwise the first one.
   */
  restore(preferredConversationId) {
    const storedPanes = this.#store.read();
    const panes = storedPanes.length ? storedPanes : [{ paneId: createChatPaneId(), conversationId: null }];
    panes.forEach(pane => this.#restorePane(pane));
    const preferredPane = panes.find(pane => pane.conversationId !== null && pane.conversationId === preferredConversationId);
    return (preferredPane || panes[0]).paneId;
  }

  /**
   * Reopens the remembered conversations of every restored pane except the focused one, whose
   * conversation comes from the URL.
   * @param {string} focusedPaneId Id of the focused pane.
   * @returns {void}
   */
  openRemaining(focusedPaneId) {
    this.#conversationsToRestore.delete(focusedPaneId);
    this.#conversationsToRestore.forEach(({ session, conversationId }) => session.openConversation(conversationId));
    this.#conversationsToRestore.clear();
  }

  /**
   * Creates a pane from its stored state, remembering its conversation for later.
   * @param {{paneId: string, conversationId: ?string}} storedPane Stored pane.
   * @returns {void}
   */
  #restorePane({ paneId, conversationId }) {
    const { session } = this.#createPane(paneId);
    if (conversationId) this.#conversationsToRestore.set(paneId, { session, conversationId });
  }
}
