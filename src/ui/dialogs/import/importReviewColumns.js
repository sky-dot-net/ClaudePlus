import { UNTITLED } from '../../../config/UNTITLED.js';
import { createDateColumn } from '../../tables/createDateColumn.js';
import { escapeHtml } from '../../../text/escapeHtml.js';

/**
 * Label shown for each classification of a previewed conversation.
 * @type {Readonly<Record<string, string>>}
 */
const CLASSIFICATION_LABELS = Object.freeze({ new: 'New', changed: 'Changed', renamedOnly: 'Renamed', unchanged: 'Unchanged' });

/**
 * HTML of a classification badge.
 * @param {string} classification The classification.
 * @returns {string} The badge.
 */
function statusBadgeHtml(classification) {
  const label = CLASSIFICATION_LABELS[classification] ?? classification;
  return `<span class="claude-plus-import-dialog__badge claude-plus-import-dialog__badge--${escapeHtml(classification)}">${escapeHtml(label)}</span>`;
}

/**
 * The import review table's columns: a selection checkbox, then name, date, turns and status.
 * @param {function(string): boolean} isSelected Whether a conversation id is currently selected.
 * @returns {TableColumn[]} The columns.
 */
export function importReviewColumns(isSelected) {
  return [
    { id: 'selected', label: '', isAlwaysVisible: true, isNotSortable: true, sortValue: () => 0, cellHtml: row => `<input type="checkbox" data-select-row${isSelected(row.conversationId) ? ' checked' : ''} />` },
    { id: 'name', label: 'Name', isAlwaysVisible: true, filter: 'values', sortValue: row => (row.title || '').toLowerCase(), filterValue: row => row.title || UNTITLED, cellHtml: row => escapeHtml(row.title || UNTITLED) },
    createDateColumn(row => row.updatedAt),
    { id: 'turns', label: 'Turns', isVisibleByDefault: true, sortValue: row => row.promptCount, cellHtml: row => String(row.promptCount) },
    { id: 'status', label: 'Status', isVisibleByDefault: true, filter: 'values', sortValue: row => row.classification, filterValue: row => CLASSIFICATION_LABELS[row.classification], cellHtml: row => statusBadgeHtml(row.classification) },
  ];
}
