/**
 * Serializes a value to JSON with every object's keys sorted, so two values built from the same
 * data by independent code paths compare equal regardless of key insertion order.
 * @param {*} value The value.
 * @returns {string} The canonical JSON text.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Recursively rebuilds a value with every plain object's keys sorted; arrays keep their order,
 * since it's meaningful there.
 * @param {*} value The value.
 * @returns {*} An equivalent value with sorted object keys.
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') return sortObjectKeys(value);
  return value;
}

/**
 * Rebuilds a plain object with its keys sorted and its values recursively sorted.
 * @param {object} value The object.
 * @returns {object} The rebuilt object.
 */
function sortObjectKeys(value) {
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeysDeep(value[key])]));
}
