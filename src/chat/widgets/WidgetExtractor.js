import { DATABASE } from '../../config/DATABASE.js';
import { LOG_PREFIX } from '../../config/LOG_PREFIX.js';
import { WidgetHash } from './WidgetHash.js';
import { WidgetIframeSource } from './WidgetIframeSource.js';
import { WidgetMount } from './WidgetMount.js';

/**
 * Renders a widget tool call's real card into a slot element: a cached copy if this exact widget
 * (by tool name and data) was extracted before, or a fresh extraction from a hidden iframe
 * otherwise. Stylesheets are fetched once per session and reused across every widget.
 */
export class WidgetExtractor {
  /**
   * A stylesheet URL's already-started fetch, kept for the page's lifetime so every widget shares it.
   * @type {Map<string, Promise<string>>}
   */
  #cssPromisesByHref = new Map();

  /**
   * Persisted extracted-card cache.
   * @type {IndexedDbStore}
   */
  #database;

  /**
   * Creates the extractor on top of a persisted cache.
   * @param {IndexedDbStore} database Persisted extracted-card cache.
   */
  constructor(database) {
    this.#database = database;
  }

  /**
   * Fills a slot element with a widget's real card, from cache or by extracting it fresh.
   * @param {HTMLElement} container Slot element to fill.
   * @param {?string} conversationId Conversation the widget's message belongs to; null for an
   * unsaved local message, which can't be extracted.
   * @param {{toolName: string, data: object, toolUseId: string}} job The widget to render.
   * @returns {Promise<void>} Resolves once the slot has been filled, with the card or a failure message.
   */
  async render(container, conversationId, job) {
    try {
      const card = await this.#cardFor(conversationId, job);
      WidgetMount.show(container, card);
    } catch (error) {
      WidgetMount.showUnavailable(container, `Couldn't render this widget (${job.toolName}).`);
      console.warn(LOG_PREFIX, 'widget extraction failed', error);
    }
  }

  /**
   * A widget's card, from the persisted cache if present, else freshly extracted and cached.
   * @param {?string} conversationId Conversation the widget's message belongs to.
   * @param {{toolName: string, data: object, toolUseId: string}} job The widget to render.
   * @returns {Promise<{html: string, css: string}>} The card.
   * @throws {Error} When there is no conversation to extract from, or extraction fails.
   */
  async #cardFor(conversationId, job) {
    const hash = await WidgetHash.hashOf(job.toolName, job.data);
    const cached = await this.#database.read(DATABASE.stores.widgetCards, hash);
    if (cached) return cached;
    if (!conversationId) throw new Error('no conversation to extract this widget from');
    const card = await this.#extract(conversationId, job.toolUseId);
    await this.#database.write(DATABASE.stores.widgetCards, { hash, ...card });
    return card;
  }

  /**
   * Extracts a widget's card and its stylesheets' combined text.
   * @param {string} conversationId Conversation the widget's message belongs to.
   * @param {string} toolUseId Id of the widget's tool_use block.
   * @returns {Promise<{html: string, css: string}>} The card.
   */
  async #extract(conversationId, toolUseId) {
    const extracted = await WidgetIframeSource.extract(conversationId, toolUseId);
    const cssParts = await Promise.all(extracted.cssHrefs.map(href => this.#cssTextOf(href)));
    return { html: extracted.html, css: cssParts.join('\n') };
  }

  /**
   * A stylesheet's text, fetched once per URL and reused for every widget that needs it.
   * @param {string} href Stylesheet URL.
   * @returns {Promise<string>} Its text, or an empty string when it couldn't be fetched.
   */
  #cssTextOf(href) {
    if (!this.#cssPromisesByHref.has(href)) this.#cssPromisesByHref.set(href, WidgetExtractor.#fetchText(href));
    return this.#cssPromisesByHref.get(href);
  }

  /**
   * Fetches a URL's text, failing soft to an empty string.
   * @param {string} href URL to fetch.
   * @returns {Promise<string>} Its text, or an empty string on failure.
   */
  static async #fetchText(href) {
    try {
      const response = await fetch(href);
      return response.ok ? await response.text() : '';
    } catch {
      return '';
    }
  }
}
