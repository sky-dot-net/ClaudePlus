import { compareAscending } from '../../math/compareAscending.js';

/**
 * The column a table is sorted by and the direction. Sorting by the current column again reverses
 * the direction; another column starts ascending.
 */
export class SortOrder {
  /**
   * All columns.
   * @type {TableColumn[]}
   */
  #columns;

  /**
   * Id of the sort column.
   * @type {string}
   */
  #columnId;

  /**
   * 1 ascending, -1 descending.
   * @type {number}
   */
  #direction;

  /**
   * Restores the order from stored settings, or uses the default one.
   * @param {TableColumn[]} columns All columns.
   * @param {*} stored Stored sort order; ignored unless it names a known column.
   * @param {{column: string, direction: number}} defaultSort Sort used until the user sorts.
   */
  constructor(columns, stored, defaultSort) {
    this.#columns = columns;
    const isValid = Boolean(stored) && columns.some(column => column.id === stored.column);
    this.#columnId = isValid ? stored.column : defaultSort.column;
    this.#direction = SortOrder.#validDirection(isValid ? stored.direction : defaultSort.direction);
  }

  /**
   * A direction limited to the two valid values.
   * @param {*} direction Direction to check.
   * @returns {number} 1 for 1, otherwise -1.
   */
  static #validDirection(direction) {
    return direction === 1 ? 1 : -1;
  }

  /**
   * Sorts by a column; the current column reverses direction, another one starts ascending.
   * @param {string} columnId Column id.
   * @returns {void}
   */
  sortBy(columnId) {
    this.#direction = this.#columnId === columnId ? -this.#direction : 1;
    this.#columnId = columnId;
  }

  /**
   * Arrow shown after a column's header label.
   * @param {string} columnId Column id.
   * @returns {string} " ▲" or " ▼" for the sort column, otherwise empty.
   */
  indicatorFor(columnId) {
    if (this.#columnId !== columnId) return '';
    return this.#direction === 1 ? ' ▲' : ' ▼';
  }

  /**
   * Rows in this order.
   * @param {object[]} rows Rows to sort.
   * @returns {object[]} A sorted copy.
   */
  sort(rows) {
    const column = this.#columns.find(candidate => candidate.id === this.#columnId) ?? this.#columns[0];
    return [...rows].sort((first, second) => compareAscending(column.sortValue(first), column.sortValue(second)) * this.#direction);
  }

  /**
   * Serializable form.
   * @returns {{column: string, direction: number}} The sort column and direction.
   */
  toJSON() {
    return { column: this.#columnId, direction: this.#direction };
  }
}
