import { createDialogShell } from './createDialogShell.js';

/**
 * Shows a themed modal in place of the native alert() dialog, for the same reason as
 * confirmDialog: repeated native dialogs can be silently disabled by the browser.
 * @param {string} message Message to show.
 * @returns {Promise<void>} Resolves once dismissed.
 */
export function alertDialog(message) {
  return new Promise(resolve => {
    const { overlay, dialog } = createDialogShell(message, '<button class="claude-plus-primary-button" data-name="ok">OK</button>');
    const finish = () => {
      overlay.remove();
      resolve();
    };
    dialog.querySelector('[data-name="ok"]').addEventListener('click', finish);
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) finish();
    });
    document.body.append(overlay);
  });
}
