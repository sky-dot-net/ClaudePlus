import { PopupMenu } from './PopupMenu.js';
import { PromptDialog } from './dialogs/PromptDialog.js';
import { STORAGE_KEYS } from '../config/STORAGE_KEYS.js';
import { SettingsDialog } from './dialogs/SettingsDialog.js';
import { StyleRegistry } from '../styles/StyleRegistry.js';
import { clamp } from '../math/clamp.js';
import { collectNamedElements } from '../dom/collectNamedElements.js';
import { createElement } from '../dom/createElement.js';
import stylesheet from './Toolbar.css';

StyleRegistry.register(stylesheet);

/**
 * Top bar with the title, the message font size slider, the layout menu, the settings menu and
 * layout reset.
 */
export class Toolbar {
  /**
   * Allowed and default font sizes in pixels.
   * @type {Readonly<{minimum: number, maximum: number, fallback: number}>}
   */
  static #FONT_SIZE = Object.freeze({ minimum: 11, maximum: 24, fallback: 14 });

  /**
   * Font size storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Workspace to reset.
   * @type {DockWorkspace}
   */
  #workspace;

  /**
   * Saved layouts.
   * @type {LayoutLibrary}
   */
  #layoutLibrary;

  /**
   * Settings export and import.
   * @type {SettingsTransfer}
   */
  #settingsTransfer;

  /**
   * Colors and fonts.
   * @type {Theme}
   */
  #theme;

  /**
   * Called when the hide button is clicked.
   * @type {function(): void}
   */
  #onHide;

  /**
   * The layout and settings menus.
   * @type {PopupMenu}
   */
  #menu = new PopupMenu();

  /**
   * Message font size in pixels.
   * @type {number}
   */
  #messageFontSize;

  /**
   * Creates the toolbar with the stored font size, limited to the allowed range.
   * @param {object} services Toolbar dependencies.
   * @param {Preferences} services.preferences Font size storage.
   * @param {DockWorkspace} services.workspace Workspace to reset.
   * @param {LayoutLibrary} services.layoutLibrary Saved layouts.
   * @param {SettingsTransfer} services.settingsTransfer Settings export and import.
   * @param {Theme} services.theme Colors and fonts.
   * @param {function(): void} services.onHide Called when the hide button is clicked.
   */
  constructor({ preferences, workspace, layoutLibrary, settingsTransfer, theme, onHide }) {
    this.#preferences = preferences;
    this.#workspace = workspace;
    this.#layoutLibrary = layoutLibrary;
    this.#settingsTransfer = settingsTransfer;
    this.#theme = theme;
    this.#onHide = onHide;
    const storedSize = Number.parseFloat(preferences.read(STORAGE_KEYS.messageFontSize));
    const { minimum, maximum, fallback } = Toolbar.#FONT_SIZE;
    this.#messageFontSize = Number.isFinite(storedSize) ? clamp(storedSize, minimum, maximum) : fallback;
  }

  /**
   * Adds the toolbar to the page and applies the font size.
   * @returns {void}
   */
  mount() {
    const { minimum, maximum } = Toolbar.#FONT_SIZE;
    const toolbar = createElement('div', {
      className: 'claude-plus-themed claude-plus-toolbar',
      innerHTML: `
        <div class="claude-plus-toolbar__title">ClaudePlus</div>
        <label class="claude-plus-toolbar__font-size">
          <span>Aa</span>
          <input type="range" data-name="fontSizeSlider" min="${minimum}" max="${maximum}" step="1" value="${this.#messageFontSize}">
          <span data-name="fontSizeLabel"></span>
        </label>
        <div class="claude-plus-fill-remaining"></div>
        <button class="claude-plus-toolbar__button" data-name="layoutsButton">Layouts ▾</button>
        <button class="claude-plus-toolbar__button" data-name="settingsButton">Settings</button>
        <button class="claude-plus-toolbar__button" data-name="resetLayoutButton">Reset layout</button>
        <button class="claude-plus-toolbar__close-button" data-name="hideButton" title="Hide ClaudePlus (nothing is lost, click the lightbulb to bring it back)">✕</button>`,
    });
    const elements = collectNamedElements(toolbar);
    elements.fontSizeSlider.addEventListener('input', () => this.#changeFontSize(Number.parseFloat(elements.fontSizeSlider.value), elements.fontSizeLabel));
    elements.layoutsButton.addEventListener('click', () => this.#showLayoutsMenu(elements.layoutsButton));
    elements.settingsButton.addEventListener('click', () => SettingsDialog.open(this.#layoutLibrary, this.#settingsTransfer, this.#theme));
    elements.resetLayoutButton.addEventListener('click', () => this.#workspace.resetLayout());
    elements.hideButton.addEventListener('click', () => this.#onHide());
    this.#applyFontSize(elements.fontSizeLabel);
    document.body.append(toolbar);
  }

  /**
   * Opens the layout menu: save, then load and delete entries per saved layout.
   * @param {HTMLElement} button The layouts button.
   * @returns {void}
   */
  #showLayoutsMenu(button) {
    const names = this.#layoutLibrary.names();
    this.#openMenuBelow(button, [
      { id: 'save:', label: 'Save current layout…' },
      ...names.map(name => ({ id: `load:${name}`, label: `Load "${name}"` })),
      ...names.map(name => ({ id: `delete:${name}`, label: `Delete "${name}"` })),
    ], entryId => this.#onLayoutsMenuSelect(entryId));
  }

  /**
   * Runs a layout menu entry.
   * @param {string} entryId "save:", "load:<name>" or "delete:<name>".
   * @returns {void}
   */
  #onLayoutsMenuSelect(entryId) {
    const separator = entryId.indexOf(':');
    const action = entryId.slice(0, separator);
    const name = entryId.slice(separator + 1);
    const actions = {
      save: () => this.#askNameAndSave(),
      load: () => this.#layoutLibrary.load(name),
      delete: () => this.#layoutLibrary.remove(name),
    };
    actions[action]();
  }

  /**
   * Asks for a layout name and saves the current layout under it; a blank name cancels.
   * @returns {Promise<void>} Resolves once saved or cancelled.
   */
  async #askNameAndSave() {
    const name = await PromptDialog.ask('Name of this layout:', '', 'Save');
    if (name && name.trim()) this.#layoutLibrary.save(name.trim());
  }

  /**
   * Opens the toolbar menu below a button.
   * @param {HTMLElement} button The button.
   * @param {ChoiceOption[]} entries Menu entries.
   * @param {function(string): void} onSelect Called with the chosen entry's id.
   * @returns {void}
   */
  #openMenuBelow(button, entries, onSelect) {
    const bounds = button.getBoundingClientRect();
    this.#menu.open({ left: bounds.left, top: bounds.bottom + 4, entries, onSelect });
  }

  /**
   * Changes and stores the font size.
   * @param {number} fontSize New size in pixels.
   * @param {HTMLElement} fontSizeLabel Element showing the size.
   * @returns {void}
   */
  #changeFontSize(fontSize, fontSizeLabel) {
    this.#messageFontSize = fontSize;
    this.#preferences.write(STORAGE_KEYS.messageFontSize, fontSize);
    this.#applyFontSize(fontSizeLabel);
  }

  /**
   * Applies the font size to the messages and shows it.
   * @param {HTMLElement} fontSizeLabel Element showing the size.
   * @returns {void}
   */
  #applyFontSize(fontSizeLabel) {
    document.documentElement.style.setProperty('--claude-plus-message-font-size', `${this.#messageFontSize}px`);
    fontSizeLabel.textContent = `${this.#messageFontSize}px`;
  }
}
