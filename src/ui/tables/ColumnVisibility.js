/**
 * Which columns of a table are shown. Always-visible columns can never be hidden.
 */
export class ColumnVisibility {
  /**
   * All columns, in display order.
   * @type {TableColumn[]}
   */
  #columns;

  /**
   * Ids of the visible columns.
   * @type {Set<string>}
   */
  #visibleColumnIds;

  /**
   * Restores the visible columns from stored ids, or uses the columns visible by default.
   * @param {TableColumn[]} columns All columns, in display order.
   * @param {*} storedIds Stored ids of the visible columns; ignored unless an array.
   */
  constructor(columns, storedIds) {
    this.#columns = columns;
    const columnIds = columns.map(column => column.id);
    const knownStoredIds = Array.isArray(storedIds) ? storedIds.filter(columnId => columnIds.includes(columnId)) : null;
    this.#visibleColumnIds = new Set(knownStoredIds ?? columns.filter(column => column.isVisibleByDefault).map(column => column.id));
    columns.filter(column => column.isAlwaysVisible).forEach(column => this.#visibleColumnIds.add(column.id));
  }

  /**
   * Columns currently shown.
   * @returns {TableColumn[]} The visible columns, in display order.
   */
  get visibleColumns() {
    return this.#columns.filter(column => this.#visibleColumnIds.has(column.id));
  }

  /**
   * Ids of the visible columns, in a storable form.
   * @returns {string[]} The ids.
   */
  get visibleColumnIds() {
    return [...this.#visibleColumnIds];
  }

  /**
   * Whether a column is shown.
   * @param {string} columnId Column id.
   * @returns {boolean} True when shown.
   */
  isVisible(columnId) {
    return this.#visibleColumnIds.has(columnId);
  }

  /**
   * Shows or hides a column.
   * @param {string} columnId Column id.
   * @param {boolean} isVisible Whether it should be shown.
   * @returns {void}
   */
  setVisible(columnId, isVisible) {
    if (isVisible) this.#visibleColumnIds.add(columnId);
    else this.#visibleColumnIds.delete(columnId);
  }
}
