import { escapeHtml } from '../../text/escapeHtml.js';
import { fileExtension } from '../../text/fileExtension.js';
import { formatTimestamp } from '../../time/formatTimestamp.js';
import { toEpochMs } from '../../time/toEpochMs.js';

/**
 * Column definitions shared by the tables showing web sources and files.
 */
export class TableColumns {
  /**
   * Columns of a web source table.
   * @param {boolean} includesConversation Whether to offer a column with the source's conversation.
   * @returns {TableColumn[]} The columns.
   */
  static sources(includesConversation) {
    const columns = [
      { id: 'title', label: 'Title', isAlwaysVisible: true, filter: 'values', sortValue: source => (source.title || '').toLowerCase(), filterValue: source => source.title, cellHtml: source => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a>` },
      { id: 'outlet', label: 'Outlet', isVisibleByDefault: true, filter: 'values', sortValue: source => source.outlet || '', cellHtml: source => escapeHtml(source.outlet || '') },
      { id: 'topLevelDomain', label: 'TLD', filter: 'values', sortValue: source => source.topLevelDomain || '', cellHtml: source => escapeHtml(source.topLevelDomain ? `.${source.topLevelDomain}` : '') },
      TableColumns.#dateColumn(source => source.timestamp),
    ];
    return includesConversation ? [...columns, TableColumns.#conversationColumn()] : columns;
  }

  /**
   * Columns of a file table.
   * @param {boolean} includesConversation Whether to offer a column with the file's conversation.
   * @returns {TableColumn[]} The columns.
   */
  static files(includesConversation) {
    const columns = [
      { id: 'name', label: 'Name', isAlwaysVisible: true, filter: 'values', sortValue: file => (file.title || '').toLowerCase(), filterValue: file => file.title, cellHtml: file => escapeHtml(file.title || '(file)') },
      { id: 'type', label: 'Type', isVisibleByDefault: true, filter: 'values', sortValue: file => fileExtension(file.title || file.path), cellHtml: file => escapeHtml(fileExtension(file.title || file.path)) },
      TableColumns.#dateColumn(file => file.timestamp),
      { id: 'source', label: 'Source', isVisibleByDefault: true, filter: 'values', sortValue: file => TableColumns.#fileSourceLabel(file), cellHtml: file => TableColumns.#fileSourceLabel(file) },
    ];
    return includesConversation ? [...columns, TableColumns.#conversationColumn()] : columns;
  }

  /**
   * A sortable, date-range-filterable timestamp column.
   * @param {function(object): ?string} timestampOf Returns a row's ISO timestamp.
   * @returns {TableColumn} The column.
   */
  static #dateColumn(timestampOf) {
    return {
      id: 'date', label: 'Date', isVisibleByDefault: true, filter: 'date',
      sortValue: row => toEpochMs(timestampOf(row)),
      filterValue: row => timestampOf(row),
      cellHtml: row => escapeHtml(formatTimestamp(timestampOf(row))),
    };
  }

  /**
   * A column naming the conversation a row belongs to.
   * @returns {TableColumn} The column.
   */
  static #conversationColumn() {
    return {
      id: 'conversation', label: 'Chat', isVisibleByDefault: true, filter: 'values',
      sortValue: row => (row.conversationTitle || '').toLowerCase(),
      filterValue: row => row.conversationTitle,
      cellHtml: row => escapeHtml(row.conversationTitle || ''),
    };
  }

  /**
   * Who provided a file.
   * @param {FileEntry} file The file.
   * @returns {string} "User" or "Claude".
   */
  static #fileSourceLabel(file) {
    return file.source === 'user' ? 'User' : 'Claude';
  }
}
