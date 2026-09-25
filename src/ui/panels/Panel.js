import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { collectNamedElements } from '../../dom/collectNamedElements.js';
import { createElement } from '../../dom/createElement.js';
import stylesheet from './Panel.css';

StyleRegistry.register(stylesheet);

/**
 * A dockable panel. Its DOM is built on first access and immediately rendered from current state,
 * so a panel opened late is never blank. Subclasses override createBodyHtml, bindEvents and
 * render, look up elements only inside their own root through elements, and subscribe through
 * listenTo so dispose can undo every subscription.
 */
export class Panel {
  /**
   * Root element, or null until first access.
   * @type {?HTMLElement}
   */
  #root = null;

  /**
   * Tab title.
   * @type {string}
   */
  #title;

  /**
   * Undoes each subscription made through listenTo.
   * @type {Array<function(): void>}
   */
  #unsubscribers = [];

  /**
   * Called when the tab's close button is clicked, or null when the panel can't be closed this way.
   * @type {?function(): void}
   */
  #closeHandler = null;

  /**
   * Creates the panel.
   * @param {string} title Tab title.
   */
  constructor(title) {
    this.#title = title;
    this.elements = {};
  }

  /**
   * Tab title.
   * @returns {string} The title.
   */
  get title() {
    return this.#title;
  }

  /**
   * Whether the DOM has been built.
   * @returns {boolean} True after the first access of element.
   */
  get isBuilt() {
    return this.#root !== null;
  }

  /**
   * Root element, built, wired and rendered on first access.
   * @returns {HTMLElement} The root.
   */
  get element() {
    if (!this.#root) this.#buildElement();
    return this.#root;
  }

  /**
   * Makes the panel closable from its tab.
   * @param {function(): void} closeHandler Called when the tab's close button is clicked.
   * @returns {void}
   */
  setCloseHandler(closeHandler) {
    this.#closeHandler = closeHandler;
  }

  /**
   * Whether the panel's tab offers a close button.
   * @returns {boolean} True once a close handler is set.
   */
  canClose() {
    return this.#closeHandler !== null;
  }

  /**
   * Handles the tab's close button.
   * @returns {void}
   */
  close() {
    if (this.#closeHandler) this.#closeHandler();
  }

  /**
   * Subscribes to an emitter for as long as the panel exists.
   * @param {EventEmitter} emitter Event source.
   * @param {string} eventName Event name.
   * @param {function(*): void} listener Called with the event payload.
   * @returns {void}
   */
  listenTo(emitter, eventName, listener) {
    this.#unsubscribers.push(emitter.subscribe(eventName, listener));
  }

  /**
   * Ends every subscription and removes the panel from the page.
   * @returns {void}
   */
  dispose() {
    this.#unsubscribers.forEach(unsubscribe => unsubscribe());
    this.#unsubscribers = [];
    if (this.#root) this.#root.remove();
  }

  /**
   * HTML of the panel body; elements used later carry a data-name attribute.
   * @returns {string} The HTML.
   */
  createBodyHtml() {
    return '';
  }

  /**
   * Attaches event listeners and subscriptions once the DOM exists.
   * @returns {void}
   */
  bindEvents() {
    return undefined;
  }

  /**
   * Updates the DOM from current state.
   * @returns {void}
   */
  render() {
    return undefined;
  }

  /**
   * Builds the root from the body HTML, collects named elements, wires and renders it.
   * @returns {void}
   */
  #buildElement() {
    this.#root = createElement('div', { className: 'claude-plus-themed claude-plus-panel', innerHTML: this.createBodyHtml() });
    this.elements = collectNamedElements(this.#root);
    this.bindEvents();
    this.render();
  }
}
