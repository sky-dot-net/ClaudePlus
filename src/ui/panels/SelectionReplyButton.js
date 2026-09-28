import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { createElement } from '../../dom/createElement.js';
import stylesheet from './SelectionReplyButton.css';

StyleRegistry.register(stylesheet);

/**
 * The floating "Reply" button claude.ai shows above a text selection, offering to quote it.
 */
export class SelectionReplyButton {
  /**
   * The button, while shown.
   * @type {?HTMLElement}
   */
  #buttonElement = null;

  /**
   * Called when the button is clicked.
   * @type {?function(): void}
   */
  #onReply = null;

  /**
   * Shows the button above a rectangle, replacing one already shown.
   * @param {DOMRect} aboveRect Viewport rectangle to show the button above.
   * @param {function(): void} onReply Called when the button is clicked.
   * @returns {void}
   */
  show(aboveRect, onReply) {
    this.hide();
    this.#onReply = onReply;
    this.#buttonElement = createElement('button', { className: 'claude-plus-selection-reply', textContent: '↩ Reply' });
    Object.assign(this.#buttonElement.style, { left: `${aboveRect.left + window.scrollX}px`, top: `${aboveRect.top + window.scrollY}px` });
    document.body.append(this.#buttonElement);
    this.#buttonElement.style.top = `${aboveRect.top + window.scrollY - this.#buttonElement.offsetHeight - 6}px`;
    this.#buttonElement.addEventListener('mousedown', this.#handleClick);
    document.addEventListener('mousedown', this.#handleOutsidePress, true);
  }

  /**
   * Hides the button if shown.
   * @returns {void}
   */
  hide() {
    if (!this.#buttonElement) return;
    this.#buttonElement.remove();
    this.#buttonElement = null;
    this.#onReply = null;
    document.removeEventListener('mousedown', this.#handleOutsidePress, true);
  }

  /**
   * Runs the reply callback and hides the button. mousedown (not click) so it fires before the
   * document-level mousedown handler that would otherwise clear the selection first.
   * @param {MouseEvent} event The press.
   * @returns {void}
   */
  #handleClick = (event) => {
    event.preventDefault();
    const onReply = this.#onReply;
    this.hide();
    onReply();
  };

  /**
   * Hides the button when the pointer is pressed anywhere else, which also lets that press collapse
   * the selection natively instead of the button swallowing it.
   * @param {MouseEvent} event Mouse press anywhere.
   * @returns {void}
   */
  #handleOutsidePress = (event) => {
    if (!this.#buttonElement.contains(event.target)) this.hide();
  };
}
