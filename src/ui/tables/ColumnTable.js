import { DateRange } from '../../time/DateRange.js';
import { STORAGE_KEYS } from '../../config/STORAGE_KEYS.js';
import { ValueCombobox } from './ValueCombobox.js';
import { WildcardPattern } from '../../text/WildcardPattern.js';
import { collectNamedElements } from '../../dom/collectNamedElements.js';
import { compareAscending } from '../../math/compareAscending.js';
import { escapeHtml } from '../../text/escapeHtml.js';

/**
 * A reusable table with toggleable columns, sorting by clicking a header (clicking again reverses
 * it), and per-column filters under the headers: typeahead wildcard filters for text columns and
 * date ranges for timestamp columns. Column visibility and sort order persist per table id.
 */
export class ColumnTable {
  /**
   * Filter control HTML per filter kind.
   * @type {Readonly<Record<string, function(TableColumn): string>>}
   */
  static #FILTER_CONTROLS = Object.freeze({
    none: () => '',
    values: column => `<input type="text" class="claude-plus-column-table__filter-input" data-filter-column="${column.id}" data-filter-bound="text" placeholder="Filter…" />`,
    date: column => `<input type="date" class="claude-plus-column-table__filter-input" data-filter-column="${column.id}" data-filter-bound="from" title="From" /><input type="date" class="claude-plus-column-table__filter-input" data-filter-column="${column.id}" data-filter-bound="to" title="To" />`,
  });

  /**
   * Storage key of the column and sort settings.
   * @type {string}
   */
  #storageKey;

  /**
   * All columns, in display order.
   * @type {TableColumn[]}
   */
  #columns;

  /**
   * Settings storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Returns the attributes of a row's tr element.
   * @type {function(object): string}
   */
  #rowAttributes;

  /**
   * Shown when no row passes the filters.
   * @type {string}
   */
  #emptyText;

  /**
   * Most rows rendered at once, after filtering and sorting.
   * @type {number}
   */
  #maxRenderedRows;

  /**
   * Current rows, unfiltered.
   * @type {object[]}
   */
  #rows = [];

  /**
   * Ids of the visible columns.
   * @type {Set<string>}
   */
  #visibleColumnIds;

  /**
   * Sort column and direction (1 ascending, -1 descending).
   * @type {{column: string, direction: number}}
   */
  #sortOrder;

  /**
   * Filter input values per column id, keyed by bound ('text', 'from' or 'to').
   * @type {Map<string, Object<string, string>>}
   */
  #filterInputs = new Map();

  /**
   * Named elements of the table.
   * @type {Object<string, HTMLElement>}
   */
  #elements;

  /**
   * Typeaheads of the current filter row.
   * @type {ValueCombobox[]}
   */
  #comboboxes = [];

  /**
   * Builds the table into a container.
   * @param {object} options Table options.
   * @param {HTMLElement} options.container Element the table is built into.
   * @param {string} options.tableId Id under which column and sort settings are stored.
   * @param {TableColumn[]} options.columns Columns in display order.
   * @param {Preferences} options.preferences Settings storage.
   * @param {{column: string, direction: number}} options.defaultSort Sort used until the user sorts.
   * @param {function(object): string} options.rowAttributes Returns the escaped attributes of a row's tr element.
   * @param {string} options.emptyText Shown when no row passes the filters.
   * @param {number} [options.maxRenderedRows] Most rows rendered at once; unlimited by default.
   */
  constructor({ container, tableId, columns, preferences, defaultSort, rowAttributes, emptyText, maxRenderedRows = Infinity }) {
    this.#storageKey = `${STORAGE_KEYS.tablePrefix}${tableId}`;
    this.#columns = columns;
    this.#preferences = preferences;
    this.#rowAttributes = rowAttributes;
    this.#emptyText = emptyText;
    this.#maxRenderedRows = maxRenderedRows;
    const stored = preferences.readJson(this.#storageKey);
    this.#visibleColumnIds = ColumnTable.#storedVisibleColumns(stored, columns);
    this.#sortOrder = ColumnTable.#storedSortOrder(stored, columns, defaultSort);
    container.innerHTML = ColumnTable.#skeletonHtml(columns);
    this.#elements = collectNamedElements(container);
    this.#bindEvents();
    this.#renderColumns();
  }

  /**
   * The tbody element; row click handling is attached here by the table's owner.
   * @returns {HTMLElement} The body.
   */
  get bodyElement() {
    return this.#elements.tableBody;
  }

  /**
   * Replaces the rows and re-renders.
   * @param {object[]} rows New rows.
   * @returns {void}
   */
  setRows(rows) {
    this.#rows = rows;
    this.#renderBody();
  }

  /**
   * Closes any open typeahead list.
   * @returns {void}
   */
  dispose() {
    this.#comboboxes.forEach(combobox => combobox.dispose());
  }

  /**
   * Visible columns from stored settings, or the default ones; always-visible columns are always included.
   * @param {*} stored Parsed stored settings.
   * @param {TableColumn[]} columns All columns.
   * @returns {Set<string>} Ids of the visible columns.
   */
  static #storedVisibleColumns(stored, columns) {
    const columnIds = columns.map(column => column.id);
    const storedIds = stored && Array.isArray(stored.visibleColumnIds) ? stored.visibleColumnIds.filter(id => columnIds.includes(id)) : null;
    const visible = new Set(storedIds ?? columns.filter(column => column.isVisibleByDefault).map(column => column.id));
    columns.filter(column => column.isAlwaysVisible).forEach(column => visible.add(column.id));
    return visible;
  }

  /**
   * Sort order from stored settings, or the default one.
   * @param {*} stored Parsed stored settings.
   * @param {TableColumn[]} columns All columns.
   * @param {{column: string, direction: number}} defaultSort Default sort.
   * @returns {{column: string, direction: number}} The sort order.
   */
  static #storedSortOrder(stored, columns, defaultSort) {
    const sortOrder = stored ? stored.sortOrder : null;
    const isValid = Boolean(sortOrder) && columns.some(column => column.id === sortOrder.column);
    return isValid ? { column: sortOrder.column, direction: sortOrder.direction === 1 ? 1 : -1 } : { ...defaultSort };
  }

  /**
   * HTML of the column picker and the empty table.
   * @param {TableColumn[]} columns All columns.
   * @returns {string} The HTML.
   */
  static #skeletonHtml(columns) {
    const toggles = columns.filter(column => !column.isAlwaysVisible)
      .map(column => `<label class="claude-plus-column-table__column-toggle"><input type="checkbox" data-column-toggle="${column.id}" /> ${escapeHtml(column.label)}</label>`)
      .join('');
    const picker = toggles ? `<details class="claude-plus-column-table__column-picker"><summary>Columns</summary><div data-name="columnToggles">${toggles}</div></details>` : '';
    return `${picker}<div class="claude-plus-scrollable claude-plus-fill-remaining claude-plus-column-table"><table class="claude-plus-column-table__table"><thead><tr data-name="headerRow"></tr><tr class="claude-plus-column-table__filter-row" data-name="filterRow"></tr></thead><tbody data-name="tableBody"></tbody></table></div>`;
  }

  /**
   * Wires sorting, column toggles and filters.
   * @returns {void}
   */
  #bindEvents() {
    this.#elements.headerRow.addEventListener('click', event => this.#onHeaderClick(event));
    this.#elements.filterRow.addEventListener('input', event => this.#onFilterInput(event));
    if (this.#elements.columnToggles) this.#elements.columnToggles.addEventListener('change', event => this.#onColumnToggle(event));
  }

  /**
   * Sorts by the clicked header's column.
   * @param {MouseEvent} event Click in the header row.
   * @returns {void}
   */
  #onHeaderClick(event) {
    const header = event.target.closest('[data-sort-column]');
    if (header) this.#sortBy(header.dataset.sortColumn);
  }

  /**
   * Sorts by a column; the current column reverses direction, another one starts ascending.
   * @param {string} columnId Column id.
   * @returns {void}
   */
  #sortBy(columnId) {
    const direction = this.#sortOrder.column === columnId ? -this.#sortOrder.direction : 1;
    this.#sortOrder = { column: columnId, direction };
    this.#saveSettings();
    this.#renderHeader();
    this.#renderBody();
  }

  /**
   * Shows or hides the toggled column; a hidden column's filter is dropped.
   * @param {Event} event Change of a column checkbox.
   * @returns {void}
   */
  #onColumnToggle(event) {
    const checkbox = event.target.closest('[data-column-toggle]');
    if (!checkbox) return;
    const columnId = checkbox.dataset.columnToggle;
    if (checkbox.checked) this.#visibleColumnIds.add(columnId);
    else this.#hideColumn(columnId);
    this.#saveSettings();
    this.#renderColumns();
  }

  /**
   * Hides a column and drops its filter.
   * @param {string} columnId Column id.
   * @returns {void}
   */
  #hideColumn(columnId) {
    this.#visibleColumnIds.delete(columnId);
    this.#filterInputs.delete(columnId);
  }

  /**
   * Records a filter input's value and re-renders the rows.
   * @param {Event} event Input in the filter row.
   * @returns {void}
   */
  #onFilterInput(event) {
    const input = event.target.closest('[data-filter-column]');
    if (!input) return;
    const values = this.#filterInputs.get(input.dataset.filterColumn) ?? {};
    values[input.dataset.filterBound] = input.value;
    this.#filterInputs.set(input.dataset.filterColumn, values);
    this.#renderBody();
  }

  /**
   * Stores column visibility and sort order.
   * @returns {void}
   */
  #saveSettings() {
    this.#preferences.writeJson(this.#storageKey, { visibleColumnIds: [...this.#visibleColumnIds], sortOrder: this.#sortOrder });
  }

  /**
   * Columns currently shown.
   * @returns {TableColumn[]} The visible columns, in display order.
   */
  #visibleColumns() {
    return this.#columns.filter(column => this.#visibleColumnIds.has(column.id));
  }

  /**
   * Renders the column picker state, the header, the filter row and the rows.
   * @returns {void}
   */
  #renderColumns() {
    this.#syncColumnToggles();
    this.#renderHeader();
    this.#renderFilterRow();
    this.#renderBody();
  }

  /**
   * Checks the picker boxes of the visible columns.
   * @returns {void}
   */
  #syncColumnToggles() {
    if (!this.#elements.columnToggles) return;
    this.#elements.columnToggles.querySelectorAll('[data-column-toggle]').forEach((checkbox) => {
      checkbox.checked = this.#visibleColumnIds.has(checkbox.dataset.columnToggle);
    });
  }

  /**
   * Renders the header cells with the sort indicator.
   * @returns {void}
   */
  #renderHeader() {
    this.#elements.headerRow.innerHTML = this.#visibleColumns().map(column => this.#headerCellHtml(column)).join('');
  }

  /**
   * HTML of one header cell.
   * @param {TableColumn} column The column.
   * @returns {string} The cell; sortable columns carry data-sort-column and show ▲ or ▼ while sorted.
   */
  #headerCellHtml(column) {
    if (column.isNotSortable) return `<th>${escapeHtml(column.label)}</th>`;
    const isSorted = this.#sortOrder.column === column.id;
    const indicator = isSorted ? ColumnTable.#sortIndicator(this.#sortOrder.direction) : '';
    return `<th class="claude-plus-column-table__sortable" data-sort-column="${column.id}">${escapeHtml(column.label)}${indicator}</th>`;
  }

  /**
   * Arrow showing a sort direction.
   * @param {number} direction 1 ascending, -1 descending.
   * @returns {string} " ▲" or " ▼".
   */
  static #sortIndicator(direction) {
    return direction === 1 ? ' ▲' : ' ▼';
  }

  /**
   * Renders the filter controls under the visible columns, keeping entered values, and attaches
   * the typeaheads.
   * @returns {void}
   */
  #renderFilterRow() {
    this.#comboboxes.forEach(combobox => combobox.dispose());
    this.#elements.filterRow.innerHTML = this.#visibleColumns().map(column => `<th>${ColumnTable.#FILTER_CONTROLS[column.filter ?? 'none'](column)}</th>`).join('');
    this.#elements.filterRow.querySelectorAll('[data-filter-column]').forEach(input => this.#restoreFilterInput(input));
    this.#comboboxes = [...this.#elements.filterRow.querySelectorAll('[data-filter-bound="text"]')]
      .map(input => new ValueCombobox(input, () => this.#distinctFilterValues(input.dataset.filterColumn)));
  }

  /**
   * Puts a filter input's recorded value back after re-rendering.
   * @param {HTMLInputElement} input The input.
   * @returns {void}
   */
  #restoreFilterInput(input) {
    const values = this.#filterInputs.get(input.dataset.filterColumn) ?? {};
    input.value = values[input.dataset.filterBound] ?? '';
  }

  /**
   * Distinct non-empty filter values of a column across all rows.
   * @param {string} columnId Column id.
   * @returns {string[]} The values, sorted.
   */
  #distinctFilterValues(columnId) {
    const column = this.#columns.find(candidate => candidate.id === columnId);
    const values = this.#rows.map(row => ColumnTable.#filterValue(column, row)).filter(Boolean).map(String);
    return [...new Set(values)].sort((first, second) => first.localeCompare(second));
  }

  /**
   * Renders the rows passing the filters, sorted and limited.
   * @returns {void}
   */
  #renderBody() {
    const visibleColumns = this.#visibleColumns();
    const rows = this.#sortedRows(this.#filteredRows()).slice(0, this.#maxRenderedRows);
    this.#elements.tableBody.innerHTML = rows.map(row => this.#rowHtml(row, visibleColumns)).join('')
      || `<tr><td colspan="${visibleColumns.length}" class="claude-plus-empty-state">${escapeHtml(this.#emptyText)}</td></tr>`;
  }

  /**
   * HTML of one row.
   * @param {object} row The row.
   * @param {TableColumn[]} visibleColumns Columns to render.
   * @returns {string} The tr element.
   */
  #rowHtml(row, visibleColumns) {
    const cells = visibleColumns.map(column => `<td class="claude-plus-column-table__cell claude-plus-column-table__cell--${column.id}">${column.cellHtml(row)}</td>`);
    return `<tr ${this.#rowAttributes(row)}>${cells.join('')}</tr>`;
  }

  /**
   * Rows passing every active filter of a visible column.
   * @returns {object[]} The rows.
   */
  #filteredRows() {
    const rowTests = [...this.#filterInputs]
      .filter(([columnId]) => this.#visibleColumnIds.has(columnId))
      .map(([columnId, values]) => this.#createRowTest(columnId, values));
    return this.#rows.filter(row => rowTests.every(passes => passes(row)));
  }

  /**
   * Creates the test for one column's filter.
   * @param {string} columnId Column id.
   * @param {Object<string, string>} values Filter input values by bound.
   * @returns {function(object): boolean} Returns whether a row passes.
   */
  #createRowTest(columnId, values) {
    const column = this.#columns.find(candidate => candidate.id === columnId);
    if (column.filter === 'date') {
      const range = new DateRange(values.from, values.to);
      return row => range.contains(ColumnTable.#filterValue(column, row));
    }
    const pattern = new WildcardPattern(values.text ?? '');
    return row => pattern.matches(ColumnTable.#filterValue(column, row));
  }

  /**
   * Rows in the current sort order.
   * @param {object[]} rows Rows to sort.
   * @returns {object[]} A sorted copy.
   */
  #sortedRows(rows) {
    const column = this.#columns.find(candidate => candidate.id === this.#sortOrder.column) ?? this.#columns[0];
    const direction = this.#sortOrder.direction;
    return [...rows].sort((first, second) => compareAscending(column.sortValue(first), column.sortValue(second)) * direction);
  }

  /**
   * Value a column's filter tests for a row.
   * @param {TableColumn} column The column.
   * @param {object} row The row.
   * @returns {*} The filter value, or the sort value when the column has no separate filter value.
   */
  static #filterValue(column, row) {
    return column.filterValue ? column.filterValue(row) : column.sortValue(row);
  }
}
