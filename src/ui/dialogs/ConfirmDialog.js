import { ActionDialog } from './ActionDialog.js';

/**
 * Asks a yes/no question with Cancel and a confirming button; the themed replacement of confirm().
 */
export class ConfirmDialog extends ActionDialog {
  /**
   * Label of the confirming button.
   * @type {string}
   */
  #confirmLabel;

  /**
   * Creates the dialog without showing it.
   * @param {string} message Question to show.
   * @param {string} confirmLabel Label of the confirming button.
   */
  constructor(message, confirmLabel) {
    super(message);
    this.#confirmLabel = confirmLabel;
  }

  /**
   * Asks a question and waits for the answer.
   * @param {string} message Question to show.
   * @param {string} [confirmLabel] Label of the confirming button.
   * @returns {Promise<boolean>} Resolves true if confirmed, false if cancelled.
   */
  static ask(message, confirmLabel = 'Confirm') {
    return new ConfirmDialog(message, confirmLabel).show();
  }

  /**
   * A dismissed question counts as not confirmed.
   * @returns {boolean} Always false.
   */
  get cancelValue() {
    return false;
  }

  /**
   * Builds the Cancel and confirming buttons.
   * @returns {HTMLButtonElement[]} The buttons.
   */
  createActions() {
    return [
      this.createClosingButton('Cancel', false, () => false),
      this.createClosingButton(this.#confirmLabel, true, () => true),
    ];
  }
}
