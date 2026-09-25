import { LIMITS } from '../../config/LIMITS.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { WildcardPattern } from '../../text/WildcardPattern.js';
import { createElement } from '../../dom/createElement.js';
import { emptyStateHtml } from '../html/emptyStateHtml.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import stylesheet from './ValueCombobox.css';

StyleRegistry.register(stylesheet);

/**
 * A text input that shows the distinct values it can filter by in a list below it while focused.
 * Typing narrows the list live with the same wildcard matching the filter uses; choosing an entry
 * copies it into the input.
 */
export class ValueCombobox {
  /**
   * The input being enhanced.
   * @type {HTMLInputElement}
   */
  #input;

  /**
   * Returns the values to offer.
   * @type {function(): string[]}
   */
  #listValues;

  /**
   * The open list, or null while closed.
   * @type {?HTMLElement}
   */
  #listElement = null;

  /**
   * Enhances an input.
   * @param {HTMLInputElement} input The input.
   * @param {function(): string[]} listValues Returns the values to offer, already distinct and sorted.
   */
  constructor(input, listValues) {
    this.#input = input;
    this.#listValues = listValues;
    input.addEventListener('focus', this.#showList);
    input.addEventListener('input', this.#showList);
    input.addEventListener('blur', this.#hideList);
    input.addEventListener('keydown', this.#onKeydown);
  }

  /**
   * Closes the list.
   * @returns {void}
   */
  dispose() {
    this.#hideList();
  }

  /**
   * Opens or refreshes the list with the values matching the input.
   * @returns {void}
   */
  #showList = () => {
    const pattern = new WildcardPattern(this.#input.value);
    const values = this.#listValues().filter(value => pattern.matches(value)).slice(0, LIMITS.comboboxEntries);
    this.#ensureListElement();
    this.#listElement.innerHTML = values.map(value => `<div class="claude-plus-value-combobox__entry" data-value="${escapeHtml(value)}">${escapeHtml(value)}</div>`).join('')
      || emptyStateHtml('No matching values.');
    this.#positionList();
  };

  /**
   * Closes the list if open.
   * @returns {void}
   */
  #hideList = () => {
    if (!this.#listElement) return;
    this.#listElement.remove();
    this.#listElement = null;
  };

  /**
   * Closes the list on Escape.
   * @param {KeyboardEvent} event Key press in the input.
   * @returns {void}
   */
  #onKeydown = (event) => {
    if (event.key === 'Escape') this.#hideList();
  };

  /**
   * Copies the pressed entry into the input and announces the change; keeps focus in the input.
   * @param {MouseEvent} event Mouse press inside the list.
   * @returns {void}
   */
  #onListPress = (event) => {
    event.preventDefault();
    const entry = event.target.closest('[data-value]');
    if (!entry) return;
    this.#input.value = entry.dataset.value;
    this.#input.dispatchEvent(new Event('input', { bubbles: true }));
    this.#hideList();
  };

  /**
   * Creates the list element on first use.
   * @returns {void}
   */
  #ensureListElement() {
    if (this.#listElement) return;
    this.#listElement = createElement('div', { className: 'claude-plus-themed claude-plus-value-combobox' });
    this.#listElement.addEventListener('mousedown', this.#onListPress);
    document.body.append(this.#listElement);
  }

  /**
   * Places the list directly below the input.
   * @returns {void}
   */
  #positionList() {
    const bounds = this.#input.getBoundingClientRect();
    Object.assign(this.#listElement.style, { left: `${bounds.left}px`, top: `${bounds.bottom + 2}px`, minWidth: `${bounds.width}px` });
  }
}
