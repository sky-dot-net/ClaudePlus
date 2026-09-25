import { ColumnTable } from '../tables/ColumnTable.js';
import { ConfirmDialog } from '../dialogs/ConfirmDialog.js';
import { LOG_PREFIX } from '../../config/LOG_PREFIX.js';
import { Panel } from './Panel.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { UNTITLED } from '../../config/UNTITLED.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import { formatDay } from '../../time/formatDay.js';
import { toEpochMs } from '../../time/toEpochMs.js';
import stylesheet from './ConversationListPanel.css';

StyleRegistry.register(stylesheet);

/**
 * Conversation list as a column table, with a quick title search, open in a new pane, delete, and
 * dragging an entry out to open it as a new pane docked where it is dropped. Clicking a
 * conversation opens it in the focused chat pane.
 */
export class ConversationListPanel extends Panel {
  /**
   * Shared conversation list.
   * @type {ConversationDirectory}
   */
  #directory;

  /**
   * Navigation.
   * @type {Router}
   */
  #router;

  /**
   * Chat panes.
   * @type {ChatPaneManager}
   */
  #paneManager;

  /**
   * Conversation statistics, for the turn and file columns.
   * @type {StatsIndex}
   */
  #stats;

  /**
   * Table settings storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Lower-case quick search text.
   * @type {string}
   */
  #searchText = '';

  /**
   * The conversation table; created with the DOM.
   * @type {?ColumnTable}
   */
  #table = null;

  /**
   * Handler per button data-action value inside a conversation row.
   * @type {Map<string, function(HTMLElement): void>}
   */
  #rowActionHandlers = new Map([
    ['delete', row => this.#confirmAndDelete(row)],
    ['openInNewPane', row => this.#paneManager.openPane(row.dataset.conversationId)],
  ]);

  /**
   * Creates the panel.
   * @param {object} services Panel dependencies.
   * @param {ConversationDirectory} services.directory Shared conversation list.
   * @param {Router} services.router Navigation.
   * @param {ChatPaneManager} services.paneManager Chat panes.
   * @param {StatsIndex} services.stats Conversation statistics, for the turn and file columns.
   * @param {Preferences} services.preferences Table settings storage.
   */
  constructor({ directory, router, paneManager, stats, preferences }) {
    super('Chats');
    this.#directory = directory;
    this.#router = router;
    this.#paneManager = paneManager;
    this.#stats = stats;
    this.#preferences = preferences;
  }

  /**
   * HTML of the panel body.
   * @returns {string} Quick search box and table host.
   */
  createBodyHtml() {
    return `
      <input class="claude-plus-search-input" data-name="searchInput" type="text" placeholder="Search chats…" />
      <div class="claude-plus-table-host" data-name="tableHost"></div>`;
  }

