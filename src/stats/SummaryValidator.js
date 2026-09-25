/**
 * Checks that a record read from the stats cache has the shape this script writes, so a stale or
 * damaged record is skipped (and re-indexed later) instead of breaking the panels.
 */
export class SummaryValidator {
  /**
   * Check per required field.
   * @type {Readonly<Record<string, function(*): boolean>>}
   */
  static #FIELD_CHECKS = Object.freeze({
    conversationId: value => typeof value === 'string',
    title: value => typeof value === 'string',
    updatedAt: value => typeof value === 'string',
    promptCount: Number.isFinite,
    estimatedTokensIn: Number.isFinite,
    estimatedTokensOut: Number.isFinite,
    toolCallCounts: value => Boolean(value) && typeof value === 'object',
    sources: Array.isArray,
    files: Array.isArray,
    responseTimesMs: Array.isArray,
  });

  /**
   * Whether a record is a well-formed ConversationSummary.
   * @param {*} record Record read from IndexedDB.
   * @returns {boolean} True when every field and every source and file entry is well formed.
   */
  static isValid(record) {
    return Boolean(record) && Object.entries(SummaryValidator.#FIELD_CHECKS).every(([field, check]) => check(record[field]))
      && record.sources.every(SummaryValidator.#isValidSource) && record.files.every(SummaryValidator.#isValidFile);
  }

  /**
   * Whether a stored source entry is well formed.
   * @param {*} source Stored entry.
   * @returns {boolean} True when it has a string title and URL.
   */
  static #isValidSource(source) {
    return Boolean(source) && typeof source.title === 'string' && typeof source.url === 'string';
  }

  /**
   * Whether a stored file entry is well formed.
   * @param {*} file Stored entry.
   * @returns {boolean} True when it has a string path and title.
   */
  static #isValidFile(file) {
    return Boolean(file) && typeof file.path === 'string' && typeof file.title === 'string';
  }
}
