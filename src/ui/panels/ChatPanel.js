import { ConversationStatsSubPane } from './ConversationStatsSubPane.js';
import { ConversationSubPane } from './ConversationSubPane.js';
import { MessageListView } from './MessageListView.js';
import { MessageToolStepsPane } from './MessageToolStepsPane.js';
import { Panel } from './Panel.js';
import { STORAGE_KEYS } from '../../config/STORAGE_KEYS.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import stylesheet from './ChatPanel.css';

StyleRegistry.register(stylesheet);

/**
 * A chat pane: one session's messages, plus optional sub-panes listing the conversation's files
 * and web sources docked to its left, top or right edge. Its tab shows the conversation title; it
 * becomes the active chat when clicked, and gets a faint green border while it is active and more
 * than one chat pane is visible.
 */
export class ChatPanel extends Panel {
  /**
   * Edge a sub-pane docks to when the open conversation has no remembered choice.
   * @type {string}
   */
  static #DEFAULT_EDGE = 'right';

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
   * Fills a widget's placeholder slot with its real, extracted card.
   * @type {WidgetExtractor}
   */
  #widgetExtractor;

  /**
   * The message list.
   * @type {?MessageListView}
   */
  #messageListView = null;

  /**
   * Open sub-panes by kind: 'files' and 'sources' are ConversationSubPane, 'stats' (this
   * conversation's own usage stats) is a ConversationStatsSubPane, 'toolSteps' (a message's
   * thinking and tool-call steps) is a MessageToolStepsPane.
   * @type {Map<string, ConversationSubPane|ConversationStatsSubPane|MessageToolStepsPane>}
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
   * @param {WidgetExtractor} services.widgetExtractor Fills a widget's placeholder slot with its real, extracted card.
   */
  constructor({ paneId, session, directory, paneManager, stats, preferences, widgetExtractor }) {
    super('Chat');
    this.#paneId = paneId;
    this.#session = session;
    this.#directory = directory;
    this.#paneManager = paneManager;
    this.#stats = stats;
    this.#preferences = preferences;
    this.#widgetExtractor = widgetExtractor;
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
    this.#messageListView = new MessageListView(this, this.elements.messageList, this.#session, message => this.#showToolSteps(message), this.#widgetExtractor);
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
   * Opens a sub-pane on the right edge, or closes it if one of that kind is already open.
   * @param {string} kind 'files', 'sources' or 'stats'.
   * @returns {void}
   */
  openSubPane(kind) {
    if (this.#subPanes.has(kind)) {
      this.#closeSubPane(kind);
      return;
    }
    this.#subPanes.set(kind, this.#createSubPane(kind));
    this.#dockSubPane(kind, this.#storedSubPaneEdge(kind));
  }

  /**
   * Builds a sub-pane of a kind: the conversation-scoped stats view, or the files/sources table.
   * @param {string} kind 'files', 'sources' or 'stats'.
   * @returns {ConversationSubPane|ConversationStatsSubPane} The sub-pane.
   */
  #createSubPane(kind) {
    if (kind === 'stats') {
      return new ConversationStatsSubPane({
        session: this.#session,
        stats: this.#stats,
        onClose: () => this.#closeSubPane(kind),
        onMove: edge => this.#dockSubPane(kind, edge),
      });
    }
    return new ConversationSubPane({
      kind,
      session: this.#session,
      stats: this.#stats,
      preferences: this.#preferences,
      onClose: closedKind => this.#closeSubPane(closedKind),
      onMove: (movedKind, edge) => this.#dockSubPane(movedKind, edge),
    });
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
    this.#saveSubPaneEdge(kind, edge);
  }

  /**
   * Remembers a sub-pane's dock edge for the open conversation, so it reopens there next time;
   * skipped for a chat that hasn't been saved yet.
   * @param {string} kind Sub-pane kind.
   * @param {string} edge 'left', 'top' or 'right'.
   * @returns {void}
   */
  #saveSubPaneEdge(kind, edge) {
    const conversationId = this.#session.openConversationId;
    if (!conversationId) return;
    const stored = this.#preferences.readJson(STORAGE_KEYS.subPaneEdges) ?? {};
    stored[conversationId] = { ...stored[conversationId], [kind]: edge };
    this.#preferences.writeJson(STORAGE_KEYS.subPaneEdges, stored);
  }

  /**
   * The open conversation's remembered dock edge for a sub-pane kind.
   * @param {string} kind Sub-pane kind.
   * @returns {string} 'left', 'top' or 'right'; the default when unset or the chat is new.
   */
  #storedSubPaneEdge(kind) {
    const conversationId = this.#session.openConversationId;
    const stored = conversationId ? this.#preferences.readJson(STORAGE_KEYS.subPaneEdges)?.[conversationId] : null;
    return stored?.[kind] ?? ChatPanel.#DEFAULT_EDGE;
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
   * Shows a message's thinking and tool-call steps: opens the tool-steps sub-pane if it's closed,
   * swaps its content in place if it's already open for a different message, or closes it if it's
   * already showing this one.
   * @param {ChatMessage} message The message whose steps to show.
   * @returns {void}
   */
  #showToolSteps(message) {
    const existing = this.#subPanes.get('toolSteps');
    if (existing?.messageId === message.id) {
      this.#closeSubPane('toolSteps');
      return;
    }
    if (existing) {
      existing.showMessage(message);
      return;
    }
    const pane = new MessageToolStepsPane({
      message,
      onClose: () => this.#closeSubPane('toolSteps'),
      onMove: edge => this.#dockSubPane('toolSteps', edge),
    });
    this.#subPanes.set('toolSteps', pane);
    this.#dockSubPane('toolSteps', this.#storedSubPaneEdge('toolSteps'));
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
