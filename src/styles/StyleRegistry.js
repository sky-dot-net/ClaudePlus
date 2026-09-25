/**
 * Collects the stylesheets of all components. Every component registers its own stylesheet when
 * its module is evaluated, so the app injects one combined stylesheet without knowing the components.
 */
export class StyleRegistry {
  /**
   * Registered stylesheets, in registration order.
   * @type {string[]}
   */
  static #stylesheets = [];

  /**
   * Adds a component's stylesheet.
   * @param {string} css The stylesheet text.
   * @returns {void}
   */
  static register(css) {
    StyleRegistry.#stylesheets.push(css);
  }

  /**
   * All registered stylesheets joined into one.
   * @returns {string} The combined stylesheet text.
   */
  static get combinedCss() {
    return StyleRegistry.#stylesheets.join('\n');
  }
}
