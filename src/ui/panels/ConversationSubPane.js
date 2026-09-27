import { ColumnTable } from '../tables/ColumnTable.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { SubPaneHeader } from './SubPaneHeader.js';
import { createElement } from '../../dom/createElement.js';
import { createFileColumns } from '../tables/createFileColumns.js';
import { createSourceColumns } from '../tables/createSourceColumns.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import stylesheet from './ConversationSubPane.css';

StyleRegistry.register(stylesheet);

/**
 * A sub-pane inside a chat pane listing the web sources or files of that pane's conversation.
 * It can be docked to the pane's left, top or right edge and closed. Double-clicking a row jumps
 * to the message it came from.
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
      columns: () => createSourceColumns(false),
      rowsOf: (aggregate, conversationId) => aggregate.sources.filter(source => source.conversationId === conversationId),
    },
    files: {
      title: '📁 Files in this chat',
      tableId: 'conversationFiles',
      columns: () => createFileColumns(false),
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
   * @param {function(string): void} options.onJumpToMessage Called with a message id when a row tied
   * to one is double-clicked.
   */
  constructor({ kind, session, stats, preferences, onClose, onMove, onJumpToMessage }) {
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
      rowAttributes: row => `data-message-id="${escapeHtml(row.messageId ?? '')}"`,
      emptyText: 'Nothing recorded for this chat yet.',
    });
    this.#table.bodyElement.addEventListener('dblclick', event => ConversationSubPane.#onRowDoubleClick(event, onJumpToMessage));
    this.#element.querySelector('header').addEventListener('click', event => SubPaneHeader.onClick(event, () => onClose(kind), edge => onMove(kind, edge)));
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
   * Jumps to the message a double-clicked row belongs to, if it's tied to one - a chat-agnostic
   * folder summary row (a file or source) rather than a specific occurrence never carries one.
   * @param {MouseEvent} event The double-click.
   * @param {function(string): void} onJumpToMessage Called with a message id.
   * @returns {void}
   */
  static #onRowDoubleClick(event, onJumpToMessage) {
    const messageId = event.target.closest('[data-message-id]')?.dataset.messageId;
    if (messageId) onJumpToMessage(messageId);
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
    return `${SubPaneHeader.html(title)}<div class="claude-plus-table-host" data-name="tableHost"></div>`;
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
