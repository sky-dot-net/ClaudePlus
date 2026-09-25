import { escapeHtml } from '../../text/escapeHtml.js';
import { formatTimestamp } from '../../time/formatTimestamp.js';
import { toEpochMs } from '../../time/toEpochMs.js';

/**
 * A sortable, date-range-filterable timestamp column.
 * @param {function(object): ?string} timestampOf Returns a row's ISO timestamp.
 * @returns {TableColumn} The column.
 */
export function createDateColumn(timestampOf) {
  return {
    id: 'date', label: 'Date', isVisibleByDefault: true, filter: 'date',
    sortValue: row => toEpochMs(timestampOf(row)),
    filterValue: row => timestampOf(row),
    cellHtml: row => escapeHtml(formatTimestamp(timestampOf(row))),
  };
}
