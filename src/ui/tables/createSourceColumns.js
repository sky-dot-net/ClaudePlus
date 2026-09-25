import { createConversationColumn } from './createConversationColumn.js';
import { createDateColumn } from './createDateColumn.js';
import { escapeHtml } from '../../text/escapeHtml.js';

/**
 * Columns of a web source table: title (a link), outlet, top-level domain, date and optionally
 * the conversation.
 * @param {boolean} includesConversation Whether to offer a column with the source's conversation.
 * @returns {TableColumn[]} The columns.
 */
export function createSourceColumns(includesConversation) {
  const columns = [
    { id: 'title', label: 'Title', isAlwaysVisible: true, filter: 'values', sortValue: source => (source.title || '').toLowerCase(), filterValue: source => source.title, cellHtml: source => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a>` },
    { id: 'outlet', label: 'Outlet', isVisibleByDefault: true, filter: 'values', sortValue: source => source.outlet || '', cellHtml: source => escapeHtml(source.outlet || '') },
    { id: 'topLevelDomain', label: 'TLD', filter: 'values', sortValue: source => source.topLevelDomain || '', cellHtml: source => escapeHtml(source.topLevelDomain ? `.${source.topLevelDomain}` : '') },
    createDateColumn(source => source.timestamp),
  ];
  return includesConversation ? [...columns, createConversationColumn()] : columns;
}
