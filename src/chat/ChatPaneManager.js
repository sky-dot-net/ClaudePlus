import { ChatPanel } from '../ui/panels/ChatPanel.js';
import { ChatSession } from './ChatSession.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { STORAGE_KEYS } from '../config/STORAGE_KEYS.js';

/**
 * Owns the chat panes: creates, restores, focuses and closes them, and remembers which
 * conversation each one shows. The focused pane is the one the sidebar, the URL and the export act on.
 * @fires ChatPaneManager#focus The focused pane changed.
 * @fires ChatPaneManager#paneConversations A pane opened another conversation; payload is the pane id.
 * @fires ChatPaneManager#conversationLoaded A pane fetched a conversation; payload is the ApiConversation.
 * @fires ChatPaneManager#rateLimits A pane received usage windows; payload is RateLimits.
 * @fires ChatPaneManager#visiblePanes Whether more than one chat pane is visible changed.
 */
export class ChatPaneManager extends EventEmitter {
  /**
   * API client.
   * @type {ClaudeApi}
   */
  #api;

  /**
   * Shared model options.
   * @type {ComposerSettings}
   */
  #settings;

  /**
   * Shared conversation list.
   * @type {ConversationDirectory}
   */
  #directory;

  /**
   * Storage for the open panes.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Conversation statistics, for the panes' sub-panes.
   * @type {StatsIndex}
   */
  #stats;

  /**
   * Fills a widget's placeholder slot with its real, extracted card.
   * @type {WidgetExtractor}
   */
  #widgetExtractor;

  /**
   * Whether more than one chat pane is visible at the moment.
   * @type {boolean}
   */
  #hasSeveralVisiblePanes = false;

  /**
   * Session and panel of every pane, by pane id, in creation order.
   * @type {Map<string, {session: ChatSession, panel: ChatPanel}>}
   */
  #panes = new Map();

