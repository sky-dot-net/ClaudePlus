import { ChatFindPattern } from './ChatFindPattern.js';

/**
 * Finds a pattern in the text of a chat's messages themselves rather than in what is currently
 * rendered, so it also finds messages the windowed message list has not rendered.
 */
export class ChatFinder {
  /**
   * Messages between yields to the browser, so searching a very long chat never blocks the page.
   * @type {number}
   */
  static #YIELD_EVERY = 250;

  /**
   * Each message's text as it reads once rendered, with the HTML it was extracted from, so a
   * message that changed (streaming) is extracted again.
   * @type {WeakMap<ChatMessage, {html: string, text: string}>}
   */
  static #texts = new WeakMap();

  /**
   * Finds every match in every message.
   * @param {ChatMessage[]} messages The messages, in order.
   * @param {RegExp} regex The global expression to find.
   * @param {function(): boolean} isCancelled Whether the result is no longer wanted.
   * @returns {Promise<?Array<{messageIndex: number, ordinal: number}>>} One entry per match: the
   * message and which match in it (from 0); null when cancelled.
   */
  static async find(messages, regex, isCancelled) {
    const hits = [];
    for (let index = 0; index < messages.length; index += 1) {
      if (index % ChatFinder.#YIELD_EVERY === 0) await new Promise(resolve => setTimeout(resolve, 0));
      if (isCancelled()) return null;
      ChatFindPattern.matchesIn(regex, ChatFinder.textOf(messages[index])).forEach((match, ordinal) => hits.push({ messageIndex: index, ordinal }));
    }
    return hits;
  }

  /**
   * A message's text as it reads once rendered - its HTML without the markup.
   * @param {ChatMessage} message The message.
   * @returns {string} The text.
   */
  static textOf(message) {
    const html = message.html ?? '';
    const cached = ChatFinder.#texts.get(message);
    if (cached && cached.html === html) return cached.text;
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
    ChatFinder.#texts.set(message, { html, text });
    return text;
  }
}
