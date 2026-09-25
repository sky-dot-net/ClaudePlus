/**
 * Collects every descendant marked with a data-name attribute, keyed by that name.
 * @param {HTMLElement} root Element to search.
 * @returns {Object<string, HTMLElement>} The marked elements by name.
 */
export function collectNamedElements(root) {
  return Object.fromEntries([...root.querySelectorAll('[data-name]')].map(element => [element.dataset.name, element]));
}
