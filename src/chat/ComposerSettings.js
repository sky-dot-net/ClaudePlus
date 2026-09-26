import { EventEmitter } from '../core/EventEmitter.js';
import { STORAGE_KEYS } from '../config/STORAGE_KEYS.js';
import { THINKING_MODES } from '../config/THINKING_MODES.js';

/**
 * Composer options persisted in localStorage, shared by all chat panes. Values outside the allowed
 * list read as the default.
 * @fires ComposerSettings#settings An option changed.
 */
export class ComposerSettings extends EventEmitter {
  /**
   * Backing storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * The selectable models and effort levels.
   * @type {ModelCatalog}
   */
  #modelCatalog;

  /**
   * Creates the settings on top of a preference store.
   * @param {Preferences} preferences Backing storage.
   * @param {ModelCatalog} modelCatalog The selectable models and effort levels.
   */
  constructor(preferences, modelCatalog) {
    super();
    this.#preferences = preferences;
    this.#modelCatalog = modelCatalog;
  }

  /**
   * Selected model id.
   * @returns {string} An id from the model catalog.
   */
  get model() {
    return this.#readAllowed(STORAGE_KEYS.model, this.#modelCatalog.models.map(option => option.id));
  }

  /**
   * Selects a model; ids not in the model catalog are ignored.
   * @param {string} modelId Model id.
   */
  set model(modelId) {
    this.#writeIfAllowed(STORAGE_KEYS.model, modelId, this.#modelCatalog.models.map(option => option.id));
  }

  /**
   * Selected effort level.
   * @returns {string} An id from the model catalog.
   */
  get effort() {
    return this.#readAllowed(STORAGE_KEYS.effort, this.#modelCatalog.efforts.map(option => option.id));
  }

  /**
   * Selects an effort level; ids not in the model catalog are ignored.
   * @param {string} effortId Effort id.
   */
  set effort(effortId) {
    this.#writeIfAllowed(STORAGE_KEYS.effort, effortId, this.#modelCatalog.efforts.map(option => option.id));
  }

  /**
   * Selected thinking mode.
   * @returns {string} A value of THINKING_MODES.
   */
  get thinkingMode() {
    return this.#readAllowed(STORAGE_KEYS.thinkingMode, Object.values(THINKING_MODES));
  }

  /**
   * Selects a thinking mode; values not in THINKING_MODES are ignored.
   * @param {string} thinkingMode Thinking mode.
   */
  set thinkingMode(thinkingMode) {
    this.#writeIfAllowed(STORAGE_KEYS.thinkingMode, thinkingMode, Object.values(THINKING_MODES));
  }

  /**
   * Current values for a completion request.
   * @returns {ComposerSnapshot} The options.
   */
  snapshot() {
    return { model: this.model, effort: this.effort, thinkingMode: this.thinkingMode };
  }

  /**
   * Reads a stored option.
   * @param {string} key Storage key.
   * @param {string[]} allowedValues Allowed values; the first is the default.
   * @returns {string} The stored value if allowed, otherwise the default.
   */
  #readAllowed(key, allowedValues) {
    const storedValue = this.#preferences.read(key);
    return allowedValues.includes(storedValue) ? storedValue : allowedValues[0];
  }

  /**
   * Stores an option if it is allowed and announces the change.
   * @param {string} key Storage key.
   * @param {string} value Value to store.
   * @param {string[]} allowedValues Allowed values.
   * @returns {void}
   */
  #writeIfAllowed(key, value, allowedValues) {
    if (!allowedValues.includes(value)) return;
    this.#preferences.write(key, value);
    this.publish('settings');
  }
}
