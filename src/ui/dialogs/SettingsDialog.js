import { Dialog } from './Dialog.js';
import { PromptDialog } from './PromptDialog.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { THEME_COLOR_FIELDS } from '../../config/THEME_COLOR_FIELDS.js';
import { collectNamedElements } from '../../dom/collectNamedElements.js';
import { createElement } from '../../dom/createElement.js';
import { emptyStateHtml } from '../html/emptyStateHtml.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import stylesheet from './SettingsDialog.css';

StyleRegistry.register(stylesheet);

/**
 * The Settings screen: saved layouts, settings import/export and a small theming section (key
 * colors and the interface/chat fonts). Theme changes apply live as they're made; there is no
 * separate save step for them.
 */
export class SettingsDialog extends Dialog {
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
   * The dialog's named elements, set once the content is built.
   * @type {?Object<string, HTMLElement>}
   */
  #elements = null;

  /**
   * Creates the dialog without showing it.
   * @param {LayoutLibrary} layoutLibrary Saved layouts.
   * @param {SettingsTransfer} settingsTransfer Settings export and import.
   * @param {Theme} theme Colors and fonts.
   */
  constructor(layoutLibrary, settingsTransfer, theme) {
    super();
    this.#layoutLibrary = layoutLibrary;
    this.#settingsTransfer = settingsTransfer;
    this.#theme = theme;
  }

  /**
   * Opens the Settings screen.
   * @param {LayoutLibrary} layoutLibrary Saved layouts.
   * @param {SettingsTransfer} settingsTransfer Settings export and import.
   * @param {Theme} theme Colors and fonts.
   * @returns {Promise<void>} Resolves once closed.
   */
  static open(layoutLibrary, settingsTransfer, theme) {
    return new SettingsDialog(layoutLibrary, settingsTransfer, theme).show();
  }

  /**
   * CSS class of the dimmed overlay centering the screen.
   * @returns {string} The class name.
   */
  get overlayClassName() {
    return 'claude-plus-settings-overlay';
  }

