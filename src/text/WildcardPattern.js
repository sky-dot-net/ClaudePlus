/**
 * Case-insensitive text matching with `*` wildcards. A pattern without a wildcard matches any text
 * containing it; a pattern with wildcards must match the whole text, each `*` standing for any
 * characters (so `*nbc*` matches both "NBC" and "MSNBC").
 */
export class WildcardPattern {
  /**
   * Lower-case pattern text.
   * @type {string}
   */
  #needle;

  /**
   * Compiled whole-text matcher, or null for plain substring matching.
   * @type {?RegExp}
   */
  #wildcardMatcher;

  /**
   * Compiles a pattern.
   * @param {string} pattern Pattern text; surrounding whitespace is ignored.
   */
  constructor(pattern) {
    this.#needle = pattern.trim().toLowerCase();
    this.#wildcardMatcher = this.#needle.includes('*') ? WildcardPattern.#toRegExp(this.#needle) : null;
  }

  /**
   * Whether the pattern is empty and therefore matches everything.
   * @returns {boolean} True for an empty pattern.
   */
  get isEmpty() {
    return this.#needle === '';
  }

  /**
   * The pattern as typed, lower-cased.
   * @returns {string} The pattern text.
   */
  get text() {
    return this.#needle;
  }

  /**
   * Tests a value against the pattern.
   * @param {*} value Value to test; null and undefined count as empty text.
   * @returns {boolean} True when the value matches.
   */
  matches(value) {
    if (this.isEmpty) return true;
    const text = String(value ?? '').toLowerCase();
    return this.#wildcardMatcher ? this.#wildcardMatcher.test(text) : text.includes(this.#needle);
  }

  /**
   * Builds a whole-text regular expression from a wildcard pattern.
   * @param {string} pattern Lower-case pattern containing `*`.
   * @returns {RegExp} The expression.
   */
  static #toRegExp(pattern) {
    const escapedParts = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${escapedParts.join('.*')}$`);
  }
}
