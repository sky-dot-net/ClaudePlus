import { ActionDialog } from './ActionDialog.js';
import { createElement } from '../../dom/createElement.js';

/**
 * Asks for a line of text; the themed replacement of prompt(). Enter confirms.
 */
export class PromptDialog extends ActionDialog {
  /**
   * Label of the confirming button.
   * @type {string}
   */
  #confirmLabel;

  /**
   * The text input.
   * @type {HTMLInputElement}
   */
  #input;

  /**
   * Creates the dialog without showing it.
   * @param {string} message Question to show.
   * @param {string} initialValue Text the input starts with.
   * @param {string} confirmLabel Label of the confirming button.
   */
  constructor(message, initialValue, confirmLabel) {
    super(message);
    this.#confirmLabel = confirmLabel;
    this.#input = createElement('input', { type: 'text', className: 'claude-plus-dialog__input', value: initialValue });
    this.#input.addEventListener('keydown', event => {
      if (event.key === 'Enter') this.close(this.#input.value);
    });
  }

  /**
   * Asks for a line of text and waits for the answer.
   * @param {string} message Question to show.
   * @param {string} initialValue Text the input starts with.
   * @param {string} confirmLabel Label of the confirming button.
   * @returns {Promise<?string>} Resolves with the entered text, or null if cancelled.
   */
  static ask(message, initialValue, confirmLabel) {
    return new PromptDialog(message, initialValue, confirmLabel).show();
  }

  /**
   * A dismissed prompt yields no text.
   * @returns {null} Always null.
   */
  get cancelValue() {
    return null;
  }

  /**
   * Places the text input below the message.
   * @returns {HTMLElement[]} The input.
   */
  createBody() {
    return [this.#input];
  }

  /**
   * Builds the Cancel and confirming buttons.
   * @returns {HTMLButtonElement[]} The buttons.
   */
  createActions() {
    return [
      this.createClosingButton('Cancel', false, () => null),
      this.createClosingButton(this.#confirmLabel, true, () => this.#input.value),
    ];
  }

  /**
   * Focuses the input so typing starts right away.
   * @returns {void}
   */
  afterShow() {
    this.#input.focus();
  }
}
