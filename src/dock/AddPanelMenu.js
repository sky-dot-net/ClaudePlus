import { PopupMenu } from '../ui/PopupMenu.js';

/**
 * The menu behind a zone's "+" button, offering a new chat or a new instance of a view panel as a
 * tab of that zone.
 */
export class AddPanelMenu {
  /**
   * The popup showing the entries.
   * @type {PopupMenu}
   */
  #popupMenu = new PopupMenu();

  /**
   * Provides the current entries.
   * @type {function(): ChoiceOption[]}
   */
  #entries;

  /**
   * Called with the chosen entry id and the zone id.
   * @type {function(string, string): void}
   */
  #onSelect;

  /**
   * Creates the menu.
   * @param {object} options Menu options.
   * @param {function(): ChoiceOption[]} options.entries Provides the current entries.
   * @param {function(string, string): void} options.onSelect Called with the chosen entry id and the zone id.
   */
  constructor({ entries, onSelect }) {
    this.#entries = entries;
    this.#onSelect = onSelect;
  }

  /**
   * Opens the menu at the pointer for a zone.
   * @param {MouseEvent} event Click on the zone's "+" button.
   * @param {string} leafId Zone id.
   * @returns {void}
   */
  open(event, leafId) {
    this.#popupMenu.open({
      left: event.clientX,
      top: event.clientY,
      entries: this.#entries(),
      onSelect: entryId => this.#onSelect(entryId, leafId),
    });
  }
}
