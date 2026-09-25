/**
 * Entries of a count map, highest count first.
 * @param {Object<string, number>} counts The count map.
 * @returns {Array<[string, number]>} [key, count] pairs sorted by descending count.
 */
export function entriesByDescendingCount(counts) {
  return Object.entries(counts).sort((first, second) => second[1] - first[1]);
}
