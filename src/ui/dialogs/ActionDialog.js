import { Dialog } from './Dialog.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { createElement } from '../../dom/createElement.js';
import stylesheet from './ActionDialog.css';

StyleRegistry.register(stylesheet);

/**
 * A small themed dialog box with a message, an optional body and a row of action buttons. It
 * replaces the native alert(), confirm() and prompt(), which Chrome silently disables ("prevent
 * this page from creating additional dialogs") after repeated use, making buttons appear to do
 * nothing. Subclasses supply the action buttons and optionally a body.
 * @abstract
 */
export class ActionDialog extends Dialog {
  /**
   * Message shown on top.
   * @type {string}
   */
  #message;

  /**
   * Creates the dialog without showing it.
   * @param {string} message Message shown on top.
   */
  constructor(message) {
    super();
    this.#message = message;
  }

  /**
   * CSS class of the dimmed overlay centering the box.
   * @returns {string} The class name.
   */
  get overlayClassName() {
    return 'claude-plus-dialog-overlay';
  }

  /**
   * Builds the box with the message, the body and the actions.
   * @returns {HTMLElement[]} The dialog box.
   */
  createContent() {
    const message = createElement('p', { className: 'claude-plus-dialog__message', textContent: this.#message });
    const actions = createElement('div', { className: 'claude-plus-dialog__actions' });
    actions.append(...this.createActions());
    const box = createElement('div', { className: 'claude-plus-dialog' });
    box.append(message, ...this.createBody(), actions);
    return [box];
  }

  /**
   * Builds the elements between the message and the actions.
   * @returns {HTMLElement[]} The body elements; none unless overridden.
   */
  createBody() {
    return [];
  }

  /**
   * Builds the action buttons.
   * @abstract
   * @returns {HTMLButtonElement[]} The buttons, left to right.
   * @throws {Error} When a subclass does not override it.
   */
  createActions() {
    throw new Error(`${this.constructor.name} must override createActions`);
  }

  /**
   * Creates a button that closes the dialog with a result.
   * @param {string} label Button text.
   * @param {boolean} isPrimary Whether it is the highlighted main action.
   * @param {function(): *} resultOnClick Returns the dialog result when the button is clicked.
   * @returns {HTMLButtonElement} The button.
   */
  createClosingButton(label, isPrimary, resultOnClick) {
    const className = isPrimary ? 'claude-plus-primary-button' : 'claude-plus-toolbar__button';
    const button = createElement('button', { className, textContent: label });
    button.addEventListener('click', () => this.close(resultOnClick()));
    return button;
  }
}
