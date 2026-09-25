import { createDialogShell } from './createDialogShell.js';
import { escapeHtml } from '../../text/escapeHtml.js';

/**
 * Shows a themed modal in place of the native confirm() dialog, which Chrome silently disables
 * ("prevent this page from creating additional dialogs") after repeated use on the same page,
 * making a delete button appear to do nothing with no feedback.
 * @param {string} message Question to show.
 * @param {string} [confirmLabel] Label of the confirming button.
 * @returns {Promise<boolean>} Resolves true if confirmed, false if cancelled.
 */
export function confirmDialog(message, confirmLabel = 'Confirm') {
  return new Promise(resolve => {
    const { overlay, dialog } = createDialogShell(message, `
      <button class="claude-plus-toolbar__button" data-name="cancel">Cancel</button>
      <button class="claude-plus-primary-button" data-name="confirm">${escapeHtml(confirmLabel)}</button>`);
    const finish = result => {
      overlay.remove();
      resolve(result);
    };
    dialog.querySelector('[data-name="cancel"]').addEventListener('click', () => finish(false));
    dialog.querySelector('[data-name="confirm"]').addEventListener('click', () => finish(true));
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) finish(false);
    });
    document.body.append(overlay);
  });
}
