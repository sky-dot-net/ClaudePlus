import { StyleRegistry } from '../styles/StyleRegistry.js';
import { createElement } from '../dom/createElement.js';
import { escapeHtml } from '../text/escapeHtml.js';
import stylesheet from './PopupMenu.css';

StyleRegistry.register(stylesheet);

/**
 * A small menu at the pointer that closes on selection or on a press outside it.
 */
export class PopupMenu {
  /**
   * The open menu, or null.
   * @type {?HTMLElement}
   */
  #menuElement = null;

  /**
   * Called with the selected entry's id.
   * @type {?function(string): void}
   */
  #onSelect = null;

  /**
   * Opens the menu, replacing one already open.
   * @param {object} options Menu contents.
   * @param {number} options.left Left edge in viewport pixels.
   * @param {number} options.top Top edge in viewport pixels.
   * @param {ChoiceOption[]} options.entries Entries.
   * @param {function(string): void} options.onSelect Called with the id of the chosen entry.
   * @returns {void}
   */
  open({ left, top, entries, onSelect }) {
    this.close();
    this.#onSelect = onSelect;
    this.#menuElement = createElement('div', {
      className: 'claude-plus-themed claude-plus-popup-menu',
      innerHTML: entries.map(entry => `<div class="claude-plus-popup-menu__entry" data-entry-id="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</div>`).join(''),
    });
    Object.assign(this.#menuElement.style, { left: `${left}px`, top: `${top}px` });
    this.#menuElement.addEventListener('click', this.#handleEntryClick);
    document.body.append(this.#menuElement);
    document.addEventListener('mousedown', this.#handleOutsidePress, true);
  }

  /**
   * Closes the menu if open.
   * @returns {void}
   */
  close() {
    if (!this.#menuElement) return;
    this.#menuElement.remove();
    this.#menuElement = null;
    document.removeEventListener('mousedown', this.#handleOutsidePress, true);
  }

  /**
   * Selects the clicked entry and closes the menu.
   * @param {MouseEvent} event Click inside the menu.
   * @returns {void}
   */
  #handleEntryClick = (event) => {
    const entry = event.target.closest('.claude-plus-popup-menu__entry');
    if (!entry) return;
    const onSelect = this.#onSelect;
    this.close();
    onSelect(entry.dataset.entryId);
  };

  /**
   * Closes the menu when the pointer is pressed outside it.
   * @param {MouseEvent} event Mouse press anywhere.
   * @returns {void}
   */
  #handleOutsidePress = (event) => {
    if (!this.#menuElement.contains(event.target)) this.close();
  };
}
