import { Panel } from './Panel.js';
import { average } from '../../math/average.js';
import { emptyStateHtml } from '../html/emptyStateHtml.js';
import { entriesByDescendingCount } from '../../math/entriesByDescendingCount.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import { formatDuration } from '../../time/formatDuration.js';
import { formatUtilization } from '../../stats/formatUtilization.js';
import { valueRowHtml } from '../html/valueRowHtml.js';

/**
 * Activity, usage, token estimates, tool calls and the history backfill.
 */
export class StatsPanel extends Panel {
  /**
   * Conversation statistics.
   * @type {StatsIndex}
   */
  #stats;

  /**
   * Active-time tracking.
   * @type {ActivityTracker}
   */
  #activity;

  /**
   * Usage windows.
   * @type {RateLimitMonitor}
   */
  #rateLimits;

  /**
   * Creates the panel.
   * @param {StatsIndex} stats Conversation statistics.
   * @param {ActivityTracker} activity Active-time tracking.
   * @param {RateLimitMonitor} rateLimits Usage windows.
   */
  constructor(stats, activity, rateLimits) {
    super('Stats');
    this.#stats = stats;
    this.#activity = activity;
    this.#rateLimits = rateLimits;
  }

  /**
   * HTML of the panel body.
   * @returns {string} The stat sections.
   */
  createBodyHtml() {
    const row = StatsPanel.#namedValueRowHtml;
    return `
      <div class="claude-plus-panel__section">${row('Active today', 'activeToday')}${row('Active all-time', 'activeAllTime')}${row('Status', 'activityStatus')}</div>
      <div class="claude-plus-panel__section">${row('Turns (all chats)', 'promptCount')}${row('Avg response time', 'averageResponseTime')}</div>
      <div class="claude-plus-panel__section">${row('Session limit (5h)', 'sessionLimit')}${row('Weekly limit', 'weeklyLimit')}</div>
      <div class="claude-plus-panel__section">${row('Est. tokens in / out', 'estimatedTokens')}
        <div class="claude-plus-hint">Estimated from text length — claude.ai doesn't expose real token counts.</div></div>
      <details class="claude-plus-panel__section" open><summary>Tool calls (<span data-name="toolCallTotal">0</span>)</summary><div class="claude-plus-scrollable" data-name="toolCallRanking"></div></details>
      <div class="claude-plus-panel__section">
        <button class="claude-plus-primary-button claude-plus-full-width" data-name="backfillButton">Index full history</button>
        <div class="claude-plus-hint" data-name="backfillStatus"></div>
        <div class="claude-plus-spaced-above">${row('Conversations indexed', 'indexedConversationCount')}</div>
        <div class="claude-plus-hint" data-name="staleRecordHint" hidden></div>
      </div>`;
  }

  /**
   * Wires the backfill button and follows every data source.
   * @returns {void}
   */
  bindEvents() {
    this.elements.backfillButton.addEventListener('click', () => this.#toggleBackfill());
    this.listenTo(this.#activity, 'activity', () => this.#renderActivity());
    this.listenTo(this.#rateLimits, 'rateLimits', () => this.#renderRateLimits());
    this.listenTo(this.#stats, 'aggregate', () => this.#renderAggregate());
    this.listenTo(this.#stats, 'backfill', () => this.#renderBackfill());
  }

  /**
   * Renders every section.
   * @returns {void}
   */
  render() {
    this.#renderActivity();
    this.#renderRateLimits();
    this.#renderAggregate();
    this.#renderBackfill();
  }

  /**
   * HTML of a labelled value filled in later through its data-name.
   * @param {string} label Row label.
   * @param {string} valueName data-name of the value element.
   * @returns {string} The row.
   */
  static #namedValueRowHtml(label, valueName) {
    return `<div class="claude-plus-value-row"><span>${escapeHtml(label)}</span><b data-name="${valueName}">–</b></div>`;
  }

  /**
   * Starts the backfill, or cancels it while running.
   * @returns {void}
   */
  #toggleBackfill() {
    if (this.#stats.backfill.isRunning) this.#stats.cancelBackfill();
    else this.#stats.runBackfill();
  }

  /**
   * Shows active time and idle state.
   * @returns {void}
   */
  #renderActivity() {
    this.elements.activeToday.textContent = formatDuration(this.#activity.activeTodayMs);
    this.elements.activeAllTime.textContent = formatDuration(this.#activity.activeAllTimeMs);
    this.elements.activityStatus.textContent = this.#activity.isIdle ? 'idle' : 'active';
  }

  /**
   * Shows the usage windows, once known.
   * @returns {void}
   */
  #renderRateLimits() {
    const limits = this.#rateLimits.limits;
    if (!limits) return;
    this.elements.sessionLimit.textContent = formatUtilization(limits.fiveHour);
    this.elements.weeklyLimit.textContent = formatUtilization(limits.sevenDay);
  }

  /**
   * Shows the totals and the tool call ranking.
   * @returns {void}
   */
  #renderAggregate() {
    const aggregate = this.#stats.aggregate;
    const toolRanking = entriesByDescendingCount(aggregate.toolCallCounts);
    const responseTimes = aggregate.responseTimesMs;
    this.elements.promptCount.textContent = aggregate.promptCount;
    this.elements.averageResponseTime.textContent = responseTimes.length ? formatDuration(average(responseTimes)) : '–';
    this.elements.estimatedTokens.textContent = `~${aggregate.estimatedTokensIn.toLocaleString()} in / ~${aggregate.estimatedTokensOut.toLocaleString()} out`;
    this.elements.indexedConversationCount.textContent = aggregate.conversationCount;
    this.elements.staleRecordHint.hidden = aggregate.skippedRecordCount === 0;
    this.elements.staleRecordHint.textContent = `${aggregate.skippedRecordCount} stored record(s) look stale and were skipped — consider running "Index full history".`;
    this.elements.toolCallTotal.textContent = toolRanking.reduce((sum, [, count]) => sum + count, 0);
    this.elements.toolCallRanking.innerHTML = toolRanking.map(([toolName, count]) => valueRowHtml(toolName, count)).join('') || emptyStateHtml('No tool calls indexed yet.');
  }

  /**
   * Shows the backfill button label and progress.
   * @returns {void}
   */
  #renderBackfill() {
    const progress = this.#stats.backfill;
    this.elements.backfillButton.textContent = progress.isRunning ? 'Cancel indexing' : 'Index full history';
    this.elements.backfillStatus.textContent = StatsPanel.#backfillStatusText(progress);
  }

  /**
   * Status line under the backfill button.
   * @param {BackfillProgress} progress Backfill state.
   * @returns {string} Progress while running, the last result after a run, or a hint before any.
   */
  static #backfillStatusText({ isRunning, processedCount, totalCount }) {
    if (isRunning) return `Indexing… ${processedCount} / ${totalCount}`;
    if (totalCount) return `Last run: ${processedCount} / ${totalCount} indexed`;
    return 'Not run yet — pulls every past conversation once.';
  }
}
