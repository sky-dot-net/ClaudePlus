import { ActionDialog } from './ActionDialog.js';

/**
 * Shows a message with a single OK button; the themed replacement of alert().
 */
export class AlertDialog extends ActionDialog {
  /**
   * Shows a message and waits until it is dismissed.
   * @param {string} message Message to show.
   * @returns {Promise<void>} Resolves once dismissed.
   */
  static inform(message) {
    return new AlertDialog(message).show();
  }

  /**
   * Builds the OK button.
   * @returns {HTMLButtonElement[]} The button.
   */
  createActions() {
    return [this.createClosingButton('OK', true, () => undefined)];
  }
}
