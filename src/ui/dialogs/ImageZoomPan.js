import { DragGesture } from '../../dom/DragGesture.js';
import { clamp } from '../../math/clamp.js';

/**
 * Zooms an image with the mouse wheel over its frame and pans it by dragging, through a CSS transform.
 */
export class ImageZoomPan {
  /**
   * Factor applied to the scale per wheel step.
   * @type {number}
   */
  static #ZOOM_STEP = 1.15;

  /**
   * Smallest scale; the image's fitted size.
   * @type {number}
   */
  static #MIN_SCALE = 1;

  /**
   * Largest scale.
   * @type {number}
   */
  static #MAX_SCALE = 8;

  /**
   * The transformed image.
   * @type {HTMLImageElement}
   */
  #image;

  /**
   * Current scale.
   * @type {number}
   */
  #scale = ImageZoomPan.#MIN_SCALE;

  /**
   * Current horizontal offset in pixels.
   * @type {number}
   */
  #offsetX = 0;

  /**
   * Current vertical offset in pixels.
   * @type {number}
   */
  #offsetY = 0;

  /**
   * Makes an image zoomable and pannable.
   * @param {HTMLElement} frame Element receiving the wheel events.
   * @param {HTMLImageElement} image The image to transform.
   */
  constructor(frame, image) {
    this.#image = image;
    frame.addEventListener('wheel', event => this.#zoom(event), { passive: false });
    image.addEventListener('mousedown', event => this.#startPan(event));
  }

  /**
   * Zooms one step in or out, keeping the offset proportional to the scale.
   * @param {WheelEvent} event The wheel event.
   * @returns {void}
   */
  #zoom(event) {
    event.preventDefault();
    const stepFactor = event.deltaY < 0 ? ImageZoomPan.#ZOOM_STEP : 1 / ImageZoomPan.#ZOOM_STEP;
    const nextScale = clamp(this.#scale * stepFactor, ImageZoomPan.#MIN_SCALE, ImageZoomPan.#MAX_SCALE);
    const scaleRatio = nextScale / this.#scale;
    this.#scale = nextScale;
    this.#moveTo(this.#offsetX * scaleRatio, this.#offsetY * scaleRatio);
  }

  /**
   * Pans the image along with the pointer until the button is released.
   * @param {MouseEvent} startEvent The mousedown on the image.
   * @returns {void}
   */
  #startPan(startEvent) {
    startEvent.preventDefault();
    const startOffsetX = this.#offsetX;
    const startOffsetY = this.#offsetY;
    new DragGesture(startEvent, {
      threshold: 0,
      onMove: event => this.#moveTo(startOffsetX + event.clientX - startEvent.clientX, startOffsetY + event.clientY - startEvent.clientY),
      onEnd: () => undefined,
    });
  }

  /**
   * Sets the offset and applies the transform.
   * @param {number} offsetX Horizontal offset in pixels.
   * @param {number} offsetY Vertical offset in pixels.
   * @returns {void}
   */
  #moveTo(offsetX, offsetY) {
    this.#offsetX = offsetX;
    this.#offsetY = offsetY;
    this.#image.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${this.#scale})`;
  }
}