  /**
   * Builds the screen: layout, import/export and theming sections.
   * @returns {HTMLElement[]} The screen.
   */
  createContent() {
    const box = createElement('div', { className: 'claude-plus-settings-dialog', innerHTML: SettingsDialog.#bodyHtml() });
    this.#elements = collectNamedElements(box);
    this.#bindEvents();
    this.#renderLayouts();
    this.#renderThemeFields();
    return [box];
  }

  /**
   * The screen's static markup.
   * @returns {string} The HTML.
   */
  static #bodyHtml() {
    return `
      <div class="claude-plus-settings-dialog__header">
        <h2>Settings</h2>
        <button class="claude-plus-toolbar__close-button" data-name="closeButton" title="Close">✕</button>
      </div>
      <section class="claude-plus-settings-dialog__section">
        <h3>Layout</h3>
        <div class="claude-plus-settings-dialog__row">
          <button class="claude-plus-toolbar__button" data-name="saveLayoutButton">Save current layout…</button>
        </div>
        <div data-name="layoutList"></div>
      </section>
      <section class="claude-plus-settings-dialog__section">
        <h3>Import / export</h3>
        <div class="claude-plus-settings-dialog__row">
          <button class="claude-plus-toolbar__button" data-name="exportButton">Export settings (JSON)</button>
          <button class="claude-plus-toolbar__button" data-name="importButton">Import settings…</button>
        </div>
      </section>
      <section class="claude-plus-settings-dialog__section">
        <h3>Theme</h3>
        <div class="claude-plus-settings-dialog__colors" data-name="colorFields"></div>
        <label class="claude-plus-settings-dialog__field">Interface font<input type="text" data-name="uiFontInput" placeholder="System default"></label>
        <label class="claude-plus-settings-dialog__field">Chat font<input type="text" data-name="chatFontInput" placeholder="Same as interface"></label>
        <div class="claude-plus-settings-dialog__row">
          <button class="claude-plus-toolbar__button" data-name="resetThemeButton">Reset to defaults</button>
        </div>
      </section>`;
  }

  /**
   * Wires every control. The saved-layouts list uses one delegated listener since its rows change.
   * @returns {void}
   */
  #bindEvents() {
    const elements = this.#elements;
    elements.closeButton.addEventListener('click', () => this.close());
    elements.saveLayoutButton.addEventListener('click', () => this.#saveLayout());
    elements.layoutList.addEventListener('click', event => this.#onLayoutListClick(event));
    elements.exportButton.addEventListener('click', () => this.#settingsTransfer.exportSettings());
    elements.importButton.addEventListener('click', () => this.#settingsTransfer.chooseFileAndImport());
    elements.uiFontInput.addEventListener('input', () => this.#saveThemeFromFields());
    elements.chatFontInput.addEventListener('input', () => this.#saveThemeFromFields());
    elements.resetThemeButton.addEventListener('click', () => this.#resetTheme());
  }

  /**
   * Asks for a layout name and saves the current layout under it; a blank name cancels.
   * @returns {Promise<void>} Resolves once saved or cancelled.
   */
  async #saveLayout() {
    const name = await PromptDialog.ask('Name of this layout:', '', 'Save');
    if (!name || !name.trim()) return;
    this.#layoutLibrary.save(name.trim());
    this.#renderLayouts();
  }

  /**
   * Loads or deletes the layout of a row whose button was clicked.
   * @param {MouseEvent} event The click.
   * @returns {void}
   */
  #onLayoutListClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const name = button.closest('[data-layout-name]').dataset.layoutName;
    if (button.dataset.action === 'load') {
      this.#layoutLibrary.load(name);
      this.close();
    } else {
      this.#layoutLibrary.remove(name);
      this.#renderLayouts();
    }
  }

  /**
   * Lists every saved layout with Load and Delete buttons.
   * @returns {void}
   */
  #renderLayouts() {
    const names = this.#layoutLibrary.names();
    this.#elements.layoutList.innerHTML = names.length ? names.map(SettingsDialog.#layoutRowHtml).join('') : emptyStateHtml('No saved layouts yet.');
  }

  /**
   * HTML of one saved layout's row.
   * @param {string} name Layout name.
   * @returns {string} The row.
   */
  static #layoutRowHtml(name) {
    const escapedName = escapeHtml(name);
    return `<div class="claude-plus-settings-dialog__layout-row" data-layout-name="${escapedName}">
      <span class="claude-plus-settings-dialog__layout-name">${escapedName}</span>
      <button class="claude-plus-toolbar__button" data-action="load">Load</button>
      <button class="claude-plus-toolbar__button" data-action="delete">Delete</button>
    </div>`;
  }

  /**
   * Shows the current theme in the color swatches and font fields.
   * @returns {void}
   */
  #renderThemeFields() {
    const { colors, uiFontFamily, chatFontFamily } = this.#theme.settings;
    this.#elements.colorFields.innerHTML = THEME_COLOR_FIELDS.map(field => SettingsDialog.#colorFieldHtml(field, colors[field.key])).join('');
    this.#elements.colorFields.querySelectorAll('input[type="color"]').forEach(input => input.addEventListener('input', () => this.#saveThemeFromFields()));
    this.#elements.uiFontInput.value = uiFontFamily;
    this.#elements.chatFontInput.value = chatFontFamily;
  }

  /**
   * HTML of one color swatch field.
   * @param {{key: string, label: string}} field The color field.
   * @param {string} value Its current hex value.
   * @returns {string} The field.
   */
  static #colorFieldHtml(field, value) {
    return `<label class="claude-plus-settings-dialog__color-field">
      <input type="color" data-color-key="${field.key}" value="${escapeHtml(value)}">
      <span>${escapeHtml(field.label)}</span>
    </label>`;
  }

  /**
   * Saves and applies the theme from the current field values.
   * @returns {void}
   */
  #saveThemeFromFields() {
    const colorInputs = [...this.#elements.colorFields.querySelectorAll('input[type="color"]')];
    const colors = Object.fromEntries(colorInputs.map(input => [input.dataset.colorKey, input.value]));
    this.#theme.save({ colors, uiFontFamily: this.#elements.uiFontInput.value.trim(), chatFontFamily: this.#elements.chatFontInput.value.trim() });
  }

  /**
   * Clears every theme customization and refreshes the fields to show the defaults.
   * @returns {void}
   */
  #resetTheme() {
    this.#theme.reset();
    this.#renderThemeFields();
  }
}
