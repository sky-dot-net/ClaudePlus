import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { createElement } from '../../dom/createElement.js';
import stylesheet from './WidgetMount.css';

StyleRegistry.register(stylesheet);

/**
 * Mounts an extracted widget card into a container via a shadow root, so claude.ai's own
 * stylesheet (which resets bare tag selectors) only ever applies inside the card, never leaking
 * out to the rest of ClaudePlus, and none of ClaudePlus's own styles leak in.
 */
export class WidgetMount {
  /**
   * Replaces a container's content with an isolated widget card.
   * @param {HTMLElement} container Element to mount into; its existing content is replaced.
   * @param {{html: string, css: string}} card The extracted card.
   * @returns {void}
   */
  static show(container, card) {
    container.textContent = '';
    const shadow = container.attachShadow({ mode: 'open' });
    shadow.append(createElement('style', { textContent: card.css }));
    shadow.append(createElement('div', { className: 'claude-plus-widget-card', innerHTML: card.html }));
  }

  /**
   * Shows a message in place of a widget that couldn't be extracted.
   * @param {HTMLElement} container Element to show the message in.
   * @param {string} text The message.
   * @returns {void}
   */
  static showUnavailable(container, text) {
    container.textContent = '';
    container.append(createElement('div', { className: 'claude-plus-widget-slot__message', textContent: text }));
  }
}
