import { ConversationSubPane } from './ConversationSubPane.js';
import { MessageListView } from './MessageListView.js';
import { Panel } from './Panel.js';

/**
 * A chat pane: one session's messages, plus optional sub-panes listing the conversation's files
 * and web sources docked to its left, top or right edge. Its tab shows the conversation title; it
 * becomes the active chat when clicked, and gets a faint green border while it is active and more
 * than one chat pane is visible.
 */
export class ChatPanel extends Panel {
  /**
   * Pane id.
   * @type {string}
   */
  #paneId;

  /**
   * Session shown in this pane.
   * @type {ChatSession}
   */
  #session;

  /**
   * Shared conversation list, for the tab title.
   * @type {ConversationDirectory}
   */
  #directory;

  /**
   * Chat panes, for focus and closing.
   * @type {ChatPaneManager}
   */
  #paneManager;

  /**
   * Conversation statistics, for the sub-panes.
   * @type {StatsIndex}
   */
  #stats;

  /**
   * Table settings storage, for the sub-panes.
   * @type {Preferences}
   */
  #preferences;

  /**
   * The message list.
   * @type {?MessageListView}
   */
  #messageListView = null;

  /**
   * Open sub-panes by kind.
   * @type {Map<string, ConversationSubPane>}
   */
  #subPanes = new Map();

  /**
   * Creates the pane's panel.
   * @param {object} services Panel dependencies.
   * @param {string} services.paneId Pane id.
   * @param {ChatSession} services.session Session shown in this pane.
   * @param {ConversationDirectory} services.directory Shared conversation list, for the tab title.
   * @param {ChatPaneManager} services.paneManager Chat panes, for focus and closing.
   * @param {StatsIndex} services.stats Conversation statistics, for the sub-panes.
   * @param {Preferences} services.preferences Table settings storage, for the sub-panes.
   */
  constructor({ paneId, session, directory, paneManager, stats, preferences }) {
    super('Chat');
    this.#paneId = paneId;
    this.#session = session;
    this.#directory = directory;
    this.#paneManager = paneManager;
    this.#stats = stats;
    this.#preferences = preferences;
  }

  /**
   * Tab title.
   * @returns {string} Title of the open conversation, or "New chat".
   */
  get title() {
    const conversationId = this.#session.openConversationId;
    return conversationId ? this.#directory.titleOf(conversationId) : 'New chat';
  }

  /**
   * Whether the tab offers a close button.
   * @returns {boolean} True while other panes exist.
   */
  canClose() {
    return this.#paneManager.paneCount > 1;
  }

  /**
   * Closes this pane.
   * @returns {void}
   */
  close() {
    this.#paneManager.closePane(this.#paneId);
  }

  /**
   * HTML of the panel body: side containers for sub-panes around the message list.
   * @returns {string} The layout.
   */
  createBodyHtml() {
    return `
      <div class="claude-plus-chat-layout">
        <div class="claude-plus-chat-layout__side" data-name="leftSide"></div>
        <div class="claude-plus-chat-layout__center">
          <div class="claude-plus-chat-layout__top" data-name="topSide"></div>
          <div class="claude-plus-scrollable claude-plus-fill-remaining claude-plus-message-list" data-name="messageList"></div>
        </div>
        <div class="claude-plus-chat-layout__side" data-name="rightSide"></div>
      </div>`;
  }

  /**
   * Creates the message list, focuses the pane on interaction and follows focus and visibility changes.
   * @returns {void}
   */
  bindEvents() {
    this.#messageListView = new MessageListView(this, this.elements.messageList, this.#session);
    this.element.addEventListener('mousedown', () => this.#paneManager.focusPane(this.#paneId));
    this.element.addEventListener('focusin', () => this.#paneManager.focusPane(this.#paneId));
    this.listenTo(this.#paneManager, 'focus', () => this.#renderFocus());
    this.listenTo(this.#paneManager, 'visiblePanes', () => this.#renderFocus());
  }

  /**
   * Renders the focus markers and the messages.
   * @returns {void}
   */
  render() {
    this.#renderFocus();
    this.#messageListView.render();
  }

  /**
   * Opens a sub-pane on the right edge, unless one of that kind is already open.
   * @param {string} kind 'files' or 'sources'.
   * @returns {void}
   */
  openSubPane(kind) {
    if (this.#subPanes.has(kind)) return;
    const subPane = new ConversationSubPane({
      kind,
      session: this.#session,
      stats: this.#stats,
      preferences: this.#preferences,
      onClose: closedKind => this.#closeSubPane(closedKind),
      onMove: (movedKind, edge) => this.#dockSubPane(movedKind, edge),
    });
    this.#subPanes.set(kind, subPane);
    this.#dockSubPane(kind, 'right');
  }

  /**
   * Disposes the sub-panes and ends the subscriptions.
   * @returns {void}
   */
  dispose() {
    this.#subPanes.forEach(subPane => subPane.dispose());
    this.#subPanes.clear();
    super.dispose();
  }

  /**
   * Moves a sub-pane to an edge of the pane.
   * @param {string} kind Sub-pane kind.
   * @param {string} edge 'left', 'top' or 'right'.
   * @returns {void}
   */
  #dockSubPane(kind, edge) {
    const sideElements = { left: this.elements.leftSide, top: this.elements.topSide, right: this.elements.rightSide };
    sideElements[edge].append(this.#subPanes.get(kind).element);
  }

  /**
   * Closes a sub-pane.
   * @param {string} kind Sub-pane kind.
   * @returns {void}
   */
  #closeSubPane(kind) {
    this.#subPanes.get(kind).dispose();
    this.#subPanes.delete(kind);
  }

  /**
   * Marks the pane while it is the active chat, and shows the green border only while more than
   * one chat pane is visible.
   * @returns {void}
   */
  #renderFocus() {
    const isActive = this.#paneManager.focusedPaneId === this.#paneId;
    this.element.classList.toggle('claude-plus-panel--focused', isActive);
    this.element.classList.toggle('claude-plus-panel--active-among-several', isActive && this.#paneManager.hasSeveralVisiblePanes);
  }
}
