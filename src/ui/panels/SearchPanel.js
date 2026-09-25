import { ColumnTable } from '../tables/ColumnTable.js';
import { LIMITS } from '../../config/LIMITS.js';
import { Panel } from './Panel.js';
import { SearchEngine } from '../../search/SearchEngine.js';
import { SearchQuery } from '../../search/SearchQuery.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import { formatTimestamp } from '../../time/formatTimestamp.js';
import { toEpochMs } from '../../time/toEpochMs.js';
import stylesheet from './SearchPanel.css';

StyleRegistry.register(stylesheet);

/**
 * Structured search over chats, files, web sources and tool uses, e.g. `file:*.pdf`,
 * `outlet:*nbc*`, `tool:web_search`, `chat:budget`, `after:2026-01-01`. Results show what matched,
 * where, when and why; clicking one opens its conversation in the active chat.
 */
export class SearchPanel extends Panel {
  /**
   * Conversation statistics.
   * @type {StatsIndex}
   */
  #stats;

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
   * Table settings storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * The current query.
   * @type {SearchQuery}
   */
  #query = SearchQuery.parse('');

  /**
   * The results table; created with the DOM.
   * @type {?ColumnTable}
   */
  #table = null;

  /**
   * Creates the panel.
   * @param {object} services Panel dependencies.
   * @param {StatsIndex} services.stats Conversation statistics.
   * @param {ConversationDirectory} services.directory Shared conversation list.
   * @param {Router} services.router Navigation.
   * @param {Preferences} services.preferences Table settings storage.
   */
  constructor({ stats, directory, router, preferences }) {
    super('Search');
    this.#stats = stats;
    this.#directory = directory;
    this.#router = router;
    this.#preferences = preferences;
  }

  /**
   * HTML of the panel body.
   * @returns {string} Query input, syntax hint and results host.
   */
  createBodyHtml() {
    return `
      <input class="claude-plus-search-input" data-name="queryInput" type="text" placeholder="Search… e.g. file:*.pdf outlet:*nbc*" />
      <div class="claude-plus-hint">Qualifiers: chat: file: source: outlet: tool: after:YYYY-MM-DD before:YYYY-MM-DD — * is a wildcard, quote values with spaces.</div>
      <div class="claude-plus-table-host" data-name="tableHost"></div>`;
  }

  /**
   * Creates the results table, wires the query and result clicks, and follows data changes.
   * @returns {void}
   */
  bindEvents() {
    this.#table = new ColumnTable({
      container: this.elements.tableHost,
      tableId: 'searchResults',
      columns: SearchPanel.#columns(),
      preferences: this.#preferences,
      defaultSort: { column: 'date', direction: -1 },
      rowAttributes: item => `class="claude-plus-search-result" data-conversation-id="${escapeHtml(item.conversationId)}"`,
      emptyText: 'No results.',
      maxRenderedRows: LIMITS.searchResults,
    });
    this.elements.queryInput.addEventListener('input', () => this.#runQuery(this.elements.queryInput.value));
    this.#table.bodyElement.addEventListener('click', event => this.#onResultClick(event));
    this.listenTo(this.#stats, 'aggregate', () => this.render());
    this.listenTo(this.#directory, 'conversations', () => this.render());
  }

  /**
   * Shows the results of the current query; none for an empty query.
   * @returns {void}
   */
  render() {
    this.#table.setRows(this.#query.isEmpty ? [] : SearchEngine.find(this.#query, this.#stats.aggregate, this.#directory.conversations));
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
   * Columns of the results table.
   * @returns {TableColumn[]} Match, kind, chat, date and reason.
   */
  static #columns() {
    return [
      { id: 'match', label: 'Match', isAlwaysVisible: true, sortValue: item => item.text.toLowerCase(), cellHtml: item => escapeHtml(item.text) },
      { id: 'kind', label: 'Kind', isVisibleByDefault: true, filter: 'values', sortValue: item => SearchEngine.kindLabel(item.kind), cellHtml: item => escapeHtml(SearchEngine.kindLabel(item.kind)) },
      { id: 'conversation', label: 'Chat', isVisibleByDefault: true, filter: 'values', sortValue: item => item.conversationTitle.toLowerCase(), filterValue: item => item.conversationTitle, cellHtml: item => escapeHtml(item.conversationTitle) },
      { id: 'date', label: 'Date', isVisibleByDefault: true, filter: 'date', sortValue: item => toEpochMs(item.timestamp), filterValue: item => item.timestamp, cellHtml: item => escapeHtml(formatTimestamp(item.timestamp)) },
      { id: 'reason', label: 'Why', isVisibleByDefault: true, sortValue: item => item.reason, cellHtml: item => escapeHtml(item.reason) },
    ];
  }

  /**
   * Parses new query text and shows its results.
   * @param {string} text Query text.
   * @returns {void}
   */
  #runQuery(text) {
    this.#query = SearchQuery.parse(text);
    this.render();
  }

  /**
   * Opens the clicked result's conversation in the active chat.
   * @param {MouseEvent} event Click in the results body.
   * @returns {void}
   */
  #onResultClick(event) {
    const row = event.target.closest('[data-conversation-id]');
    if (row) this.#router.openConversation(row.dataset.conversationId);
  }
}
