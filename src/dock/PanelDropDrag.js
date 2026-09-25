import { DragGesture } from '../dom/DragGesture.js';
import { LAYOUT } from '../config/LAYOUT.js';
import { StyleRegistry } from '../styles/StyleRegistry.js';
import { createElement } from '../dom/createElement.js';
import { placeElement } from '../dom/placeElement.js';
import stylesheet from './PanelDropDrag.css';

StyleRegistry.register(stylesheet);

/**
 * One drag of something to dock, a tab or a not yet existing panel: a floating label follows the
 * pointer, the drop target under it is highlighted, and on release the chosen target is reported.
 */
export class PanelDropDrag {
  /**
   * Floating label following the pointer.
   * @type {HTMLElement}
   */
  #dragLabel;

  /**
   * Highlight of the drop target under the pointer.
   * @type {HTMLElement}
   */
  #dropHighlight;

  /**
   * Finds the drop target for a pointer position.
   * @type {function(number, number): ?DropTarget}
   */
  #findDropTarget;

  /**
   * Called with the chosen target when released over one.
   * @type {function(DropTarget): void}
   */
  #onDrop;

  /**
   * Target under the pointer at the last move, or null.
   * @type {?DropTarget}
   */
  #dropTarget = null;

  /**
   * Starts the drag from a mousedown.
   * @param {MouseEvent} startEvent The mousedown that starts the drag.
   * @param {object} options Drag options.
   * @param {string} options.label Text of the floating label.
   * @param {function(number, number): ?DropTarget} options.findDropTarget Finds the drop target for a pointer position.
   * @param {function(DropTarget): void} options.onDrop Called with the chosen target when released over one.
   */
  constructor(startEvent, { label, findDropTarget, onDrop }) {
    startEvent.preventDefault();
    this.#findDropTarget = findDropTarget;
    this.#onDrop = onDrop;
    this.#dragLabel = createElement('div', { className: 'claude-plus-themed claude-plus-drag-label', textContent: label, hidden: true });
    this.#dropHighlight = createElement('div', { className: 'claude-plus-drop-highlight', hidden: true });
    document.body.append(this.#dragLabel, this.#dropHighlight);
    new DragGesture(startEvent, {
      threshold: LAYOUT.dragThreshold,
      onMove: event => this.#followPointer(event),
      onEnd: (event, wasDragged) => this.#finish(wasDragged),
    });
  }

  /**
   * Moves the label to the pointer and highlights the drop target under it.
   * @param {MouseEvent} event Current pointer event.
   * @returns {void}
   */
  #followPointer(event) {
    this.#dropTarget = this.#findDropTarget(event.clientX, event.clientY);
    this.#dragLabel.hidden = false;
    Object.assign(this.#dragLabel.style, { left: `${event.clientX + LAYOUT.dragLabelOffset}px`, top: `${event.clientY + LAYOUT.dragLabelOffset}px` });
    this.#dropHighlight.hidden = !this.#dropTarget;
    if (this.#dropTarget) placeElement(this.#dropHighlight, this.#dropTarget.rect);
  }

  /**
   * Removes the label and highlight and reports the target when a drag ended over one.
   * @param {boolean} wasDragged Whether the pointer moved past the drag threshold.
   * @returns {void}
   */
  #finish(wasDragged) {
    this.#dragLabel.remove();
    this.#dropHighlight.remove();
    if (wasDragged && this.#dropTarget) this.#onDrop(this.#dropTarget);
  }
}
