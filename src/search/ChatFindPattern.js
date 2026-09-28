/**
 * The pattern of an in-chat search, built from what was typed: plain text in which * stands for any
 * run of characters within a line, or a regular expression. Matching ignores case.
 */
export class ChatFindPattern {
  /**
   * Characters that mean something in a regular expression and are escaped in plain text.
   * @type {RegExp}
   */
  static #SPECIAL_CHARACTERS = /[.+?^${}()|[\]\\]/g;

  /**
   * Compiles what was typed.
   * @param {string} text The typed text.
   * @param {boolean} isRegex Whether it is a regular expression rather than text with * wildcards.
   * @returns {{regex: ?RegExp, isInvalid: boolean}} The global, case-insensitive expression - null
   * for empty text or an invalid expression, the latter flagged.
   */
  static compile(text, isRegex) {
    if (!text) return { regex: null, isInvalid: false };
    const source = isRegex ? text : text.replace(ChatFindPattern.#SPECIAL_CHARACTERS, '\\$&').replace(/\*/g, '[^\\n]*?');
    try {
      return { regex: new RegExp(source, 'gi'), isInvalid: false };
    } catch {
      return { regex: null, isInvalid: true };
    }
  }

  /**
   * Every non-empty match of an expression in a text.
   * @param {RegExp} regex A global expression; its position is reset.
   * @param {string} text The text to search.
   * @returns {Array<{start: number, length: number}>} The matches, in order.
   */
  static matchesIn(regex, text) {
    const matches = [];
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match; match = regex.exec(text)) {
      if (match[0].length === 0) regex.lastIndex += 1;
      else matches.push({ start: match.index, length: match[0].length });
    }
    return matches;
  }
}
