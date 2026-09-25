import { ConversationExporter } from '../../export/ConversationExporter.js';
import { PopupMenu } from '../PopupMenu.js';

/**
 * A button opening a menu of the export formats below it; choosing one exports the active chat.
 */
export class ExportMenuButton {
  /**
   * Distance in pixels between the button and the menu.
   * @type {number}
   */
  static #MENU_GAP = 4;

  /**
   * The button.
   * @type {HTMLButtonElement}
   */
  #button;

  /**
   * Exports the active chat.
   * @type {ConversationExporter}
   */
  #exporter;

  /**
   * Menu listing the export formats.
   * @type {PopupMenu}
   */
  #formatMenu = new PopupMenu();

  /**
   * Wires the button.
   * @param {HTMLButtonElement} button The button.
   * @param {ConversationExporter} exporter Exports the active chat.
   */
  constructor(button, exporter) {
    this.#button = button;
    this.#exporter = exporter;
    button.addEventListener('click', () => this.#openFormatMenu());
  }

  /**
   * Enables or disables the button; only a saved conversation can be exported.
   * @param {boolean} isEnabled Whether exporting is possible.
   * @returns {void}
   */
  setEnabled(isEnabled) {
    this.#button.disabled = !isEnabled;
  }

  /**
   * Closes the menu if open.
   * @returns {void}
   */
  close() {
    this.#formatMenu.close();
  }

  /**
   * Opens the format menu below the button.
   * @returns {void}
   */
  #openFormatMenu() {
    const bounds = this.#button.getBoundingClientRect();
    this.#formatMenu.open({
      left: bounds.left,
      top: bounds.bottom + ExportMenuButton.#MENU_GAP,
      entries: [...ConversationExporter.FORMATS].map(([formatId, format]) => ({ id: formatId, label: format.label })),
      onSelect: formatId => this.#exporter.exportOpenConversation(formatId),
    });
  }
}
