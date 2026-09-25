import { escapeHtml } from '../../text/escapeHtml.js';

/**
 * A column naming the conversation a row belongs to, read from the row's conversationTitle.
 * @returns {TableColumn} The column.
 */
export function createConversationColumn() {
  return {
    id: 'conversation', label: 'Chat', isVisibleByDefault: true, filter: 'values',
    sortValue: row => (row.conversationTitle || '').toLowerCase(),
    filterValue: row => row.conversationTitle,
    cellHtml: row => escapeHtml(row.conversationTitle || ''),
  };
}
