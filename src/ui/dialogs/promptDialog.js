import { createDialogShell } from './createDialogShell.js';
import { createElement } from '../../dom/createElement.js';
import { escapeHtml } from '../../text/escapeHtml.js';

/**
 * Shows a themed modal asking for a line of text, for the same reason as confirmDialog.
 * @param {string} message Question to show.
 * @param {string} initialValue Text the input starts with.
 * @param {string} confirmLabel Label of the confirming button.
 * @returns {Promise<?string>} Resolves with the entered text, or null if cancelled.
 */
export function promptDialog(message, initialValue, confirmLabel) {
  return new Promise((resolve) => {
    const { overlay, dialog } = createDialogShell(message, `
      <button class="claude-plus-toolbar__button" data-name="cancel">Cancel</button>
      <button class="claude-plus-primary-button" data-name="confirm">${escapeHtml(confirmLabel)}</button>`);
    const input = createElement('input', { type: 'text', className: 'claude-plus-dialog__input', value: initialValue });
    dialog.querySelector('.claude-plus-dialog__message').after(input);
    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };
    dialog.querySelector('[data-name="cancel"]').addEventListener('click', () => finish(null));
    dialog.querySelector('[data-name="confirm"]').addEventListener('click', () => finish(input.value));
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') finish(input.value); });
    document.body.append(overlay);
    input.focus();
  });
}
