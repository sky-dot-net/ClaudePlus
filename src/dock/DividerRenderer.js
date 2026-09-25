import { DragGesture } from '../dom/DragGesture.js';
import { LAYOUT } from '../config/LAYOUT.js';
import { StyleRegistry } from '../styles/StyleRegistry.js';
import { createElement } from '../dom/createElement.js';
import { placeElement } from '../dom/placeElement.js';
import stylesheet from './DividerRenderer.css';

StyleRegistry.register(stylesheet);

/**
 * Draws the dividers between split children on a layer above the panels, so they can be grabbed
 * along their full length, and reports how far a dragged divider moved.
 */
export class DividerRenderer {
  /**
   * Layer holding every divider.
   * @type {HTMLElement}
   */
  #layer = createElement('div', { className: 'claude-plus-divider-layer' });

  /**
   * Called on every move with the split, the divider index, the sizes at the start and the moved fraction.
   * @type {function(SplitNode, number, number[], number): void}
   */
  #onResize;

  /**
   * Called once a divider is released.
   * @type {function(): void}
   */
  #onResizeEnd;

  /**
   * Creates the renderer.
   * @param {object} callbacks Resize callbacks.
   * @param {function(SplitNode, number, number[], number): void} callbacks.onResize Called on every move with the split, the divider index, the sizes at the start and the moved fraction of the split's extent.
   * @param {function(): void} callbacks.onResizeEnd Called once a divider is released.
   */
  constructor({ onResize, onResizeEnd }) {
    this.#onResize = onResize;
    this.#onResizeEnd = onResizeEnd;
  }

  /**
   * The layer element, to add to the page.
   * @returns {HTMLElement} The layer.
   */
  get layer() {
    return this.#layer;
  }

  /**
   * Removes every drawn divider.
   * @returns {void}
   */
  clear() {
    this.#layer.replaceChildren();
  }

  /**
   * Draws a divider that resizes its split when dragged.
   * @param {DividerPlacement} placement The divider.
   * @returns {void}
   */
  render(placement) {
    const isSideBySide = placement.split.direction === 'row';
    const className = isSideBySide ? 'claude-plus-divider claude-plus-divider--vertical' : 'claude-plus-divider claude-plus-divider--horizontal';
    const divider = createElement('div', { className });
    placeElement(divider, DividerRenderer.#grabArea(placement, isSideBySide));
    divider.addEventListener('mousedown', event => this.#startDrag(event, placement, isSideBySide));
    this.#layer.append(divider);
  }

  /**
   * Grab area of a divider, centred on the boundary.
   * @param {DividerPlacement} placement The divider.
   * @param {boolean} isSideBySide Whether the split places children side by side.
   * @returns {Rect} The area.
   */
  static #grabArea({ rect, position }, isSideBySide) {
    const start = position - LAYOUT.dividerThickness / 2;
    return isSideBySide
      ? { left: start, top: rect.top, width: LAYOUT.dividerThickness, height: rect.height }
      : { left: rect.left, top: start, width: rect.width, height: LAYOUT.dividerThickness };
  }

  /**
   * Pointer coordinate along a split axis.
   * @param {MouseEvent} event Pointer event.
   * @param {boolean} isSideBySide True for the x coordinate, false for y.
   * @returns {number} The coordinate.
   */
  static #pointerPositionAlongAxis(event, isSideBySide) {
    return isSideBySide ? event.clientX : event.clientY;
  }

  /**
   * Reports the moved fraction while a divider is dragged, with the resize cursor forced on the
   * whole page, and reports the release.
   * @param {MouseEvent} startEvent The mousedown on the divider.
   * @param {DividerPlacement} placement The divider.
   * @param {boolean} isSideBySide Whether the split places children side by side.
   * @returns {void}
   */
  #startDrag(startEvent, { split, index, rect }, isSideBySide) {
    startEvent.preventDefault();
    const startSizes = [...split.sizes];
    const startPosition = DividerRenderer.#pointerPositionAlongAxis(startEvent, isSideBySide);
    const extent = isSideBySide ? rect.width : rect.height;
    const resizingClass = isSideBySide ? 'claude-plus-resizing-horizontally' : 'claude-plus-resizing-vertically';
    document.documentElement.classList.add(resizingClass);
    new DragGesture(startEvent, {
      threshold: 0,
      onMove: event => this.#onResize(split, index, startSizes, (DividerRenderer.#pointerPositionAlongAxis(event, isSideBySide) - startPosition) / extent),
      onEnd: () => {
        document.documentElement.classList.remove(resizingClass);
        this.#onResizeEnd();
      },
    });
  }
}
