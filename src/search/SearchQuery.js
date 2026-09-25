import { WildcardPattern } from '../text/WildcardPattern.js';

/**
 * A parsed search query: free terms plus qualifiers such as `file:*.pdf` or `outlet:"new york times"`.
 * Qualifier values and terms may contain `*` wildcards; `before:` and `after:` take YYYY-MM-DD dates.
 */
export class SearchQuery {
  /**
   * Canonical qualifier per accepted qualifier name.
   * @type {Readonly<Record<string, string>>}
   */
  static #QUALIFIER_NAMES = Object.freeze({ chat: 'chat', title: 'chat', file: 'file', outlet: 'outlet', source: 'source', url: 'source', tool: 'tool', before: 'before', after: 'after' });

  /**
   * One token: a qualifier with a quoted or plain value, a quoted term, or a plain term.
   * @type {RegExp}
   */
  static #TOKEN = /(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g;

  /**
   * Free terms; each must match the item's own text or its conversation title.
   * @type {WildcardPattern[]}
   */
  #terms;

  /**
   * Qualifier values by canonical qualifier.
   * @type {Map<string, string[]>}
   */
  #qualifiers;

  /**
   * Creates a query.
   * @param {WildcardPattern[]} terms Free terms.
   * @param {Map<string, string[]>} qualifiers Qualifier values by canonical qualifier.
   */
  constructor(terms, qualifiers) {
    this.#terms = terms;
    this.#qualifiers = qualifiers;
  }

  /**
   * Parses query text. Unknown qualifiers are treated as free terms.
   * @param {string} text Query text.
   * @returns {SearchQuery} The query.
   */
  static parse(text) {
    const terms = [];
    const qualifiers = new Map();
    for (const token of text.matchAll(SearchQuery.#TOKEN)) SearchQuery.#addToken(token, terms, qualifiers);
    return new SearchQuery(terms, qualifiers);
  }

  /**
   * Whether the query has nothing to search for.
   * @returns {boolean} True without terms and qualifiers.
   */
  get isEmpty() {
    return this.#terms.length === 0 && this.#qualifiers.size === 0;
  }

  /**
   * Free terms.
   * @returns {WildcardPattern[]} The terms.
   */
  get terms() {
    return this.#terms;
  }

  /**
   * Patterns of a qualifier.
   * @param {string} qualifier Canonical qualifier name.
   * @returns {WildcardPattern[]} One pattern per value; empty when the qualifier isn't used.
   */
  patterns(qualifier) {
    return (this.#qualifiers.get(qualifier) ?? []).map(value => new WildcardPattern(value));
  }

  /**
   * Last value of a qualifier.
   * @param {string} qualifier Canonical qualifier name.
   * @returns {string} The value, or an empty string when the qualifier isn't used.
   */
  lastValue(qualifier) {
    const values = this.#qualifiers.get(qualifier) ?? [];
    return values.length ? values[values.length - 1] : '';
  }

  /**
   * Whether a qualifier is used.
   * @param {string} qualifier Canonical qualifier name.
   * @returns {boolean} True when it has at least one value.
   */
  uses(qualifier) {
    return this.#qualifiers.has(qualifier);
  }

  /**
   * Adds one token to the terms or qualifiers.
   * @param {RegExpMatchArray} token Token match.
   * @param {WildcardPattern[]} terms Free terms; modified in place.
   * @param {Map<string, string[]>} qualifiers Qualifier values; modified in place.
   * @returns {void}
   */
  static #addToken(token, terms, qualifiers) {
    const qualifier = SearchQuery.#qualifierOf(token);
    if (!qualifier) {
      terms.push(new WildcardPattern(token[4] ?? token[0]));
      return;
    }
    qualifiers.set(qualifier.name, [...(qualifiers.get(qualifier.name) ?? []), qualifier.value]);
  }

  /**
   * The known qualifier a token carries.
   * @param {RegExpMatchArray} token Token match.
   * @returns {?{name: string, value: string}} The canonical qualifier and its value, or null for a free term.
   */
  static #qualifierOf(token) {
    const name = token[1] ? SearchQuery.#QUALIFIER_NAMES[token[1].toLowerCase()] : undefined;
    return name ? { name, value: token[2] ?? token[3] } : null;
  }
}
