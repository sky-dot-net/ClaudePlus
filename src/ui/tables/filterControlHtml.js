/**
 * Filter control HTML per filter kind: none, a typeahead text input for values, or a from/to pair
 * of date inputs for dates.
 * @type {Readonly<Record<string, function(TableColumn): string>>}
 */
const FILTER_CONTROLS = Object.freeze({
  none: () => '',
  values: column => `<input type="text" class="claude-plus-column-table__filter-input" data-filter-column="${column.id}" data-filter-bound="text" placeholder="Filter…" />`,
  date: column => `<input type="date" class="claude-plus-column-table__filter-input" data-filter-column="${column.id}" data-filter-bound="from" title="From" /><input type="date" class="claude-plus-column-table__filter-input" data-filter-column="${column.id}" data-filter-bound="to" title="To" />`,
});

/**
 * HTML of the filter control under a column's header.
 * @param {TableColumn} column The column.
 * @returns {string} The control's HTML; empty for a column without a filter.
 */
export function filterControlHtml(column) {
  return FILTER_CONTROLS[column.filter ?? 'none'](column);
}
