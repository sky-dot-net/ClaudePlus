import { DateRange } from '../time/DateRange.js';
import { UNTITLED } from '../config/UNTITLED.js';

/**
 * Finds chats, files, web sources and tool uses matching a SearchQuery. Qualifiers naming a kind
 * (file, source, outlet, tool) restrict the results to those kinds; chat, before and after apply to
 * every kind; free terms must match the item's text or its conversation title.
 */
export class SearchEngine {
  /**
   * Result kinds selected by each kind qualifier.
   * @type {Readonly<Record<string, string>>}
   */
  static #KIND_OF_QUALIFIER = Object.freeze({ file: 'file', source: 'source', outlet: 'source', tool: 'tool' });

  /**
   * Label of each kind, for reasons and the kind column.
   * @type {Readonly<Record<string, string>>}
   */
  static #KIND_LABELS = Object.freeze({ chat: 'Chat', file: 'File', source: 'Source', tool: 'Tool' });

  /**
   * Label of a result kind.
   * @param {string} kind Result kind.
   * @returns {string} The label.
   */
  static kindLabel(kind) {
    return SearchEngine.#KIND_LABELS[kind] ?? kind;
  }

  /**
   * Searches everything indexed plus the listed conversation titles.
   * @param {SearchQuery} query The query.
   * @param {StatsAggregate} aggregate Indexed statistics.
   * @param {ConversationListing[]} conversations Listed conversations.
   * @returns {SearchItem[]} Matching items, each with its reason.
   */
  static find(query, aggregate, conversations) {
    const kinds = SearchEngine.#selectedKinds(query);
    return SearchEngine.#items(aggregate, conversations)
      .filter(item => kinds.has(item.kind) && SearchEngine.#matches(item, query))
      .map(item => ({ ...item, reason: SearchEngine.#reason(item, query) }));
  }

  /**
   * Kinds the query can return.
   * @param {SearchQuery} query The query.
   * @returns {Set<string>} The kinds named by kind qualifiers, or every kind when none is used.
   */
  static #selectedKinds(query) {
    const named = Object.keys(SearchEngine.#KIND_OF_QUALIFIER).filter(qualifier => query.uses(qualifier)).map(qualifier => SearchEngine.#KIND_OF_QUALIFIER[qualifier]);
    return new Set(named.length ? named : Object.keys(SearchEngine.#KIND_LABELS));
  }

  /**
   * Every searchable item.
   * @param {StatsAggregate} aggregate Indexed statistics.
   * @param {ConversationListing[]} conversations Listed conversations.
   * @returns {SearchItem[]} Chats, files, sources and tool uses.
   */
  static #items(aggregate, conversations) {
    const chats = conversations.map(conversation => SearchEngine.#item('chat', conversation.name || UNTITLED, null, { conversationId: conversation.uuid, conversationTitle: conversation.name || UNTITLED, timestamp: conversation.updated_at }));
    const files = aggregate.folders.flatMap(folder => folder.files).map(file => SearchEngine.#item('file', file.title || file.path, null, file));
    const sources = aggregate.sources.map(source => SearchEngine.#item('source', source.title, `${source.outlet || ''} ${source.url}`, source));
    const tools = [...aggregate.perConversation].flatMap(([conversationId, summary]) => summary.toolNames.map(toolName => SearchEngine.#item('tool', toolName, null, { conversationId, conversationTitle: summary.title, timestamp: summary.updatedAt })));
    return [...chats, ...files, ...sources, ...tools];
  }

  /**
   * Creates a search item.
   * @param {string} kind Item kind.
   * @param {string} text The item's own text.
   * @param {?string} detail Secondary text.
   * @param {{conversationId: string, conversationTitle: string, timestamp: ?string}} origin Conversation and time of the item.
   * @returns {SearchItem} The item.
   */
  static #item(kind, text, detail, origin) {
    return { kind, text, detail, conversationId: origin.conversationId, conversationTitle: origin.conversationTitle, timestamp: origin.timestamp };
  }

  /**
   * Whether an item satisfies every part of the query.
   * @param {SearchItem} item The item.
   * @param {SearchQuery} query The query.
   * @returns {boolean} True when it matches.
   */
  static #matches(item, query) {
    return SearchEngine.#matchesKindQualifiers(item, query)
      && query.patterns('chat').every(pattern => pattern.matches(item.conversationTitle))
      && SearchEngine.#matchesDates(item, query)
      && query.terms.every(term => term.matches(item.text) || term.matches(item.conversationTitle));
  }

  /**
   * Whether an item satisfies the qualifiers of its kind.
   * @param {SearchItem} item The item.
   * @param {SearchQuery} query The query.
   * @returns {boolean} True when every file, source, outlet or tool pattern relevant to the item matches.
   */
  static #matchesKindQualifiers(item, query) {
    const checks = {
      file: () => query.patterns('file').every(pattern => pattern.matches(item.text)),
      source: () => query.patterns('source').every(pattern => pattern.matches(item.text) || pattern.matches(item.detail))
        && query.patterns('outlet').every(pattern => pattern.matches(item.detail)),
      tool: () => query.patterns('tool').every(pattern => pattern.matches(item.text)),
      chat: () => true,
    };
    return checks[item.kind]();
  }

  /**
   * Whether an item's day is inside the before/after bounds.
   * @param {SearchItem} item The item.
   * @param {SearchQuery} query The query.
   * @returns {boolean} True when inside the bounds, or when no date qualifier is used.
   */
  static #matchesDates(item, query) {
    return new DateRange(query.lastValue('after'), query.lastValue('before')).contains(item.timestamp);
  }

  /**
   * Human-readable explanation of why an item matched.
   * @param {SearchItem} item The item.
   * @param {SearchQuery} query The query.
   * @returns {string} The criteria it satisfied, separated by semicolons.
   */
  static #reason(item, query) {
    const qualifierReasons = ['file', 'source', 'outlet', 'tool', 'chat', 'after', 'before']
      .filter(qualifier => query.uses(qualifier))
      .map(qualifier => `${qualifier}: ${query.lastValue(qualifier)}`);
    const termReasons = query.terms.map(term => `"${term.text}" in ${term.matches(item.text) ? SearchEngine.kindLabel(item.kind).toLowerCase() : 'chat title'}`);
    return [...qualifierReasons, ...termReasons].join('; ');
  }
}
