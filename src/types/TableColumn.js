/**
 * A column of a ColumnTable.
 * @typedef {object} TableColumn
 * @property {string} id Column id, unique within its table.
 * @property {string} label Header text; may be empty.
 * @property {function(object): (string|number)} sortValue Value the column sorts by.
 * @property {function(object): string} cellHtml HTML of the column's cell for a row; must be escaped.
 * @property {boolean} [isAlwaysVisible] Whether the column can't be hidden.
 * @property {boolean} [isVisibleByDefault] Whether the column shows before the user has chosen columns.
 * @property {boolean} [isNotSortable] Whether clicking the header does nothing.
 * @property {'values'|'date'} [filter] Filter control under the header: a typeahead over the column's distinct values, or a date range.
 * @property {function(object): ?string} [filterValue] Value the filter tests (an ISO timestamp for date filters); defaults to sortValue.
 */

export {};