  /**
   * Conversations to reopen in restored panes once the data has loaded, by pane id.
   * @type {Map<string, string>}
   */
  #conversationsToRestore = new Map();

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
   * Creates the manager without any pane.
   * @param {object} services Shared services.
   * @param {ClaudeApi} services.api API client.
   * @param {ComposerSettings} services.settings Shared model options.
   * @param {ConversationDirectory} services.directory Shared conversation list.
   * @param {Preferences} services.preferences Storage for the open panes and table settings.
   * @param {StatsIndex} services.stats Conversation statistics, for the panes' sub-panes.
   * @param {WidgetExtractor} services.widgetExtractor Fills a widget's placeholder slot with its real, extracted card.
   */
  constructor({ api, settings, directory, preferences, stats, widgetExtractor }) {
    super();
    this.#api = api;
    this.#settings = settings;
    this.#directory = directory;
    this.#preferences = preferences;
    this.#stats = stats;
    this.#widgetExtractor = widgetExtractor;
    directory.subscribe('conversationDeleted', conversationId => this.#closeDeletedConversation(conversationId));
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
   * Whether more than one chat pane is visible at the moment.
   * @returns {boolean} True with two or more visible chat panes.
   */
  get hasSeveralVisiblePanes() {
    return this.#hasSeveralVisiblePanes;
  }

  /**
   * Whether an id belongs to a chat pane.
   * @param {string} panelId Panel id.
   * @returns {boolean} True for ids starting with "chat-".
   */
  static isPaneId(panelId) {
    return String(panelId).startsWith('chat-');
  }

  /**
   * Which border a chat pane's tab and content should show, so its tab strip, frame and content
   * all agree: the focused pane gets the active (green) border, every other one a faint
   * theme-aware border, both only while more than one chat pane is visible. An id that isn't a
   * chat pane, or a chat pane while only one is visible, gets none.
   * @param {string} panelId Panel id.
   * @returns {?('active'|'inactive')} The border kind, or null for none.
   */
  borderKindOf(panelId) {
    if (!ChatPaneManager.isPaneId(panelId) || !this.#hasSeveralVisiblePanes) return null;
    return this.#focusedPaneId === panelId ? 'active' : 'inactive';
  }

  /**
   * Records which panels are visible after a layout and announces when the "several chat panes
   * visible" state changes.
   * @param {Set<string>} visiblePanelIds Ids of the visible panels.
   * @returns {void}
   */
  updateVisiblePanels(visiblePanelIds) {
    const hasSeveral = this.paneIds.filter(paneId => visiblePanelIds.has(paneId)).length > 1;
    if (hasSeveral === this.#hasSeveralVisiblePanes) return;
    this.#hasSeveralVisiblePanes = hasSeveral;
    this.publish('visiblePanes');
  }

  /**
   * Opens a new, empty chat as a tab of a zone and focuses it.
   * @param {string} leafId Zone id.
   * @returns {void}
   */
  openPaneInZone(leafId) {
    const paneId = ChatPaneManager.#createPaneId();
    const pane = this.#createPane(paneId);
    this.#workspace.addPanelToZone(paneId, pane.panel, leafId);
    this.focusPane(paneId);
    this.#savePanes();
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
   * Recreates the panes stored by the last visit, or one empty pane. Focuses the pane that showed
   * the preferred conversation, otherwise the first one. Their conversations are reopened later by
   * openRestoredConversations.
   * @param {?string} preferredConversationId Conversation in the URL, or null.
   * @returns {void}
   */
  restorePanes(preferredConversationId) {
    const storedPanes = ChatPaneManager.#validStoredPanes(this.#preferences.readJson(STORAGE_KEYS.chatPanes));
    const panes = storedPanes.length ? storedPanes : [{ paneId: ChatPaneManager.#createPaneId(), conversationId: null }];
    panes.forEach(pane => this.#restorePane(pane));
    const preferredPane = panes.find(pane => pane.conversationId !== null && pane.conversationId === preferredConversationId);
    this.#focusedPaneId = (preferredPane || panes[0]).paneId;
  }

  /**
   * The panel of every pane, for docking.
   * @returns {Array<[string, ChatPanel]>} [pane id, panel] pairs.
   */
  panelEntries() {
    return [...this.#panes].map(([paneId, pane]) => [paneId, pane.panel]);
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
   * Reopens the stored conversations of every restored pane except the focused one, whose
   * conversation comes from the URL.
   * @returns {void}
   */
  openRestoredConversations() {
    this.#conversationsToRestore.delete(this.#focusedPaneId);
    this.#conversationsToRestore.forEach((conversationId, paneId) => this.#panes.get(paneId).session.openConversation(conversationId));
    this.#conversationsToRestore.clear();
  }

  /**
   * Opens a new pane next to the focused one and focuses it.
   * @param {?string} conversationId Conversation to show, or null for a new chat.
   * @returns {void}
   */
  openPane(conversationId) {
    const paneId = ChatPaneManager.#createPaneId();
    const pane = this.#createPane(paneId);
    this.#workspace.addPanel(paneId, pane.panel, this.#focusedPaneId);
    this.focusPane(paneId);
    if (conversationId) pane.session.openConversation(conversationId);
    this.#savePanes();
  }

  /**
   * Opens a conversation as a new pane docked exactly where a drag was released, instead of always
   * beside the focused pane. Used to compose several chats side by side without switching between
   * them or mixing their context.
   * @param {string} conversationId Conversation to show.
   * @param {DropTarget} dropTarget Where to dock the new pane.
   * @returns {void}
   */
  openPaneAt(conversationId, dropTarget) {
    const paneId = ChatPaneManager.#createPaneId();
    const pane = this.#createPane(paneId);
    this.#workspace.addPanelAt(paneId, pane.panel, dropTarget);
    this.focusPane(paneId);
    pane.session.openConversation(conversationId);
    this.#savePanes();
  }

  /**
   * Starts dragging a conversation out of the sidebar; releasing over a valid drop target opens it
   * as a new pane docked there.
   * @param {MouseEvent} startEvent The mousedown that starts the drag.
   * @param {string} conversationId Conversation to open on drop.
   * @param {string} label Text shown in the floating drag label.
   * @returns {void}
   */
  beginDragToOpenPane(startEvent, conversationId, label) {
    this.#workspace.beginExternalDrag(startEvent, label, dropTarget => this.openPaneAt(conversationId, dropTarget));
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
   * Creates a pane from its stored state, remembering its conversation for later.
   * @param {{paneId: string, conversationId: ?string}} storedPane Stored pane.
   * @returns {void}
   */
  #restorePane({ paneId, conversationId }) {
    this.#createPane(paneId);
    if (conversationId) this.#conversationsToRestore.set(paneId, conversationId);
  }

  /**
   * Creates a pane's session and panel and forwards the session's events.
   * @param {string} paneId Pane id.
   * @returns {{session: ChatSession, panel: ChatPanel}} The pane.
   */
  #createPane(paneId) {
    const session = new ChatSession(this.#api, this.#settings, this.#directory);
    const panel = new ChatPanel({
      paneId, session, directory: this.#directory, paneManager: this, stats: this.#stats, preferences: this.#preferences, widgetExtractor: this.#widgetExtractor,
    });
    session.subscribe('openConversation', () => this.#onPaneConversationChanged(paneId));
    session.subscribe('conversationLoaded', conversation => this.publish('conversationLoaded', conversation));
    session.subscribe('rateLimits', limits => this.publish('rateLimits', limits));
    const pane = { session, panel };
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
    for (const pane of this.#panes.values()) {
      if (pane.session.openConversationId === conversationId) pane.session.startNewConversation();
    }
  }

  /**
   * Stores every pane and its conversation.
   * @returns {void}
   */
  #savePanes() {
    this.#preferences.writeJson(STORAGE_KEYS.chatPanes, this.storedPanes());
  }

  /**
   * Creates a unique pane id.
   * @returns {string} An id starting with "chat-".
   */
  static #createPaneId() {
    return `chat-${crypto.randomUUID()}`;
  }

  /**
   * The well-formed entries of a stored pane list.
   * @param {*} storedPanes Parsed stored value.
   * @returns {Array<{paneId: string, conversationId: ?string}>} Valid panes; empty when nothing valid is stored.
   */
  static #validStoredPanes(storedPanes) {
    return Array.isArray(storedPanes) ? storedPanes.filter(ChatPaneManager.#isValidStoredPane) : [];
  }

  /**
   * Whether a stored pane entry is well formed.
   * @param {*} storedPane Stored entry.
   * @returns {boolean} True for an object with a "chat-" pane id and a string or null conversation id.
   */
  static #isValidStoredPane(storedPane) {
    return Boolean(storedPane) && String(storedPane.paneId).startsWith('chat-') && (storedPane.conversationId === null || typeof storedPane.conversationId === 'string');
  }
}
