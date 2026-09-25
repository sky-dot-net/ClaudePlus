import { createElement } from '../../dom/createElement.js';

/**
 * Base of every modal dialog: a themed overlay over the whole page holding the dialog's content.
 * Showing returns a promise resolved with the dialog's result once it closes. Pressing Escape or
 * pressing the backdrop closes it with the cancel value. Subclasses supply the overlay class and
 * the content, and can react once the dialog is on screen.
 * @abstract
 */
export class Dialog {
  /**
   * The overlay while the dialog is shown, otherwise null.
   * @type {?HTMLElement}
   */
  #overlay = null;

  /**
   * Resolves the promise returned by show().
   * @type {?function(*): void}
   */
  #resolveResult = null;

  /**
   * CSS class of the overlay, which also styles the content inside it.
   * @abstract
   * @returns {string} The class name.
   * @throws {Error} When a subclass does not override it.
   */
  get overlayClassName() {
    throw new Error(`${this.constructor.name} must override overlayClassName`);
  }

  /**
   * Result of the dialog when dismissed by Escape or a press on the backdrop.
   * @returns {*} The cancel result; undefined unless overridden.
   */
  get cancelValue() {
    return undefined;
  }

  /**
   * Builds the elements placed inside the overlay.
   * @abstract
   * @returns {HTMLElement[]} The content elements.
   * @throws {Error} When a subclass does not override it.
   */
  createContent() {
    throw new Error(`${this.constructor.name} must override createContent`);
  }

  /**
   * Called once the dialog is on screen, e.g. to focus an input. Does nothing unless overridden.
   * @returns {void}
   */
  afterShow() {}

  /**
   * Puts the dialog on screen.
   * @returns {Promise<*>} Resolves with the result passed to close(), or the cancel value.
   */
  show() {
    return new Promise(resolve => {
      this.#resolveResult = resolve;
      this.#overlay = createElement('div', { className: `claude-plus-themed ${this.overlayClassName}` });
      this.#overlay.append(...this.createContent());
      this.#overlay.addEventListener('mousedown', this.#closeOnBackdropPress);
      document.addEventListener('keydown', this.#closeOnEscape);
      document.body.append(this.#overlay);
      this.afterShow();
    });
  }

  /**
   * Removes the dialog and resolves its promise. Does nothing when it is not shown.
   * @param {*} result Result of the dialog.
   * @returns {void}
   */
  close(result) {
    if (!this.#overlay) return;
    this.#overlay.remove();
    this.#overlay = null;
    document.removeEventListener('keydown', this.#closeOnEscape);
    this.#resolveResult(result);
  }

  /**
   * Closes with the cancel value when the press landed on the backdrop itself.
   * @param {MouseEvent} event The mousedown event.
   * @returns {void}
   */
  #closeOnBackdropPress = event => {
    if (event.target === this.#overlay) this.close(this.cancelValue);
  };

  /**
   * Closes with the cancel value when Escape is pressed.
   * @param {KeyboardEvent} event The keydown event.
   * @returns {void}
   */
  #closeOnEscape = event => {
    if (event.key === 'Escape') this.close(this.cancelValue);
  };
}
