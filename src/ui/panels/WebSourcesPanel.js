import { ColumnTable } from '../tables/ColumnTable.js';
import { LIMITS } from '../../config/LIMITS.js';
import { Panel } from './Panel.js';
import { createSourceColumns } from '../tables/createSourceColumns.js';
import { emptyStateHtml } from '../html/emptyStateHtml.js';
import { entriesByDescendingCount } from '../../math/entriesByDescendingCount.js';
import { valueRowHtml } from '../html/valueRowHtml.js';

/**
 * Web sources cited in tool results, as a column table with typeahead and date filters, plus an
 * outlet ranking.
 */
export class WebSourcesPanel extends Panel {
  /**
   * Conversation statistics.
   * @type {StatsIndex}
   */
  #stats;

  /**
   * Table settings storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * The sources table; created with the DOM.
   * @type {?ColumnTable}
   */
  #table = null;

  /**
   * Creates the panel.
   * @param {object} services Panel dependencies.
   * @param {StatsIndex} services.stats Conversation statistics.
   * @param {Preferences} services.preferences Table settings storage.
   */
  constructor({ stats, preferences }) {
    super('Web Sources');
    this.#stats = stats;
    this.#preferences = preferences;
  }

  /**
   * HTML of the panel body.
   * @returns {string} Table host and outlet ranking.
   */
  createBodyHtml() {
    return `
      <div class="claude-plus-table-host" data-name="tableHost"></div>
      <details class="claude-plus-panel__section"><summary>Top outlets (<span data-name="outletTotal">0</span>)</summary><div class="claude-plus-scrollable" data-name="outletRanking"></div></details>`;
  }

  /**
   * Creates the table and follows aggregate changes.
   * @returns {void}
   */
  bindEvents() {
    this.#table = new ColumnTable({
      container: this.elements.tableHost,
      tableId: 'webSources',
      columns: createSourceColumns(true),
      preferences: this.#preferences,
      defaultSort: { column: 'date', direction: -1 },
      rowAttributes: () => '',
      emptyText: 'No web sources match these filters.',
      maxRenderedRows: LIMITS.listedSources,
    });
    this.listenTo(this.#stats, 'aggregate', () => this.render());
  }

  /**
   * Renders the table and the ranking.
   * @returns {void}
   */
  render() {
    this.#table.setRows(this.#stats.aggregate.sources);
    this.#renderOutletRanking();
  }

  /**
   * Closes the table's typeahead and ends the subscriptions.
   * @returns {void}
   */
  dispose() {
    if (this.#table) this.#table.dispose();
    super.dispose();
  }

  /**
   * Shows the most cited outlets, up to LIMITS.rankedOutlets.
   * @returns {void}
   */
  #renderOutletRanking() {
    const outletCounts = this.#stats.aggregate.outletCounts;
    this.elements.outletTotal.textContent = Object.keys(outletCounts).length;
    this.elements.outletRanking.innerHTML = entriesByDescendingCount(outletCounts).slice(0, LIMITS.rankedOutlets)
      .map(([outlet, count]) => valueRowHtml(outlet, count)).join('') || emptyStateHtml('No sources yet.');
  }
}
