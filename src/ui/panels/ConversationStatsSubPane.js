import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { SubPaneHeader } from './SubPaneHeader.js';
import { average } from '../../math/average.js';
import { createElement } from '../../dom/createElement.js';
import { emptyStateHtml } from '../html/emptyStateHtml.js';
import { entriesByDescendingCount } from '../../math/entriesByDescendingCount.js';
import { formatDuration } from '../../time/formatDuration.js';
import { valueRowHtml } from '../html/valueRowHtml.js';
import stylesheet from './ConversationStatsSubPane.css';

StyleRegistry.register(stylesheet);

/**
 * A sub-pane showing usage stats scoped to just the pane's own conversation (turns, average
 * response time, estimated tokens, tool calls), rather than the totals across every chat that the
 * global Stats panel shows. It can be docked to the pane's left, top or right edge and closed.
 */
export class ConversationStatsSubPane {
  /**
   * Session whose conversation is shown.
   * @type {ChatSession}
   */
  #session;

  /**
   * Conversation statistics.
   * @type {StatsIndex}
   */
  #stats;

  /**
   * The sub-pane's root element.
   * @type {HTMLElement}
   */
  #element;

  /**
   * Undoes the subscriptions.
   * @type {Array<function(): void>}
   */
  #unsubscribers = [];

  /**
   * Builds the sub-pane.
   * @param {object} options Sub-pane options.
   * @param {ChatSession} options.session Session whose conversation is shown.
   * @param {StatsIndex} options.stats Conversation statistics.
   * @param {function(): void} options.onClose Called when × is clicked.
   * @param {function(string): void} options.onMove Called with 'left', 'top' or 'right' when an arrow is clicked.
   */
  constructor({ session, stats, onClose, onMove }) {
    this.#session = session;
    this.#stats = stats;
    this.#element = createElement('section', { className: 'claude-plus-subpane' });
    this.#element.addEventListener('click', event => this.#onClick(event, onClose, onMove));
    this.#unsubscribers.push(stats.subscribe('aggregate', () => this.render()), session.subscribe('openConversation', () => this.render()));
    this.render();
  }

  /**
   * The sub-pane's root element.
   * @returns {HTMLElement} The element.
   */
  get element() {
    return this.#element;
  }

  /**
   * Shows the open conversation's own stats, if it has any indexed yet.
   * @returns {Promise<void>} Resolves once rendered.
   */
  async render() {
    const conversationId = this.#session.openConversationId;
    this.#renderHeaderAndBody(conversationId ? null : emptyStateHtml('Start or open a chat to see its stats.'));
    if (!conversationId) return;
    const summary = await this.#stats.summaryFor(conversationId);
    if (this.#session.openConversationId !== conversationId) return;
    this.#renderHeaderAndBody(summary ? ConversationStatsSubPane.#summaryHtml(summary) : emptyStateHtml('Not indexed yet — send a message or wait a moment.'));
  }

  /**
   * Removes the sub-pane.
   * @returns {void}
   */
  dispose() {
    this.#unsubscribers.forEach(unsubscribe => unsubscribe());
    this.#element.remove();
  }

  /**
   * Runs a header click; other clicks are ignored.
   * @param {MouseEvent} event Click inside the sub-pane.
   * @param {function(): void} onClose Close callback.
   * @param {function(string): void} onMove Redock callback.
   * @returns {void}
   */
  #onClick(event, onClose, onMove) {
    if (event.target.closest('header')) SubPaneHeader.onClick(event, onClose, onMove);
  }

  /**
   * Replaces the sub-pane's content with the header and a body.
   * @param {string} bodyHtml The body's HTML.
   * @returns {void}
   */
  #renderHeaderAndBody(bodyHtml) {
    this.#element.innerHTML = `${SubPaneHeader.html('📈 Stats for this chat')}<div class="claude-plus-scrollable claude-plus-fill-remaining claude-plus-conversation-stats">${bodyHtml}</div>`;
  }

  /**
   * HTML of a conversation's stats: turns, response time, estimated tokens and a tool call ranking.
   * @param {ConversationSummary} summary The conversation's summary.
   * @returns {string} The HTML.
   */
  static #summaryHtml(summary) {
    const responseTimes = summary.responseTimesMs;
    const toolRanking = entriesByDescendingCount(summary.toolCallCounts);
    const rankingHtml = toolRanking.map(([toolName, count]) => valueRowHtml(toolName, count)).join('') || emptyStateHtml('No tool calls in this chat yet.');
    return `
      <div class="claude-plus-panel__section">${valueRowHtml('Turns', summary.promptCount)}${valueRowHtml('Avg response time', responseTimes.length ? formatDuration(average(responseTimes)) : '–')}</div>
      <div class="claude-plus-panel__section">${valueRowHtml('Est. tokens in / out', `~${summary.estimatedTokensIn.toLocaleString()} in / ~${summary.estimatedTokensOut.toLocaleString()} out`)}</div>
      <details class="claude-plus-panel__section" open><summary>Tool calls (${toolRanking.reduce((sum, [, count]) => sum + count, 0)})</summary>${rankingHtml}</details>`;
  }
}
