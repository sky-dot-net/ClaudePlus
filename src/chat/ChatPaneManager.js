import { ChatPaneBorders } from './panes/ChatPaneBorders.js';
import { ChatPaneFactory } from './panes/ChatPaneFactory.js';
import { ChatPaneRestorer } from './panes/ChatPaneRestorer.js';
import { ChatPaneStore } from './panes/ChatPaneStore.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { createChatPaneId } from './panes/createChatPaneId.js';
import { isChatPaneId } from './panes/isChatPaneId.js';

/**
 * Owns the chat panes: creates, docks, focuses and closes them, and remembers which conversation
 * each one shows. The focused pane is the one the sidebar, the URL and the export act on.
 * @fires ChatPaneManager#focus The focused pane changed.
 * @fires ChatPaneManager#paneConversations A pane opened another conversation; payload is the pane id.
 * @fires ChatPaneManager#conversationLoaded A pane fetched a conversation; payload is the ApiConversation.
 * @fires ChatPaneManager#rateLimits A pane received usage windows; payload is RateLimits.
 * @fires ChatPaneManager#visiblePanes Whether more than one chat pane is visible changed.
 */
export class ChatPaneManager extends EventEmitter {
  /**
   * Session and panel of every pane, by pane id, in creation order.
   * @type {Map<string, {session: ChatSession, panel: ChatPanel}>}
   */
  #panes = new Map();

  /**
   * Id of the focused pane.
   * @type {?string}
   */
  #focusedPaneId = null;

  /**
   * Workspace the panes are docked in; set by attachWorkspace.
   * @type {?DockWorkspace}
   */
  #workspace = null;

  /**
   * Builds each pane's session and panel.
   * @type {ChatPaneFactory}
   */
  #factory;

  /**
   * Stores the open panes across visits.
   * @type {ChatPaneStore}
   */
  #store;

  /**
   * Recreates the stored panes.
   * @type {ChatPaneRestorer}
   */
  #restorer;

  /**
   * Decides each pane's border.
   * @type {ChatPaneBorders}
   */
  #borders = new ChatPaneBorders();