  /**
   * Creates the table, wires search, row clicks and drags, and follows list, focus, pane and stats changes.
   * @returns {void}
   */
  bindEvents() {
    this.#table = new ColumnTable({
      container: this.elements.tableHost,
      tableId: 'conversations',
      columns: this.#columns(),
      preferences: this.#preferences,
      defaultSort: { column: 'date', direction: -1 },
      rowAttributes: conversation => this.#rowAttributes(conversation),
      emptyText: 'No conversations.',
    });
    this.elements.searchInput.addEventListener('input', () => this.#applySearch(this.elements.searchInput.value));
    this.#table.bodyElement.addEventListener('mousedown', event => this.#onRowPress(event));
    this.#table.bodyElement.addEventListener('click', event => this.#onRowClick(event));
    this.listenTo(this.#directory, 'conversations', () => this.render());
    this.listenTo(this.#paneManager, 'focus', () => this.render());
    this.listenTo(this.#paneManager, 'paneConversations', () => this.render());
    this.listenTo(this.#stats, 'aggregate', () => this.render());
  }

  /**
   * Shows the conversations matching the quick search.
   * @returns {void}
   */
  render() {
    this.#table.setRows(this.#directory.conversations.filter(conversation => this.#matchesSearch(conversation)));
  }

  /**
   * Closes the table's typeahead and ends the subscriptions.
   * @returns {void}
   */
  dispose() {
    if (this.#table) this.#table.dispose();
    super.dispose();
  }

  /**
   * Moves keyboard focus to the search box and selects its text.
   * @returns {void}
   */
  focusSearch() {
    this.elements.searchInput.focus();
    this.elements.searchInput.select();
  }

  /**
   * The table's columns: name (always shown), date, turns, files, and the row buttons.
   * @returns {TableColumn[]} The columns.
   */
  #columns() {
    return [
      { id: 'name', label: 'Name', isAlwaysVisible: true, filter: 'values', sortValue: conversation => (conversation.name || '').toLowerCase(), filterValue: conversation => conversation.name || UNTITLED, cellHtml: conversation => `<span class="claude-plus-conversation__title">${escapeHtml(conversation.name || UNTITLED)}</span>` },
      { id: 'date', label: 'Date', isVisibleByDefault: true, filter: 'date', sortValue: conversation => toEpochMs(conversation.updated_at), filterValue: conversation => conversation.updated_at, cellHtml: conversation => escapeHtml(formatDay(conversation.updated_at)) },
      { id: 'turns', label: 'Turns', sortValue: conversation => this.#indexedCount(conversation, 'promptCount'), cellHtml: conversation => this.#indexedCountHtml(conversation, 'promptCount') },
      { id: 'files', label: 'Files', sortValue: conversation => this.#indexedCount(conversation, 'fileCount'), cellHtml: conversation => this.#indexedCountHtml(conversation, 'fileCount') },
      { id: 'actions', label: '', isAlwaysVisible: true, isNotSortable: true, sortValue: () => 0, cellHtml: () => ConversationListPanel.#actionButtonsHtml() },
    ];
  }

  /**
   * A per-conversation count from the stats index.
   * @param {ConversationListing} conversation The conversation.
   * @param {string} field 'promptCount' or 'fileCount'.
   * @returns {number} The count, or -1 while the conversation isn't indexed, so unindexed ones sort together.
   */
  #indexedCount(conversation, field) {
    const counts = this.#stats.aggregate.perConversation.get(conversation.uuid);
    return counts ? counts[field] : -1;
  }

  /**
   * Cell HTML of a per-conversation count.
   * @param {ConversationListing} conversation The conversation.
   * @param {string} field 'promptCount' or 'fileCount'.
   * @returns {string} The count, or "–" while the conversation isn't indexed.
   */
  #indexedCountHtml(conversation, field) {
    const count = this.#indexedCount(conversation, field);
    return count < 0 ? '–' : String(count);
  }

  /**
   * Attributes of a conversation's row: its id and the modifier showing where it is open.
   * @param {ConversationListing} conversation The conversation.
   * @returns {string} The attributes.
   */
  #rowAttributes(conversation) {
    const modifier = ConversationListPanel.#stateModifier(conversation.uuid, this.#paneManager.focusedSession.openConversationId, this.#paneManager.openConversationIds());
    return `class="claude-plus-conversation${modifier}" data-conversation-id="${escapeHtml(conversation.uuid)}"`;
  }

  /**
   * Modifier class marking where a conversation is open.
   * @param {string} conversationId Conversation id.
   * @param {?string} focusedId Conversation of the focused pane.
   * @param {Set<string>} openIds Conversations open in any pane.
   * @returns {string} The active modifier, the open-elsewhere modifier, or an empty string.
   */
  static #stateModifier(conversationId, focusedId, openIds) {
    if (conversationId === focusedId) return ' claude-plus-conversation--active';
    return openIds.has(conversationId) ? ' claude-plus-conversation--open-elsewhere' : '';
  }

  /**
   * HTML of a row's buttons.
   * @returns {string} Open-in-new-pane and delete buttons.
   */
  static #actionButtonsHtml() {
    return `<span class="claude-plus-conversation__actions"><button class="claude-plus-conversation__action-button" data-action="openInNewPane" title="Open in new pane">⧉</button><button class="claude-plus-conversation__action-button" data-action="delete" title="Delete chat">🗑</button></span>`;
  }

  /**
   * Filters the list by title.
   * @param {string} text Search text.
   * @returns {void}
   */
  #applySearch(text) {
    this.#searchText = text.toLowerCase();
    this.render();
  }

  /**
   * Whether a conversation's title contains the quick search text.
   * @param {ConversationListing} conversation The conversation.
   * @returns {boolean} True when it matches or there is no search.
   */
  #matchesSearch(conversation) {
    return (conversation.name || '').toLowerCase().includes(this.#searchText);
  }

  /**
   * Starts dragging a conversation out of the list on a primary-button press away from its
   * buttons; releasing over a dock target opens it as a new pane docked there. A plain click still
   * reaches #onRowClick.
   * @param {MouseEvent} event Mouse press in the table body.
   * @returns {void}
   */
  #onRowPress(event) {
    const row = event.target.closest('[data-conversation-id]');
    if (event.button !== 0 || !row || event.target.closest('[data-action]')) return;
    const conversationId = row.dataset.conversationId;
    this.#paneManager.beginDragToOpenPane(event, conversationId, this.#directory.titleOf(conversationId));
  }

  /**
   * Runs the clicked row button's action, or opens the clicked conversation in the focused pane.
   * @param {MouseEvent} event Click in the table body.
   * @returns {void}
   */
  #onRowClick(event) {
    const row = event.target.closest('[data-conversation-id]');
    if (!row) return;
    const button = event.target.closest('[data-action]');
    if (button) this.#rowActionHandlers.get(button.dataset.action)(row);
    else this.#router.openConversation(row.dataset.conversationId);
  }

  /**
   * Asks for confirmation, then deletes a conversation. The row is dimmed while deleting and
   * restored if deleting fails.
   * @param {HTMLElement} row The conversation's row.
   * @returns {Promise<void>} Resolves once deleted, declined or failed.
   */
  async #confirmAndDelete(row) {
    const conversationId = row.dataset.conversationId;
    const isConfirmed = await ConfirmDialog.ask(`Delete "${this.#directory.titleOf(conversationId)}"? This cannot be undone.`, 'Delete');
    if (!isConfirmed) return;
    row.classList.add('claude-plus-pending');
    try {
      await this.#directory.deleteConversation(conversationId);
    } catch (error) {
      console.warn(LOG_PREFIX, 'delete failed', error);
      row.classList.remove('claude-plus-pending');
    }
  }
}
