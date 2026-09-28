/**
 * Manually resized widths of a table's columns, in pixels. A column the user hasn't dragged keeps
 * its normal (auto-sized or flexible) width.
 */
export class ColumnWidths {
  /**
   * Widths in pixels, by column id; only columns the user has resized appear here.
   * @type {Object<string, number>}
   */
  #widths;

  /**
   * Restores stored widths.
   * @param {*} stored Stored widths; ignored unless a plain object.
   */
  constructor(stored) {
    this.#widths = stored && typeof stored === 'object' ? { ...stored } : {};
  }

  /**
   * A column's resized width, if it has been resized.
   * @param {string} columnId Column id.
   * @returns {?number} The width in pixels, or null when not resized.
   */
  widthOf(columnId) {
    return this.#widths[columnId] ?? null;
  }

  /**
   * Sets a column's resized width.
   * @param {string} columnId Column id.
   * @param {number} width Width in pixels.
   * @returns {void}
   */
  setWidth(columnId, width) {
    this.#widths[columnId] = width;
  }

  /**
   * Clears a column's resized width, restoring its normal width.
   * @param {string} columnId Column id.
   * @returns {void}
   */
  reset(columnId) {
    delete this.#widths[columnId];
  }

  /**
   * The widths, in a storable form.
   * @returns {Object<string, number>} The widths by column id.
   */
  get stored() {
    return { ...this.#widths };
  }
}
