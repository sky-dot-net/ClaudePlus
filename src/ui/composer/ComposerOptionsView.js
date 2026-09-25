import { THINKING_MODES } from '../../config/THINKING_MODES.js';

/**
 * The composer's model, effort and extended thinking controls, kept in sync with the shared
 * composer settings in both directions.
 */
export class ComposerOptionsView {
  /**
   * Shared model options.
   * @type {ComposerSettings}
   */
  #settings;

  /**
   * Model select.
   * @type {HTMLSelectElement}
   */
  #modelSelect;

  /**
   * Effort select.
   * @type {HTMLSelectElement}
   */
  #effortSelect;

  /**
   * Extended thinking checkbox.
   * @type {HTMLInputElement}
   */
  #thinkingCheckbox;

  /**
   * Wires the controls to the settings and shows the current settings.
   * @param {object} controls The option controls.
   * @param {HTMLSelectElement} controls.modelSelect Model select.
   * @param {HTMLSelectElement} controls.effortSelect Effort select.
   * @param {HTMLInputElement} controls.thinkingCheckbox Extended thinking checkbox.
   * @param {ComposerSettings} settings Shared model options.
   */
  constructor({ modelSelect, effortSelect, thinkingCheckbox }, settings) {
    this.#settings = settings;
    this.#modelSelect = modelSelect;
    this.#effortSelect = effortSelect;
    this.#thinkingCheckbox = thinkingCheckbox;
    modelSelect.addEventListener('change', () => { settings.model = modelSelect.value; });
    effortSelect.addEventListener('change', () => { settings.effort = effortSelect.value; });
    thinkingCheckbox.addEventListener('change', () => { settings.thinkingMode = thinkingCheckbox.checked ? THINKING_MODES.extended : THINKING_MODES.off; });
    this.showSettings();
  }

  /**
   * Shows the current shared options in the controls.
   * @returns {void}
   */
  showSettings() {
    this.#modelSelect.value = this.#settings.model;
    this.#effortSelect.value = this.#settings.effort;
    this.#thinkingCheckbox.checked = this.#settings.thinkingMode === THINKING_MODES.extended;
  }
}
