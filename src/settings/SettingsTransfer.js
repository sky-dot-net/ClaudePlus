import { AlertDialog } from '../ui/dialogs/AlertDialog.js';
import { ConfirmDialog } from '../ui/dialogs/ConfirmDialog.js';
import { STORAGE_KEY_PREFIX } from '../config/STORAGE_KEY_PREFIX.js';
import { createElement } from '../dom/createElement.js';
import { downloadTextFile } from '../browser/downloadTextFile.js';

/**
 * Exports all ClaudePlus settings (every localStorage entry of the script: preferences, panes,
 * layouts, table columns, sub-pane docking) to a JSON file and imports them back. The indexed
 * conversation cache is not included; it can be rebuilt with "Index full history".
 */
export class SettingsTransfer {
  /**
   * Format marker of exported files.
   * @type {string}
   */
  static #FORMAT = 'ClaudePlus settings';

  /**
   * Settings storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Creates the transfer.
   * @param {Preferences} preferences Settings storage.
   */
  constructor(preferences) {
    this.#preferences = preferences;
  }

  /**
   * Downloads every setting as "ClaudePlus settings <date>.json".
   * @returns {void}
   */
  exportSettings() {
    const exportedAt = new Date().toISOString();
    const document = { format: SettingsTransfer.#FORMAT, exportedAt, settings: this.#preferences.entriesWithPrefix(STORAGE_KEY_PREFIX) };
    downloadTextFile(`ClaudePlus settings ${exportedAt.slice(0, 10)}.json`, `${JSON.stringify(document, null, 2)}\n`, 'application/json');
  }

  /**
   * Lets the user pick an exported file and imports it.
   * @returns {void}
   */
  chooseFileAndImport() {
    const input = createElement('input', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', () => this.#importFile(input.files[0]));
    input.click();
  }

  /**
   * Reads an exported file, asks for confirmation, replaces all settings and reloads the page.
   * Invalid files are reported in a dialog and change nothing.
   * @param {?File} file The chosen file.
   * @returns {Promise<void>} Resolves once imported, declined or failed.
   */
  async #importFile(file) {
    if (!file) return;
    try {
      const settings = SettingsTransfer.#parseSettings(await file.text());
      if (!(await ConfirmDialog.ask('Replace all ClaudePlus settings with the imported ones? The page reloads afterwards.', 'Import'))) return;
      this.#preferences.replaceEntriesWithPrefix(STORAGE_KEY_PREFIX, settings);
      location.reload();
    } catch (error) {
      await AlertDialog.inform(`Import failed: ${error.message}`);
    }
  }

  /**
   * Validates an exported file and extracts its settings.
   * @param {string} text File content.
   * @returns {Object<string, string>} Settings by storage key; only ClaudePlus keys with string values.
   * @throws {Error} When the content isn't a ClaudePlus settings file.
   */
  static #parseSettings(text) {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.format !== SettingsTransfer.#FORMAT || !parsed.settings || typeof parsed.settings !== 'object') throw new Error('this is not a ClaudePlus settings file');
    return Object.fromEntries(Object.entries(parsed.settings).filter(([key, value]) => key.startsWith(STORAGE_KEY_PREFIX) && typeof value === 'string'));
  }
}
