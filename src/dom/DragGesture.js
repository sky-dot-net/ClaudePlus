/**
 * Tracks one mouse drag gesture on the window. Its listeners exist only while the button is held
 * and are always removed on release.
 */
export class DragGesture {
  /**
   * Pointer x when the button was pressed.
   * @type {number}
   */
  #startPointerX;

  /**
   * Pointer y when the button was pressed.
   * @type {number}
   */
  #startPointerY;

  /**
   * Movement in pixels before the gesture counts as a drag.
   * @type {number}
   */
  #threshold;

  /**
   * Called on every move once dragging.
   * @type {function(MouseEvent): void}
   */
  #onMove;

  /**
   * Called on release with whether a drag happened.
   * @type {function(MouseEvent, boolean): void}
   */
  #onEnd;

  /**
   * Whether the threshold has been passed.
   * @type {boolean}
   */
  #isDragging;

  /**
   * Starts tracking from a mousedown event.
   * @param {MouseEvent} startEvent The mousedown that starts the gesture.
   * @param {object} handlers Gesture configuration.
   * @param {number} handlers.threshold Movement in pixels before moves are reported; 0 reports all.
   * @param {function(MouseEvent): void} handlers.onMove Called for each move while dragging.
   * @param {function(MouseEvent, boolean): void} handlers.onEnd Called on release with whether the threshold was passed.
   */
  constructor(startEvent, { threshold, onMove, onEnd }) {
    this.#startPointerX = startEvent.clientX;
    this.#startPointerY = startEvent.clientY;
    this.#threshold = threshold;
    this.#onMove = onMove;
    this.#onEnd = onEnd;
    this.#isDragging = threshold === 0;
    window.addEventListener('mousemove', this.#handleMove);
    window.addEventListener('mouseup', this.#handleRelease);
  }

  /**
   * Reports a move once the threshold has been passed.
   * @param {MouseEvent} event The mousemove event.
   * @returns {void}
   */
  #handleMove = (event) => {
    if (!this.#isDragging && !this.#hasPassedThreshold(event)) return;
    this.#isDragging = true;
    this.#onMove(event);
  };

  /**
   * Ends the gesture and removes the window listeners.
   * @param {MouseEvent} event The mouseup event.
   * @returns {void}
   */
  #handleRelease = (event) => {
    window.removeEventListener('mousemove', this.#handleMove);
    window.removeEventListener('mouseup', this.#handleRelease);
    this.#onEnd(event, this.#isDragging);
  };

  /**
   * Whether the pointer has moved far enough from the start to count as a drag.
   * @param {MouseEvent} event Current pointer event.
   * @returns {boolean} True once either axis moved at least the threshold.
   */
  #hasPassedThreshold(event) {
    const movedX = Math.abs(event.clientX - this.#startPointerX);
    const movedY = Math.abs(event.clientY - this.#startPointerY);
    return movedX >= this.#threshold || movedY >= this.#threshold;
  }
}