  /**
   * Creates the manager without any pane.
   * @param {object} services Shared services.
   * @param {ClaudeApi} services.api API client.
   * @param {ComposerSettings} services.settings Shared model options.
   * @param {CombinedConversationDirectory} services.directory Shared conversation list.
   * @param {Preferences} services.preferences Storage for the open panes and table settings.
   * @param {StatsIndex} services.stats Conversation statistics, for the panes' sub-panes.
   * @param {WidgetExtractor} services.widgetExtractor Fills a widget's placeholder slot with its real, extracted card.
   * @param {ImportedConversationStore} services.importedConversations Imported conversations, checked before the live API when opening one.
   */
  constructor(services) {
    super();
    this.#factory = new ChatPaneFactory(services, this, paneId => this.#onPaneConversationChanged(paneId));
    this.#store = new ChatPaneStore(services.preferences);
    this.#restorer = new ChatPaneRestorer(this.#store, paneId => this.#createPane(paneId));
    services.directory.subscribe('conversationDeleted', conversationId => this.#closeDeletedConversation(conversationId));
  }

  /**
   * Ids of all panes.
   * @returns {string[]} The ids, in creation order.
   */
  get paneIds() {
    return [...this.#panes.keys()];
  }

  /**
   * Number of open panes.
   * @returns {number} The count.
   */
  get paneCount() {
    return this.#panes.size;
  }

  /**
   * The focused pane.
   * @returns {string} Its id.
   */
  get focusedPaneId() {
    return this.#focusedPaneId;
  }

  /**
   * Session of the focused pane.
   * @returns {ChatSession} The session.
   */
  get focusedSession() {
    return this.#panes.get(this.#focusedPaneId).session;
  }

  /**
   * Panel of the focused pane.
   * @returns {ChatPanel} The panel.
   */
  get focusedPanel() {
    return this.#panes.get(this.#focusedPaneId).panel;
  }

  /**
   * Whether an id belongs to a chat pane.
   * @param {string} panelId Panel id.
   * @returns {boolean} True for ids starting with "chat-".
   */
  static isPaneId(panelId) {
    return isChatPaneId(panelId);
  }

  /**
   * Which border a chat pane's tab and content should show; see ChatPaneBorders.kindOf.
   * @param {string} panelId Panel id.
   * @returns {?('active'|'inactive')} The border kind, or null for none.
   */
  borderKindOf(panelId) {
    return this.#borders.kindOf(panelId, this.#focusedPaneId);
  }

  /**
   * Records which panels are visible after a layout and announces when the "several chat panes
   * visible" state changes.
   * @param {Set<string>} visiblePanelIds Ids of the visible panels.
   * @returns {void}
   */
  updateVisiblePanels(visiblePanelIds) {
    if (this.#borders.update(visiblePanelIds, this.paneIds)) this.publish('visiblePanes');
  }

  /**
   * Connects the workspace that new panes are docked in.
   * @param {DockWorkspace} workspace The workspace.
   * @returns {void}
   */
  attachWorkspace(workspace) {
    this.#workspace = workspace;
  }

  /**
   * Recreates the panes stored by the last visit, or one empty pane, and focuses the pane that
   * showed the preferred conversation, otherwise the first one. Their conversations are reopened
   * later by openRestoredConversations.
   * @param {?string} preferredConversationId Conversation in the URL, or null.
   * @returns {void}
   */
  restorePanes(preferredConversationId) {
    this.#focusedPaneId = this.#restorer.restore(preferredConversationId);
  }

  /**
   * Reopens the stored conversations of every restored pane except the focused one, whose
   * conversation comes from the URL.
   * @returns {void}
   */
  openRestoredConversations() {
    this.#restorer.openRemaining(this.#focusedPaneId);
  }

  /**
   * Creates a pane with a given id for a saved layout, without docking it, and opens its conversation.
   * @param {string} paneId Pane id from the layout.
   * @param {?string} conversationId Conversation to show, or null for a new chat.
   * @returns {ChatPanel} The pane's panel.
   */
  createPaneForLayout(paneId, conversationId) {
    const pane = this.#createPane(paneId);
    if (conversationId) pane.session.openConversation(conversationId);
    this.#savePanes();
    return pane.panel;
  }

  /**
   * Every pane with its conversation, as stored.
   * @returns {Array<{paneId: string, conversationId: ?string}>} The panes in creation order.
   */
  storedPanes() {
    return [...this.#panes].map(([paneId, pane]) => ({ paneId, conversationId: pane.session.openConversationId }));
  }

  /**
   * The panel of every pane, for docking.
   * @returns {Array<[string, ChatPanel]>} [pane id, panel] pairs.
   */
  panelEntries() {
    return [...this.#panes].map(([paneId, pane]) => [paneId, pane.panel]);
  }

  /**
   * Opens a new, empty chat as a tab of a zone and focuses it.
   * @param {string} leafId Zone id.
   * @returns {void}
   */
  openPaneInZone(leafId) {
    this.#openNewPane((paneId, panel) => this.#workspace.addPanelToZone(paneId, panel, leafId), null);
  }

  /**
   * Opens a new pane next to the focused one and focuses it.
   * @param {?string} conversationId Conversation to show, or null for a new chat.
   * @returns {void}
   */
  openPane(conversationId) {
    this.#openNewPane((paneId, panel) => this.#workspace.addPanel(paneId, panel, this.#focusedPaneId), conversationId);
  }

  /**
   * Starts dragging a conversation out of the sidebar; releasing over a valid drop target opens it
   * as a new pane docked exactly there, so several chats can be composed side by side.
   * @param {MouseEvent} startEvent The mousedown that starts the drag.
   * @param {string} conversationId Conversation to open on drop.
   * @param {string} label Text shown in the floating drag label.
   * @returns {void}
   */
  beginDragToOpenPane(startEvent, conversationId, label) {
    const openAt = dropTarget => this.#openNewPane((paneId, panel) => this.#workspace.addPanelAt(paneId, panel, dropTarget), conversationId);
    this.#workspace.beginExternalDrag(startEvent, label, openAt);
  }

  /**
   * Closes a pane, stopping its reply. The last remaining pane can't be closed.
   * @param {string} paneId Pane id.
   * @returns {void}
   */
  closePane(paneId) {
    if (this.#panes.size <= 1 || !this.#panes.has(paneId)) return;
    if (this.#focusedPaneId === paneId) this.focusPane(this.paneIds.find(id => id !== paneId));
    this.#panes.get(paneId).session.stopReply();
    this.#panes.delete(paneId);
    this.#workspace.removePanel(paneId);
    this.#savePanes();
  }

  /**
   * Makes a pane the focused one.
   * @param {string} paneId Pane id; unknown ids are ignored.
   * @returns {void}
   */
  focusPane(paneId) {
    if (this.#focusedPaneId === paneId || !this.#panes.has(paneId)) return;
    this.#focusedPaneId = paneId;
    this.publish('focus');
  }

  /**
   * Opens a conversation in the focused pane.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<void>} Resolves once it is shown.
   */
  openInFocusedPane(conversationId) {
    return this.focusedSession.openConversation(conversationId);
  }

  /**
   * Starts a new chat in the focused pane.
   * @returns {void}
   */
  startNewInFocusedPane() {
    this.focusedSession.startNewConversation();
  }

  /**
   * Conversations shown in any pane.
   * @returns {Set<string>} Their ids.
   */
  openConversationIds() {
    return new Set([...this.#panes.values()].map(pane => pane.session.openConversationId).filter(Boolean));
  }

  /**
   * Creates a pane, docks it, focuses it, opens its conversation and saves the panes.
   * @param {function(string, ChatPanel): void} dock Docks the new pane's panel in the workspace.
   * @param {?string} conversationId Conversation to show, or null for a new chat.
   * @returns {void}
   */
  #openNewPane(dock, conversationId) {
    const paneId = createChatPaneId();
    const pane = this.#createPane(paneId);
    dock(paneId, pane.panel);
    this.focusPane(paneId);
    if (conversationId) pane.session.openConversation(conversationId);
    this.#savePanes();
  }

  /**
   * Creates a pane and registers it.
   * @param {string} paneId Pane id.
   * @returns {{session: ChatSession, panel: ChatPanel}} The pane.
   */
  #createPane(paneId) {
    const pane = this.#factory.create(paneId);
    this.#panes.set(paneId, pane);
    return pane;
  }

  /**
   * Saves the panes and announces that a pane shows another conversation.
   * @param {string} paneId Pane id.
   * @returns {void}
   */
  #onPaneConversationChanged(paneId) {
    this.#savePanes();
    this.publish('paneConversations', paneId);
  }

  /**
   * Switches every pane showing a deleted conversation to a new chat.
   * @param {string} conversationId The deleted conversation.
   * @returns {void}
   */
  #closeDeletedConversation(conversationId) {
    [...this.#panes.values()]
      .filter(pane => pane.session.openConversationId === conversationId)
      .forEach(pane => pane.session.startNewConversation());
  }

  /**
   * Stores every pane and its conversation.
   * @returns {void}
   */
  #savePanes() {
    this.#store.write(this.storedPanes());
  }
}
