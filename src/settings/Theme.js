import { STORAGE_KEYS } from '../config/STORAGE_KEYS.js';
import { THEME_COLOR_FIELDS } from '../config/THEME_COLOR_FIELDS.js';
import { isDarkColor } from '../color/isDarkColor.js';

/**
 * The app's colors and fonts, stored as one JSON preference and applied as CSS custom properties
 * on the document root, so the built-in stylesheet (which already reads those properties) repaints
 * without any component needing to know theming exists.
 */
export class Theme {
  /**
   * Theme storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Creates the theme and applies whatever is currently stored (or the defaults).
   * @param {Preferences} preferences Theme storage.
   */
  constructor(preferences) {
    this.#preferences = preferences;
    this.apply();
  }

  /**
   * The current settings, filled in with defaults for anything not customized.
   * @returns {{colors: Object<string, string>, uiFontFamily: string, chatFontFamily: string}} The settings.
   */
  get settings() {
    const stored = this.#preferences.readJson(STORAGE_KEYS.theme) ?? {};
    const colors = Object.fromEntries(THEME_COLOR_FIELDS.map(field => [field.key, stored.colors?.[field.key] || field.default]));
    return { colors, uiFontFamily: stored.uiFontFamily || '', chatFontFamily: stored.chatFontFamily || '' };
  }

  /**
   * Stores new settings and applies them.
   * @param {{colors: Object<string, string>, uiFontFamily: string, chatFontFamily: string}} settings The settings.
   * @returns {void}
   */
  save(settings) {
    this.#preferences.writeJson(STORAGE_KEYS.theme, settings);
    this.apply();
  }

  /**
   * Clears every customization and reapplies the defaults.
   * @returns {void}
   */
  reset() {
    this.#preferences.remove(STORAGE_KEYS.theme);
    this.apply();
  }

  /**
   * Sets the CSS custom properties the stylesheet reads from the current settings.
   * @returns {void}
   */
  apply() {
    const { colors, uiFontFamily, chatFontFamily } = this.settings;
    const root = document.documentElement.style;
    THEME_COLOR_FIELDS.forEach(field => root.setProperty(field.cssVar, colors[field.key]));
    root.setProperty('--claude-plus-color-inactive-border', Theme.#inactiveBorderColor(colors.background));
    Theme.#setOrClear(root, '--claude-plus-font-family', uiFontFamily);
    Theme.#setOrClear(root, '--claude-plus-message-font-family', chatFontFamily);
  }

  /**
   * A faint border color that reads against the background: white on a dark background, black on
   * a light one, so an inactive chat pane's border stays visible whatever the theme.
   * @param {string} backgroundColor The current background color.
   * @returns {string} The border color.
   */
  static #inactiveBorderColor(backgroundColor) {
    return isDarkColor(backgroundColor) ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.16)';
  }

  /**
   * Sets a custom property to a value, or clears it back to the stylesheet's own default when blank.
   * @param {CSSStyleDeclaration} style The root element's inline style.
   * @param {string} cssVar Custom property name.
   * @param {string} value New value, or an empty string to clear it.
   * @returns {void}
   */
  static #setOrClear(style, cssVar, value) {
    if (value) style.setProperty(cssVar, value);
    else style.removeProperty(cssVar);
  }
}
