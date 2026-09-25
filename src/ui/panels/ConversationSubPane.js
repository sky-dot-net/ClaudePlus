import { ColumnTable } from '../tables/ColumnTable.js';
import { TableColumns } from '../tables/TableColumns.js';
import { createElement } from '../../dom/createElement.js';
import { escapeHtml } from '../../text/escapeHtml.js';

/**
 * A sub-pane inside a chat pane listing the web sources or files of that pane's conversation.
 * It can be docked to the pane's left, top or right edge and closed.
 */
export class ConversationSubPane {
  /**
   * Title, table id, columns and row source per kind.
   * @type {Readonly<Record<string, {title: string, tableId: string, columns: function(): TableColumn[], rowsOf: function(StatsAggregate, string): object[]}>>}
   */
  static #KINDS = Object.freeze({
    sources: {
      title: '🌐 Sources in this chat',
      tableId: 'conversationSources',
      columns: () => TableColumns.sources(false),
      rowsOf: (aggregate, conversationId) => aggregate.sources.filter(source => source.conversationId === conversationId),
    },
    files: {
      title: '📁 Files in this chat',
      tableId: 'conversationFiles',
      columns: () => TableColumns.files(false),
      rowsOf: (aggregate, conversationId) => ConversationSubPane.#folderFiles(aggregate, conversationId),
    },
  });

  /**
   * Kind of content: 'sources' or 'files'.
   * @type {string}
   */
  #kind;

  /**
   * Session whose conversation is shown.
   * @type {ChatSession}
   */
  #session;

  /**
   * Conversation statistics.
   * @type {StatsIndex}
   */
  #stats;

  /**
   * The sub-pane's root element.
   * @type {HTMLElement}
   */
  #element;

  /**
   * The table.
   * @type {ColumnTable}
   */
  #table;

  /**
   * Undoes the subscriptions.
   * @type {Array<function(): void>}
   */
  #unsubscribers = [];

  /**
   * Builds the sub-pane.
   * @param {object} options Sub-pane options.
   * @param {string} options.kind 'sources' or 'files'.
   * @param {ChatSession} options.session Session whose conversation is shown.
   * @param {StatsIndex} options.stats Conversation statistics.
   * @param {Preferences} options.preferences Table settings storage.
   * @param {function(string): void} options.onClose Called with the kind when × is clicked.
   * @param {function(string, string): void} options.onMove Called with the kind and 'left', 'top' or 'right' when an arrow is clicked.
   */
  constructor({ kind, session, stats, preferences, onClose, onMove }) {
    const definition = ConversationSubPane.#KINDS[kind];
    this.#kind = kind;
    this.#session = session;
    this.#stats = stats;
    this.#element = createElement('section', { className: 'claude-plus-subpane', innerHTML: ConversationSubPane.#bodyHtml(definition.title) });
    this.#table = new ColumnTable({
      container: this.#element.querySelector('[data-name="tableHost"]'),
      tableId: definition.tableId,
      columns: definition.columns(),
      preferences,
      defaultSort: { column: 'date', direction: -1 },
      rowAttributes: () => '',
      emptyText: 'Nothing recorded for this chat yet.',
    });
    this.#element.querySelector('header').addEventListener('click', event => ConversationSubPane.#onHeaderClick(event, kind, onClose, onMove));
    this.#unsubscribers.push(stats.subscribe('aggregate', () => this.render()), session.subscribe('openConversation', () => this.render()));
    this.render();
  }

  /**
   * The sub-pane's root element.
   * @returns {HTMLElement} The element.
   */
  get element() {
    return this.#element;
  }

  /**
   * Shows the rows of the session's current conversation.
   * @returns {void}
   */
  render() {
    const conversationId = this.#session.openConversationId;
    const rowsOf = ConversationSubPane.#KINDS[this.#kind].rowsOf;
    this.#table.setRows(conversationId ? rowsOf(this.#stats.aggregate, conversationId) : []);
  }

  /**
   * Ends the subscriptions and removes the sub-pane.
   * @returns {void}
   */
  dispose() {
    this.#unsubscribers.forEach(unsubscribe => unsubscribe());
    this.#table.dispose();
    this.#element.remove();
  }

  /**
   * HTML of the sub-pane: a header with title, dock arrows and close button, and the table host.
   * @param {string} title Header title.
   * @returns {string} The HTML.
   */
  static #bodyHtml(title) {
    return `
      <header class="claude-plus-subpane__header">
        <span class="claude-plus-subpane__title">${escapeHtml(title)}</span>
        <button class="claude-plus-subpane__button" data-edge="left" title="Dock left">←</button>
        <button class="claude-plus-subpane__button" data-edge="top" title="Dock top">↑</button>
        <button class="claude-plus-subpane__button" data-edge="right" title="Dock right">→</button>
        <button class="claude-plus-subpane__button" data-action="close" title="Close">×</button>
      </header>
      <div class="claude-plus-table-host" data-name="tableHost"></div>`;
  }

  /**
   * Runs the clicked header button: a dock arrow or close.
   * @param {MouseEvent} event Click in the header.
   * @param {string} kind The sub-pane's kind.
   * @param {function(string): void} onClose Close callback.
   * @param {function(string, string): void} onMove Redock callback.
   * @returns {void}
   */
  static #onHeaderClick(event, kind, onClose, onMove) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.edge) onMove(kind, button.dataset.edge);
    else onClose(kind);
  }

  /**
   * Files of one conversation.
   * @param {StatsAggregate} aggregate Current totals.
   * @param {string} conversationId Conversation id.
   * @returns {FileEntry[]} Its files, or none when it has no folder.
   */
  static #folderFiles(aggregate, conversationId) {
    const folder = aggregate.folders.find(candidate => candidate.conversationId === conversationId);
    return folder ? folder.files : [];
  }
}
