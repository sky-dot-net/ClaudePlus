/**
 * Value a column's filter tests for a row.
 * @param {TableColumn} column The column.
 * @param {object} row The row.
 * @returns {*} The filter value, or the sort value when the column has no separate filter value.
 */
export function columnFilterValue(column, row) {
  return column.filterValue ? column.filterValue(row) : column.sortValue(row);
}
