/**
 * Positions a fixed-position element over a rectangle.
 * @param {HTMLElement} element The element.
 * @param {Rect} rect Target rectangle.
 * @returns {void}
 */
export function placeElement(element, rect) {
  Object.assign(element.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}
