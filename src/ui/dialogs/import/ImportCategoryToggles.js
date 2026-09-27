import { IMPORT_OPTIONAL_CATEGORIES } from './IMPORT_OPTIONAL_CATEGORIES.js';
import { escapeHtml } from '../../../text/escapeHtml.js';

/**
 * The import screen's opt-out checkboxes, one per optional category found in the export, and the
 * classified files they narrow down to what is actually imported.
 */
export class ImportCategoryToggles {
  /**
   * Element holding the checkboxes.
   * @type {HTMLElement}
   */
  #container;

  /**
   * Creates the toggles in a hidden container.
   * @param {HTMLElement} container Element holding the checkboxes.
   */
  constructor(container) {
    this.#container = container;
  }

  /**
   * Shows one checked toggle per toggleable category found.
   * @param {object} classified The classified files.
   * @returns {void}
   */
  show(classified) {
    this.#container.hidden = false;
    this.#container.innerHTML = IMPORT_OPTIONAL_CATEGORIES
      .filter(category => category.toggleKey && category.isPresent(classified))
      .map(category => `<label class="claude-plus-import-dialog__toggle"><input type="checkbox" data-category-toggle="${category.toggleKey}" checked /> ${escapeHtml(category.toggleLabel)}</label>`)
      .join('');
  }

  /**
   * Hides the toggles.
   * @returns {void}
   */
  hide() {
    this.#container.hidden = true;
  }

  /**
   * The classified files, with any unchecked category's data cleared.
   * @param {object} classified The classified files.
   * @returns {object} The classified files to actually import.
   */
  applyTo(classified) {
    const applied = { ...classified };
    IMPORT_OPTIONAL_CATEGORIES
      .filter(category => category.toggleKey && !this.#isChecked(category.toggleKey))
      .flatMap(category => category.fields)
      .forEach(field => { applied[field] = Array.isArray(applied[field]) ? [] : null; });
    return applied;
  }

  /**
   * Whether a toggle is checked; missing (not shown, since its category wasn't found) counts as
   * checked, since there's nothing for it to exclude.
   * @param {string} toggleKey The toggle's data-category-toggle value.
   * @returns {boolean} True when checked or absent.
   */
  #isChecked(toggleKey) {
    return this.#container.querySelector(`[data-category-toggle="${toggleKey}"]`)?.checked ?? true;
  }
}
