import { createConversationColumn } from './createConversationColumn.js';
import { createDateColumn } from './createDateColumn.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import { fileExtension } from '../../text/fileExtension.js';
import { fileSourceLabel } from './fileSourceLabel.js';

/**
 * Columns of a file table: name, type, date, who provided it and optionally the conversation.
 * @param {boolean} includesConversation Whether to offer a column with the file's conversation.
 * @returns {TableColumn[]} The columns.
 */
export function createFileColumns(includesConversation) {
  const columns = [
    { id: 'name', label: 'Name', isAlwaysVisible: true, filter: 'values', sortValue: file => (file.title || '').toLowerCase(), filterValue: file => file.title, cellHtml: file => escapeHtml(file.title || '(file)') },
    { id: 'type', label: 'Type', isVisibleByDefault: true, filter: 'values', sortValue: file => fileExtension(file.title || file.path), cellHtml: file => escapeHtml(fileExtension(file.title || file.path)) },
    createDateColumn(file => file.timestamp),
    { id: 'source', label: 'Source', isVisibleByDefault: true, filter: 'values', sortValue: file => fileSourceLabel(file), cellHtml: file => fileSourceLabel(file) },
  ];
  return includesConversation ? [...columns, createConversationColumn()] : columns;
}
