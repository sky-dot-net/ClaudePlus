import { createElement } from '../../dom/createElement.js';

/**
 * Builds the overlay and dialog box shared by confirmDialog and alertDialog.
 * @param {string} message Message to show.
 * @param {string} actionsHtml HTML of the action buttons.
 * @returns {{overlay: HTMLElement, dialog: HTMLElement}} The overlay and the dialog inside it.
 */
export function createDialogShell(message, actionsHtml) {
  const overlay = createElement('div', { className: 'claude-plus-themed claude-plus-dialog-overlay' });
  const dialog = createElement('div', {
    className: 'claude-plus-dialog',
    innerHTML: `<p class="claude-plus-dialog__message"></p><div class="claude-plus-dialog__actions">${actionsHtml}</div>`,
  });
  dialog.querySelector('.claude-plus-dialog__message').textContent = message;
  overlay.append(dialog);
  return { overlay, dialog };
}
