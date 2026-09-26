import { EFFORTS } from '../config/EFFORTS.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { LOG_PREFIX } from '../config/LOG_PREFIX.js';
import { MODELS } from '../config/MODELS.js';
import { ModelCatalogSource } from './ModelCatalogSource.js';
import { STORAGE_KEYS } from '../config/STORAGE_KEYS.js';
import { TIMING } from '../config/TIMING.js';

/**
 * The selectable models and effort levels, kept in sync with claude.ai's own roster instead of a
 * list hardcoded here that would go stale as models are added or retired. Starts from the small
 * built-in fallback (or a cached extraction, if one isn't stale yet), then refreshes in the
 * background; refresh() is safe to call repeatedly, since a fresh-enough cache or an already
 * running extraction is reused rather than repeated.
 * @fires ModelCatalog#catalog The live lists changed.
 */
export class ModelCatalog extends EventEmitter {
  /**
   * Cache storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Current model list.
   * @type {ChoiceOption[]}
   */
  #models = MODELS;

  /**
   * Current effort list.
   * @type {ChoiceOption[]}
   */
  #efforts = EFFORTS;

  /**
   * When the current lists were last extracted; null for the built-in fallback.
   * @type {?number}
   */
  #fetchedAt = null;

  /**
   * A refresh already in flight, reused by a concurrent call instead of starting another.
   * @type {?Promise<void>}
   */
  #refreshPromise = null;

  /**
   * Creates the catalog on top of a cache, applying it immediately if it isn't stale.
   * @param {Preferences} preferences Cache storage.
   */
  constructor(preferences) {
    super();
    this.#preferences = preferences;
    this.#loadCached();
  }

  /**
   * Selectable models; the first is the default.
   * @returns {ChoiceOption[]} The list.
   */
  get models() {
    return this.#models;
  }

  /**
   * Selectable effort levels; the first is the default.
   * @returns {ChoiceOption[]} The list.
   */
  get efforts() {
    return this.#efforts;
  }

  /**
   * Extracts the live lists if the current ones are stale (or were never extracted), then caches
   * and publishes them. A failure is logged and leaves the previous lists in place.
   * @returns {Promise<void>} Resolves once refreshed, reused, or failed.
   */
  refresh() {
    if (!this.#isStale()) return Promise.resolve();
    this.#refreshPromise ??= this.#runRefresh().finally(() => { this.#refreshPromise = null; });
    return this.#refreshPromise;
  }

  /**
   * Runs one extraction and applies it, or logs and keeps the previous lists on failure.
   * @returns {Promise<void>} Resolves once applied or failed.
   */
  async #runRefresh() {
    try {
      const { models, efforts } = await ModelCatalogSource.extract();
      this.#apply(ModelCatalog.#withPreferredDefaultFirst(models), efforts.length ? efforts : this.#efforts, Date.now());
      this.#preferences.writeJson(STORAGE_KEYS.modelCatalog, { fetchedAt: this.#fetchedAt, models: this.#models, efforts: this.#efforts });
    } catch (error) {
      console.warn(LOG_PREFIX, 'extracting the live model list failed; keeping the previous list', error);
    }
  }

  /**
   * Moves the built-in fallback's own default model to the front of a freshly extracted list, so
   * a user who never picked one keeps getting a sensible default instead of whatever claude.ai's
   * own menu happens to render first (which can be a credit-gated model like Fable). A list
   * without that id, or already led by it, is returned as is.
   * @param {ChoiceOption[]} models Freshly extracted models.
   * @returns {ChoiceOption[]} The models, reordered if needed.
   */
  static #withPreferredDefaultFirst(models) {
    const preferredIndex = models.findIndex(model => model.id === MODELS[0].id);
    if (preferredIndex <= 0) return models;
    const reordered = [...models];
    const [preferred] = reordered.splice(preferredIndex, 1);
    reordered.unshift(preferred);
    return reordered;
  }

  /**
   * Applies a cached catalog if it looks valid.
   * @returns {void}
   */
  #loadCached() {
    const cached = this.#preferences.readJson(STORAGE_KEYS.modelCatalog);
    if (ModelCatalog.#looksValid(cached)) this.#apply(cached.models, cached.efforts, cached.fetchedAt);
  }

  /**
   * Whether the current lists are stale enough to warrant a fresh extraction.
   * @returns {boolean} True for the built-in fallback or a cache past its TTL.
   */
  #isStale() {
    return this.#fetchedAt === null || Date.now() - this.#fetchedAt > TIMING.modelCatalogTtlMs;
  }

  /**
   * Replaces the current lists and publishes the change.
   * @param {ChoiceOption[]} models New model list.
   * @param {ChoiceOption[]} efforts New effort list.
   * @param {number} fetchedAt When this list was extracted.
   * @returns {void}
   */
  #apply(models, efforts, fetchedAt) {
    this.#models = models;
    this.#efforts = efforts;
    this.#fetchedAt = fetchedAt;
    this.publish('catalog');
  }

  /**
   * Whether a cached value looks like a usable catalog.
   * @param {*} cached The parsed cache entry.
   * @returns {boolean} True when it carries non-empty model and effort arrays.
   */
  static #looksValid(cached) {
    return Boolean(cached) && Array.isArray(cached.models) && cached.models.length > 0 && Array.isArray(cached.efforts) && cached.efforts.length > 0;
  }
}
