/**
 * Orders two sortable values ascending.
 * @param {string|number} first First value.
 * @param {string|number} second Second value.
 * @returns {number} Negative if the first sorts first, positive if the second does, 0 if equal.
 */
export function compareAscending(first, second) {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}
