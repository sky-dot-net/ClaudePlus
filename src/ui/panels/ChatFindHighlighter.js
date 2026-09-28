import { ChatFindPattern } from '../../search/ChatFindPattern.js';

/**
 * Marks the matches of an in-chat search in the rendered messages using the browser's CSS Custom
 * Highlight API, which paints ranges of text without changing the DOM - so the marks neither
 * disturb the message list's measuring nor need undoing before a message is re-rendered.
 */
export class ChatFindHighlighter {
  /**
   * Highlight name for every match.
   * @type {string}
   */
  static #MATCH_NAME = 'claude-plus-find';

  /**
   * Highlight name for the match the search is at.
   * @type {string}
   */
  static #CURRENT_NAME = 'claude-plus-find-current';

  /**
   * The ranges of every match currently painted by this highlighter.
   * @type {?Highlight}
   */
  #matches = null;

  /**
   * The range of the current match currently painted by this highlighter.
   * @type {?Highlight}
   */
  #current = null;

  /**
   * Paints the matches in the given rendered messages, replacing what this highlighter painted before.
   * @param {Array<{body: HTMLElement, messageIndex: number}>} messages The rendered messages' bodies.
   * @param {RegExp} regex The global expression to mark.
   * @param {?{messageIndex: number, ordinal: number}} currentHit The match to mark as current, if any.
   * @returns {?Range} The current match's range when it is among the rendered messages.
   */
  paint(messages, regex, currentHit) {
    if (typeof Highlight === 'undefined') return null;
    const rangesByMessage = messages.map(({ body, messageIndex }) => ({ messageIndex, ranges: ChatFindHighlighter.#rangesIn(body, regex) }));
    const currentRange = ChatFindHighlighter.#currentRange(rangesByMessage, currentHit);
    this.#matches = ChatFindHighlighter.#register(ChatFindHighlighter.#MATCH_NAME, this.#matches, rangesByMessage.flatMap(entry => entry.ranges));
    this.#current = ChatFindHighlighter.#register(ChatFindHighlighter.#CURRENT_NAME, this.#current, currentRange ? [currentRange] : []);
    return currentRange;
  }

  /**
   * Removes everything this highlighter painted.
   * @returns {void}
   */
  clear() {
    if (typeof Highlight === 'undefined') return;
    this.#matches = ChatFindHighlighter.#register(ChatFindHighlighter.#MATCH_NAME, this.#matches, []);
    this.#current = ChatFindHighlighter.#register(ChatFindHighlighter.#CURRENT_NAME, this.#current, []);
  }

  /**
   * The range of the current match.
   * @param {Array<{messageIndex: number, ranges: Range[]}>} rangesByMessage Each rendered message's match ranges.
   * @param {?{messageIndex: number, ordinal: number}} currentHit The current match.
   * @returns {?Range} Its range, or null when its message is not rendered.
   */
  static #currentRange(rangesByMessage, currentHit) {
    const entry = currentHit ? rangesByMessage.find(candidate => candidate.messageIndex === currentHit.messageIndex) : null;
    return entry?.ranges[currentHit.ordinal] ?? null;
  }

  /**
   * Publishes ranges under a highlight name, removing this highlighter's previous ones first; a
   * name another highlighter has taken over is left alone when there is nothing to paint.
   * @param {string} name Highlight name.
   * @param {?Highlight} previous What this highlighter registered before.
   * @param {Range[]} ranges The ranges to paint.
   * @returns {?Highlight} The registered highlight, or null when nothing is painted.
   */
  static #register(name, previous, ranges) {
    if (previous && CSS.highlights.get(name) === previous) CSS.highlights.delete(name);
    if (!ranges.length) return null;
    const highlight = new Highlight(...ranges);
    CSS.highlights.set(name, highlight);
    return highlight;
  }

  /**
   * The ranges of every match in an element's text.
   * @param {HTMLElement} element The element.
   * @param {RegExp} regex The global expression.
   * @returns {Range[]} One range per match, in order.
   */
  static #rangesIn(element, regex) {
    const segments = ChatFindHighlighter.#textSegments(element);
    const text = segments.map(segment => segment.node.data).join('');
    return ChatFindPattern.matchesIn(regex, text).map(match => ChatFindHighlighter.#range(segments, match.start, match.start + match.length));
  }

  /**
   * An element's text nodes with the position each starts at in the element's whole text.
   * @param {HTMLElement} element The element.
   * @returns {Array<{node: Text, start: number}>} The text nodes, in order.
   */
  static #textSegments(element) {
    const segments = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let start = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      segments.push({ node, start });
      start += node.data.length;
    }
    return segments;
  }

  /**
   * The range covering a stretch of an element's text.
   * @param {Array<{node: Text, start: number}>} segments The element's text nodes.
   * @param {number} start Position of the first character.
   * @param {number} end Position after the last character.
   * @returns {Range} The range.
   */
  static #range(segments, start, end) {
    const first = segments.findLast(segment => segment.start <= start);
    const last = segments.findLast(segment => segment.start < end);
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  }
}
