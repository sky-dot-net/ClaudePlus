import { DateRange } from '../../time/DateRange.js';
import { WildcardPattern } from '../../text/WildcardPattern.js';
import { columnFilterValue } from './columnFilterValue.js';

/**
 * The values entered into a table's filter inputs and the rows passing them: a wildcard pattern
 * for value filters, a from/to range for date filters.
 */
export class RowFilterSet {
  /**
   * All columns.
   * @type {TableColumn[]}
   */
  #columns;

  /**
   * Entered values per column id, keyed by bound ('text', 'from' or 'to').
   * @type {Map<string, Object<string, string>>}
   */
  #valuesByColumn = new Map();

  /**
   * Creates an empty filter set.
   * @param {TableColumn[]} columns All columns.
   */
  constructor(columns) {
    this.#columns = columns;
  }

  /**
   * Records the value of one filter input.
   * @param {string} columnId Column id.
   * @param {string} bound 'text', 'from' or 'to'.
   * @param {string} value Entered value.
   * @returns {void}
   */
  record(columnId, bound, value) {
    const values = this.#valuesByColumn.get(columnId) ?? {};
    values[bound] = value;
    this.#valuesByColumn.set(columnId, values);
  }

  /**
   * The recorded value of one filter input.
   * @param {string} columnId Column id.
   * @param {string} bound 'text', 'from' or 'to'.
   * @returns {string} The value, or empty when none was entered.
   */
  valueOf(columnId, bound) {
    return this.#valuesByColumn.get(columnId)?.[bound] ?? '';
  }

  /**
   * Drops a column's filter.
   * @param {string} columnId Column id.
   * @returns {void}
   */
  drop(columnId) {
    this.#valuesByColumn.delete(columnId);
  }

  /**
   * Rows passing every filter of a visible column.
   * @param {object[]} rows Rows to filter.
   * @param {ColumnVisibility} visibility Which columns are shown; filters of hidden columns are ignored.
   * @returns {object[]} The passing rows.
   */
  apply(rows, visibility) {
    const rowTests = [...this.#valuesByColumn]
      .filter(([columnId]) => visibility.isVisible(columnId))
      .map(([columnId, values]) => this.#createRowTest(columnId, values));
    return rows.filter(row => rowTests.every(passes => passes(row)));
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
      return row => range.contains(columnFilterValue(column, row));
    }
    const pattern = new WildcardPattern(values.text ?? '');
    return row => pattern.matches(columnFilterValue(column, row));
  }
}
