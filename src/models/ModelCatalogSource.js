import { TIMING } from '../config/TIMING.js';
import { createElement } from '../dom/createElement.js';
import { wait } from '../time/wait.js';

/**
 * Effort labels for known ids, since claude.ai's effort submenu doesn't render its options as
 * cleanly labelled text as the model list does. An id outside this map still works, with a label
 * derived from the id itself.
 * @type {Readonly<Record<string, string>>}
 */
const KNOWN_EFFORT_LABELS = Object.freeze({ low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra effort', max: 'Max effort' });

/**
 * Reads the live model and effort lists straight from claude.ai's own composer, run fresh and
 * self-contained in a hidden same-origin iframe: the same "never touch the page's own native app
 * instance" approach used to extract widgets. claude.ai doesn't expose this as an API either - its
 * own dropdown list is compiled into its client bundle - so the only way to stay in sync with a
 * roster that changes regularly is to read the choices it renders for itself.
 */
export class ModelCatalogSource {
  /**
   * Extracts the current model and effort lists.
   * @returns {Promise<{models: ChoiceOption[], efforts: ChoiceOption[]}>} The lists.
   * @throws {Error} When the composer or its option menus don't appear within the timeout.
   */
  static async extract() {
    const iframe = ModelCatalogSource.#createHiddenIframe();
    document.body.append(iframe);
    try {
      return await ModelCatalogSource.#readFromFrame(iframe);
    } finally {
      iframe.remove();
    }
  }

  /**
   * Creates a hidden iframe pointed at a fresh chat, ready to append.
   * @returns {HTMLIFrameElement} The iframe.
   */
  static #createHiddenIframe() {
    return createElement('iframe', { src: 'https://claude.ai/new', style: 'position:fixed; top:-9999px; left:-9999px; width:900px; height:900px; border:0;' });
  }

  /**
   * Opens the model dropdown and its effort submenu in turn and reads each one's options.
   * @param {HTMLIFrameElement} iframe The extraction iframe.
   * @returns {Promise<{models: ChoiceOption[], efforts: ChoiceOption[]}>} The lists.
   * @throws {Error} When a step doesn't appear within the timeout.
   */
  static async #readFromFrame(iframe) {
    const deadline = Date.now() + TIMING.modelCatalogTimeoutMs;
    const dropdownTrigger = await ModelCatalogSource.#waitFor(iframe, doc => doc.querySelector('[data-testid="model-selector-dropdown"]'), deadline);
    dropdownTrigger.click();
    const models = await ModelCatalogSource.#waitForOptions(iframe, '[data-model-id]', deadline, ModelCatalogSource.#modelOption);
    const effortTrigger = await ModelCatalogSource.#waitFor(iframe, doc => ModelCatalogSource.#effortMenuTrigger(doc), deadline);
    effortTrigger.click();
    const efforts = await ModelCatalogSource.#waitForOptions(iframe, '[data-effort-id]', deadline, ModelCatalogSource.#effortOption);
    if (!models.length) throw new Error('model list did not render within the timeout');
    return { models, efforts };
  }

  /**
   * The effort submenu's own trigger item, found by its label rather than a fixed id.
   * @param {Document} doc The iframe's document.
   * @returns {?HTMLElement} The trigger, or null when not rendered yet.
   */
  static #effortMenuTrigger(doc) {
    return [...doc.querySelectorAll('[role="menuitem"]')].find(item => /^Effort\b/.test(item.textContent.trim())) ?? null;
  }

  /**
   * Polls the iframe's document until a query returns a truthy result or the deadline passes.
   * @param {HTMLIFrameElement} iframe The extraction iframe.
   * @param {function(Document): *} query Reads the desired value from the document.
   * @param {number} deadline Epoch ms after which to give up.
   * @returns {Promise<*>} The query's result.
   * @throws {Error} When the deadline passes without a result.
   */
  static async #waitFor(iframe, query, deadline) {
    while (Date.now() < deadline) {
      const doc = ModelCatalogSource.#documentOf(iframe);
      const result = doc ? query(doc) : null;
      if (result) return result;
      await wait(TIMING.modelCatalogPollMs);
    }
    throw new Error('claude.ai did not render the expected control within the timeout');
  }

  /**
   * Polls for a menu's options to appear, mapping each to a choice once they do.
   * @param {HTMLIFrameElement} iframe The extraction iframe.
   * @param {string} selector Selector matching each option element.
   * @param {number} deadline Epoch ms after which to give up (returns whatever is found by then).
   * @param {function(HTMLElement): ChoiceOption} toOption Reads one option element's choice.
   * @returns {Promise<ChoiceOption[]>} The options, in the order rendered; empty past the deadline.
   */
  static async #waitForOptions(iframe, selector, deadline, toOption) {
    while (Date.now() < deadline) {
      const doc = ModelCatalogSource.#documentOf(iframe);
      const items = doc ? [...doc.querySelectorAll(selector)] : [];
      if (items.length) return items.map(toOption);
      await wait(TIMING.modelCatalogPollMs);
    }
    return [];
  }

  /**
   * A model menu item's choice: its id and its clean display label, without the description or
   * "requires usage credits" badge that share the same item.
   * @param {HTMLElement} item The menu item.
   * @returns {ChoiceOption} The choice.
   */
  static #modelOption(item) {
    const truncated = item.querySelectorAll('.truncate');
    const label = (truncated[1] ?? truncated[0])?.textContent?.trim();
    return { id: item.getAttribute('data-model-id'), label: label || item.getAttribute('data-model-id') };
  }

  /**
   * An effort menu item's choice: its id, labelled from the known map or derived from the id.
   * @param {HTMLElement} item The menu item.
   * @returns {ChoiceOption} The choice.
   */
  static #effortOption(item) {
    const id = item.getAttribute('data-effort-id');
    return { id, label: KNOWN_EFFORT_LABELS[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)} effort` };
  }

  /**
   * The iframe's document, or null while it can't be read (not yet navigated, still loading).
   * @param {HTMLIFrameElement} iframe The extraction iframe.
   * @returns {?Document} The document, or null.
   */
  static #documentOf(iframe) {
    try {
      return iframe.contentDocument;
    } catch {
      return null;
    }
  }
}
