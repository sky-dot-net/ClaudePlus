import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import stylesheet from './PendingQuoteView.css';

StyleRegistry.register(stylesheet);

/**
 * The single quote (if any) attached to the next prompt, shown as a removable chip - claude.ai's
 * "Reply" flow: select text, quote it, send it as a small attachment alongside the prompt.
 */
export class PendingQuoteView {
  /**
   * Characters of the quoted text shown in the chip before truncating.
   * @type {number}
   */
  static #PREVIEW_LENGTH = 40;

  /**
   * Element showing the chip; hidden while there's no pending quote.
   * @type {HTMLElement}
   */
  #container;

  /**
   * The pending quote, or null.
   * @type {?{text: string, sender: string}}
   */
  #quote = null;

  /**
   * Creates the view and handles clicks on the chip's remove button.
   * @param {HTMLElement} container Element showing the chip.
   */
  constructor(container) {
    this.#container = container;
    container.addEventListener('click', event => this.#onRemoveClick(event));
  }

  /**
   * Whether a quote is pending.
   * @returns {boolean} True while one is attached.
   */
  get hasQuote() {
    return Boolean(this.#quote);
  }

  /**
   * Attaches a quote, replacing one already pending.
   * @param {string} text Quoted text.
   * @param {string} sender Sender of the message it was quoted from.
   * @returns {void}
   */
  set(text, sender) {
    this.#quote = { text, sender };
    this.#render();
  }

  /**
   * Returns the pending quote and clears it.
   * @returns {?{text: string, sender: string}} The quote, or null when there wasn't one.
   */
  take() {
    const quote = this.#quote;
    this.clear();
    return quote;
  }

  /**
   * Discards the pending quote, if any.
   * @returns {void}
   */
  clear() {
    if (!this.#quote) return;
    this.#quote = null;
    this.#render();
  }

  /**
   * Clears the pending quote when its remove button is clicked.
   * @param {MouseEvent} event Click inside the container.
   * @returns {void}
   */
  #onRemoveClick(event) {
    if (event.target.closest('[data-action="removeQuote"]')) this.clear();
  }

  /**
   * Shows or hides the chip for the current quote.
   * @returns {void}
   */
  #render() {
    this.#container.hidden = !this.#quote;
    this.#container.innerHTML = this.#quote ? PendingQuoteView.#chipHtml(this.#quote) : '';
  }

  /**
   * HTML of the chip: an icon, a line count, a truncated preview and a remove button.
   * @param {{text: string, sender: string}} quote The pending quote.
   * @returns {string} The chip.
   */
  static #chipHtml(quote) {
    const lineCount = quote.text.split('\n').length;
    const preview = quote.text.length > PendingQuoteView.#PREVIEW_LENGTH ? `${quote.text.slice(0, PendingQuoteView.#PREVIEW_LENGTH)}…` : quote.text;
    return `
      <span class="claude-plus-pending-quote">
        <span class="claude-plus-pending-quote__label">💬 Quote, ${lineCount} line${lineCount === 1 ? '' : 's'}</span>
        <span class="claude-plus-pending-quote__preview">${escapeHtml(preview)}</span>
        <button class="claude-plus-pending-quote__remove" data-action="removeQuote" title="Remove quote">×</button>
      </span>`;
  }
}
