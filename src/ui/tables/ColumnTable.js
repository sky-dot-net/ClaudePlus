import { ColumnVisibility } from './ColumnVisibility.js';
import { RowFilterSet } from './RowFilterSet.js';
import { STORAGE_KEYS } from '../../config/STORAGE_KEYS.js';
import { SortOrder } from './SortOrder.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { ValueCombobox } from './ValueCombobox.js';
import { collectNamedElements } from '../../dom/collectNamedElements.js';
import { columnFilterValue } from './columnFilterValue.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import { filterControlHtml } from './filterControlHtml.js';
import stylesheet from './ColumnTable.css';

StyleRegistry.register(stylesheet);

/**
 * A reusable table with toggleable columns, sorting by clicking a header (clicking again reverses
 * it), and per-column filters under the headers: typeahead wildcard filters for text columns and
 * date ranges for timestamp columns. Column visibility and sort order persist per table id.
 */
export class ColumnTable {
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
   * Which columns are shown.
   * @type {ColumnVisibility}
   */
  #visibility;

  /**
   * Sort column and direction.
   * @type {SortOrder}
   */
  #sortOrder;

  /**
   * Entered filter values.
   * @type {RowFilterSet}
   */
  #filters;

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
    const stored = preferences.readJson(this.#storageKey) ?? {};
    this.#visibility = new ColumnVisibility(columns, stored.visibleColumnIds);
    this.#sortOrder = new SortOrder(columns, stored.sortOrder, defaultSort);
    this.#filters = new RowFilterSet(columns);
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
    if (!header) return;
    this.#sortOrder.sortBy(header.dataset.sortColumn);
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
    this.#visibility.setVisible(columnId, checkbox.checked);
    if (!checkbox.checked) this.#filters.drop(columnId);
    this.#saveSettings();
    this.#renderColumns();
  }

  /**
   * Records a filter input's value and re-renders the rows.
   * @param {Event} event Input in the filter row.
   * @returns {void}
   */
  #onFilterInput(event) {
    const input = event.target.closest('[data-filter-column]');
    if (!input) return;
    this.#filters.record(input.dataset.filterColumn, input.dataset.filterBound, input.value);
    this.#renderBody();
  }

  /**
   * Stores column visibility and sort order.
   * @returns {void}
   */
  #saveSettings() {
    this.#preferences.writeJson(this.#storageKey, { visibleColumnIds: this.#visibility.visibleColumnIds, sortOrder: this.#sortOrder });
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
    this.#elements.columnToggles.querySelectorAll('[data-column-toggle]').forEach(checkbox => {
      checkbox.checked = this.#visibility.isVisible(checkbox.dataset.columnToggle);
    });
  }

  /**
   * Renders the header cells with the sort indicator.
   * @returns {void}
   */
  #renderHeader() {
    this.#elements.headerRow.innerHTML = this.#visibility.visibleColumns.map(column => this.#headerCellHtml(column)).join('');
  }

  /**
   * HTML of one header cell.
   * @param {TableColumn} column The column.
   * @returns {string} The cell; sortable columns carry data-sort-column and show ▲ or ▼ while sorted.
   */
  #headerCellHtml(column) {
    if (column.isNotSortable) return `<th>${escapeHtml(column.label)}</th>`;
    return `<th class="claude-plus-column-table__sortable" data-sort-column="${column.id}">${escapeHtml(column.label)}${this.#sortOrder.indicatorFor(column.id)}</th>`;
  }

  /**
   * Renders the filter controls under the visible columns, keeping entered values, and attaches
   * the typeaheads.
   * @returns {void}
   */
  #renderFilterRow() {
    this.#comboboxes.forEach(combobox => combobox.dispose());
    this.#elements.filterRow.innerHTML = this.#visibility.visibleColumns.map(column => `<th>${filterControlHtml(column)}</th>`).join('');
    this.#elements.filterRow.querySelectorAll('[data-filter-column]').forEach(input => {
      input.value = this.#filters.valueOf(input.dataset.filterColumn, input.dataset.filterBound);
    });
    this.#comboboxes = [...this.#elements.filterRow.querySelectorAll('[data-filter-bound="text"]')]
      .map(input => new ValueCombobox(input, () => this.#distinctFilterValues(input.dataset.filterColumn)));
  }

  /**
   * Distinct non-empty filter values of a column across all rows.
   * @param {string} columnId Column id.
   * @returns {string[]} The values, sorted.
   */
  #distinctFilterValues(columnId) {
    const column = this.#columns.find(candidate => candidate.id === columnId);
    const values = this.#rows.map(row => columnFilterValue(column, row)).filter(Boolean).map(String);
    return [...new Set(values)].sort((first, second) => first.localeCompare(second));
  }

  /**
   * Renders the rows passing the filters, sorted and limited.
   * @returns {void}
   */
  #renderBody() {
    const visibleColumns = this.#visibility.visibleColumns;
    const rows = this.#sortOrder.sort(this.#filters.apply(this.#rows, this.#visibility)).slice(0, this.#maxRenderedRows);
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
}
