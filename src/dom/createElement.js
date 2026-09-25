/**
 * Creates an element and assigns properties to it.
 * @param {string} tagName Tag name.
 * @param {object} properties Element properties to set, e.g. className, textContent, innerHTML, title, hidden.
 * @returns {HTMLElement} The new element.
 */
export function createElement(tagName, properties) {
  return Object.assign(document.createElement(tagName), properties);
}
