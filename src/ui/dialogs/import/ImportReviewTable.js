import { ColumnTable } from '../../tables/ColumnTable.js';
import { escapeHtml } from '../../../text/escapeHtml.js';
import { importReviewColumns } from './importReviewColumns.js';

/**
 * The import screen's conversation review table: every previewed conversation, sortable and
 * filterable, each with a checkbox. The selection is kept outside the table itself so it survives
 * re-sorting and re-filtering.
 */
export class ImportReviewTable {
  /**
   * Rows pre-checked by default: every classification except a truly unchanged conversation.
   * @type {ReadonlySet<string>}
   */
  static #DEFAULT_SELECTED_CLASSIFICATIONS = new Set(['new', 'changed', 'metadataChanged']);

  /**
   * Element the table is built in.
   * @type {HTMLElement}
   */
  #host;

  /**
   * Row holding the select all / none buttons.
   * @type {HTMLElement}
   */
  #selectionRow;

  /**
   * Table settings storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Called whenever the selection changes.
   * @type {function(): void}
   */
  #onSelectionChange;

  /**
   * The previewed conversation rows.
   * @type {object[]}
   */
  #rows = [];

  /**
   * Ids of the conversations currently checked for import.
   * @type {Set<string>}
   */
  #selectedIds = new Set();

  /**
   * The table, once shown.
   * @type {?ColumnTable}
   */
  #table = null;

  /**
   * Wires the select all / none buttons; the table itself is built by show().
   * @param {object} parts Table parts.
   * @param {HTMLElement} parts.host Element the table is built in.
   * @param {HTMLElement} parts.selectionRow Row holding the select all / none buttons.
   * @param {HTMLElement} parts.selectAllButton Button selecting every conversation.
   * @param {HTMLElement} parts.selectNoneButton Button deselecting every conversation.
   * @param {Preferences} parts.preferences Table settings storage.
   * @param {function(): void} parts.onSelectionChange Called whenever the selection changes.
   */
  constructor({ host, selectionRow, selectAllButton, selectNoneButton, preferences, onSelectionChange }) {
    this.#host = host;
    this.#selectionRow = selectionRow;
    this.#preferences = preferences;
    this.#onSelectionChange = onSelectionChange;
    selectAllButton.addEventListener('click', () => this.#setAllSelected(true));
    selectNoneButton.addEventListener('click', () => this.#setAllSelected(false));
  }

  /**
   * Ids of the conversations currently checked for import.
   * @returns {Set<string>} The ids.
   */
  get selectedIds() {
    return this.#selectedIds;
  }

  /**
   * Shows the table with a smart default selection.
   * @param {object[]} rows The previewed conversation rows.
   * @returns {void}
   */
  show(rows) {
    this.#rows = rows;
    this.#selectedIds = new Set(rows.filter(row => ImportReviewTable.#DEFAULT_SELECTED_CLASSIFICATIONS.has(row.classification)).map(row => row.conversationId));
    this.#selectionRow.hidden = false;
    this.#host.hidden = false;
    this.#table = this.#createTable();
    this.#table.setRows(rows);
  }

  /**
   * Hides the table and its selection buttons.
   * @returns {void}
   */
  hide() {
    this.#selectionRow.hidden = true;
    this.#host.hidden = true;
  }

  /**
   * Builds the column table and listens to its row checkboxes.
   * @returns {ColumnTable} The table.
   */
  #createTable() {
    const table = new ColumnTable({
      container: this.#host,
      tableId: 'importReview',
      columns: importReviewColumns(conversationId => this.#selectedIds.has(conversationId)),
      preferences: this.#preferences,
      defaultSort: { column: 'date', direction: -1 },
      rowAttributes: row => `data-conversation-id="${escapeHtml(row.conversationId)}"`,
      emptyText: 'No conversations found.',
      maxRenderedRows: 2000,
    });
    table.bodyElement.addEventListener('change', event => this.#onRowCheckboxChange(event));
    return table;
  }

  /**
   * Records a row's checkbox change.
   * @param {Event} event Change of a row checkbox.
   * @returns {void}
   */
  #onRowCheckboxChange(event) {
    const checkbox = event.target.closest('[data-select-row]');
    if (!checkbox) return;
    const conversationId = checkbox.closest('[data-conversation-id]').dataset.conversationId;
    if (checkbox.checked) this.#selectedIds.add(conversationId);
    else this.#selectedIds.delete(conversationId);
    this.#onSelectionChange();
  }

  /**
   * Selects or deselects every previewed conversation, then re-renders the table so its checkboxes
   * reflect the change.
   * @param {boolean} selected Whether every conversation should be selected.
   * @returns {void}
   */
  #setAllSelected(selected) {
    this.#selectedIds = selected ? new Set(this.#rows.map(row => row.conversationId)) : new Set();
    this.#table?.setRows(this.#rows);
    this.#onSelectionChange();
  }
}
