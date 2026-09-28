import { ChatFindPattern } from '../../search/ChatFindPattern.js';
import { ChatFinder } from '../../search/ChatFinder.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { TIMING } from '../../config/TIMING.js';
import { collectNamedElements } from '../../dom/collectNamedElements.js';
import stylesheet from './ChatFindBar.css';

StyleRegistry.register(stylesheet);

/**
 * The in-chat search bar at the bottom of a chat pane: a search field, a regular-expression
 * checkbox remembered per conversation, the current position among the matches, and buttons for the
 * previous, next, first and last match. It searches the messages' text, not the DOM, so it finds
 * matches in messages the windowed message list has not rendered.
 */
export class ChatFindBar {
  /**
   * Names of the buttons that need matches to work.
   * @type {string[]}
   */
  static #MATCH_BUTTONS = ['firstButton', 'previousButton', 'nextButton', 'lastButton'];

  /**
   * The bar's element.
   * @type {HTMLElement}
   */
  #bar;

  /**
   * The bar's named elements.
   * @type {Object<string, HTMLElement>}
   */
  #elements;

  /**
   * Session whose messages are searched.
   * @type {ChatSession}
   */
  #session;

  /**
   * The message list showing the matches.
   * @type {MessageListView}
   */
  #listView;

  /**
   * Per-conversation settings, for the regular-expression checkbox.
   * @type {ConversationSettings}
   */
  #settings;

  /**
   * Every match of the current search, in chat order.
   * @type {Array<{messageIndex: number, ordinal: number}>}
   */
  #hits = [];

  /**
   * Position in #hits of the current match, or -1 for none.
   * @type {number}
   */
  #position = -1;

  /**
   * Counts the searches started, so a slower, older search never replaces a newer one's result.
   * @type {number}
   */
  #searchCount = 0;

  /**
   * Pending typing debounce.
   * @type {?number}
   */
  #typingTimer = null;

  /**
   * Builds the bar into its element and follows the session.
   * @param {object} parts What the bar works with.
   * @param {HTMLElement} parts.element Empty element the bar is built into, at the bottom of the chat.
   * @param {Panel} parts.ownerPanel Panel owning the subscriptions.
   * @param {ChatSession} parts.session Session whose messages are searched.
   * @param {MessageListView} parts.listView The message list showing the matches.
   * @param {ConversationSettings} parts.settings Per-conversation settings.
   */
  constructor({ element, ownerPanel, session, listView, settings }) {
    this.#bar = element;
    this.#session = session;
    this.#listView = listView;
    this.#settings = settings;
    element.innerHTML = ChatFindBar.#html();
    this.#elements = collectNamedElements(element);
    this.#bindEvents();
    ownerPanel.listenTo(session, 'messages', () => this.#onMessagesChanged());
    ownerPanel.listenTo(session, 'openConversation', () => this.#onConversationChanged());
  }

  /**
   * Whether the bar is shown.
   * @returns {boolean} True while open.
   */
  get isOpen() {
    return !this.#bar.hidden;
  }

  /**
   * Opens the bar and focuses its field, closes it when its field already has the focus, and just
   * focuses the field when the bar is open elsewhere.
   * @returns {void}
   */
  toggle() {
    if (this.isOpen && document.activeElement === this.#elements.findInput) this.close();
    else this.open();
  }

  /**
   * Opens the bar and focuses its field, filling it with the selected text if there is a short one.
   * @returns {void}
   */
  open() {
    const selected = ChatFindBar.#selectedText();
    this.#bar.hidden = false;
    this.#elements.regexCheckbox.checked = this.#settings.get(this.#session.openConversationId, 'findIsRegex', false);
    if (selected) this.#elements.findInput.value = selected;
    this.#elements.findInput.focus();
    this.#elements.findInput.select();
    this.#search(true);
  }

  /**
   * Closes the bar and removes the matches' marks.
   * @returns {void}
   */
  close() {
    this.#bar.hidden = true;
    this.#searchCount += 1;
    this.#hits = [];
    this.#position = -1;
    this.#listView.showFind(null, null);
  }

  /**
   * The bar's markup.
   * @returns {string} The HTML.
   */
  static #html() {
    return `
      <input class="claude-plus-find-bar__input" data-name="findInput" type="text" placeholder="Find in chat…  (* is a wildcard)" spellcheck="false" />
      <label class="claude-plus-find-bar__regex" title="Read the text as a regular expression"><input type="checkbox" data-name="regexCheckbox" /> Regex</label>
      <span class="claude-plus-find-bar__count" data-name="countLabel" title="Current match / matches"></span>
      <button class="claude-plus-find-bar__button" data-name="firstButton" title="First match">«</button>
      <button class="claude-plus-find-bar__button" data-name="previousButton" title="Previous match (Shift+Enter)">←</button>
      <button class="claude-plus-find-bar__button" data-name="nextButton" title="Next match (Enter)">→</button>
      <button class="claude-plus-find-bar__button" data-name="lastButton" title="Last match">»</button>
      <button class="claude-plus-find-bar__button" data-name="closeButton" title="Close (Esc)">✕</button>`;
  }

  /**
   * The selected text when it is a short single line worth searching for.
   * @returns {string} The text, or an empty string.
   */
  static #selectedText() {
    const text = (window.getSelection()?.toString() ?? '').trim();
    return ChatFindBar.#isWorthSearching(text) ? text : '';
  }

  /**
   * Whether selected text is a short single line.
   * @param {string} text The text.
   * @returns {boolean} True for one to a hundred characters without a line break.
   */
  static #isWorthSearching(text) {
    return text.length > 0 && text.length <= 100 && !text.includes('\n');
  }

  /**
   * Wires the field and the buttons.
   * @returns {void}
   */
  #bindEvents() {
    const elements = this.#elements;
    elements.findInput.addEventListener('input', () => this.#onTyping());
    elements.findInput.addEventListener('keydown', event => this.#onKeydown(event));
    elements.regexCheckbox.addEventListener('change', () => this.#onRegexToggled());
    elements.firstButton.addEventListener('click', () => this.#jumpTo(0));
    elements.previousButton.addEventListener('click', () => this.#step(-1));
    elements.nextButton.addEventListener('click', () => this.#step(1));
    elements.lastButton.addEventListener('click', () => this.#jumpTo(this.#hits.length - 1));
    elements.closeButton.addEventListener('click', () => this.close());
  }

  /**
   * Searches shortly after the last keystroke.
   * @returns {void}
   */
  #onTyping() {
    clearTimeout(this.#typingTimer);
    this.#typingTimer = setTimeout(() => this.#search(true), TIMING.findTypingMs);
  }

  /**
   * Next match on Enter, previous on Shift+Enter, close on Escape.
   * @param {KeyboardEvent} event The key press in the field.
   * @returns {void}
   */
  #onKeydown(event) {
    if (event.key === 'Escape') this.close();
    else if (event.key === 'Enter') this.#step(event.shiftKey ? -1 : 1);
    else return;
    event.preventDefault();
  }

  /**
   * Remembers the checkbox for the open conversation and searches again.
   * @returns {void}
   */
  #onRegexToggled() {
    this.#settings.set(this.#session.openConversationId, 'findIsRegex', this.#elements.regexCheckbox.checked);
    this.#search(true);
  }

  /**
   * Searches again after the messages changed (a reply streaming in, a branch switched), keeping
   * the view where it is.
   * @returns {void}
   */
  #onMessagesChanged() {
    if (this.isOpen) this.#search(false);
  }

  /**
   * Takes the checkbox from the newly opened conversation's settings and searches it.
   * @returns {void}
   */
  #onConversationChanged() {
    if (!this.isOpen) return;
    this.#elements.regexCheckbox.checked = this.#settings.get(this.#session.openConversationId, 'findIsRegex', false);
    this.#search(false);
  }

  /**
   * Searches the chat for what the field holds and shows the result.
   * @param {boolean} shouldReveal Whether to scroll to the match nearest the current view, rather than leaving the view alone.
   * @returns {Promise<void>} Resolves once the result is shown; not at all when a newer search replaced it.
   */
  async #search(shouldReveal) {
    clearTimeout(this.#typingTimer);
    this.#searchCount += 1;
    const searchNumber = this.#searchCount;
    const { regex, isInvalid } = ChatFindPattern.compile(this.#elements.findInput.value, this.#elements.regexCheckbox.checked);
    this.#elements.findInput.classList.toggle('claude-plus-find-bar__input--invalid', isInvalid);
    const previousHit = this.#hits[this.#position];
    this.#hits = [];
    this.#position = -1;
    if (!regex) {
      this.#listView.showFind(null, null);
      this.#renderCount(isInvalid ? 'invalid' : '');
      return;
    }
    this.#renderCount('…');
    const hits = await ChatFinder.find(this.#session.messages, regex, () => searchNumber !== this.#searchCount);
    if (hits) this.#showResult(regex, hits, previousHit, shouldReveal);
  }

  /**
   * Shows a finished search: the count, the marks and, when asked, the first match.
   * @param {RegExp} regex The expression that was searched for.
   * @param {Array<{messageIndex: number, ordinal: number}>} hits Every match.
   * @param {?{messageIndex: number, ordinal: number}} previousHit The match the search was at before.
   * @param {boolean} shouldReveal Whether to scroll to the match.
   * @returns {void}
   */
  #showResult(regex, hits, previousHit, shouldReveal) {
    this.#hits = hits;
    this.#position = this.#initialPosition(previousHit, shouldReveal);
    this.#listView.showFind(regex, this.#hits[this.#position] ?? null);
    this.#renderCount();
    if (shouldReveal && this.#position >= 0) this.#listView.revealFindHit(this.#hits[this.#position]);
  }

  /**
   * Which match a fresh result starts at: the same one as before when the view is not being moved
   * and it still exists, else the first at or after the message in view, else the last.
   * @param {?{messageIndex: number, ordinal: number}} previousHit The match the search was at.
   * @param {boolean} shouldReveal Whether the search is moving the view rather than following the chat.
   * @returns {number} The position, or -1 when there are no matches.
   */
  #initialPosition(previousHit, shouldReveal) {
    if (!this.#hits.length) return -1;
    const same = this.#positionOf(previousHit);
    if (same >= 0 && !shouldReveal) return same;
    const firstInView = this.#listView.firstVisibleIndex();
    const inView = this.#hits.findIndex(hit => hit.messageIndex >= firstInView);
    return inView >= 0 ? inView : this.#hits.length - 1;
  }

  /**
   * Position of a match among the current ones.
   * @param {?{messageIndex: number, ordinal: number}} match The match.
   * @returns {number} The position, or -1 when it is not among them.
   */
  #positionOf(match) {
    return match ? this.#hits.findIndex(hit => hit.messageIndex === match.messageIndex && hit.ordinal === match.ordinal) : -1;
  }

  /**
   * Moves to the next or previous match, wrapping around.
   * @param {number} delta 1 for the next match, -1 for the previous.
   * @returns {void}
   */
  #step(delta) {
    if (!this.#hits.length) return;
    this.#jumpTo((this.#position + delta + this.#hits.length) % this.#hits.length);
  }

  /**
   * Moves to a match and scrolls to it.
   * @param {number} position Position among the matches.
   * @returns {void}
   */
  #jumpTo(position) {
    if (position < 0 || position >= this.#hits.length) return;
    this.#position = position;
    this.#renderCount();
    this.#listView.showFind(this.#currentRegex(), this.#hits[position]);
    this.#listView.revealFindHit(this.#hits[position]);
  }

  /**
   * The expression of the search the field holds.
   * @returns {?RegExp} The expression, or null when the field is empty or invalid.
   */
  #currentRegex() {
    return ChatFindPattern.compile(this.#elements.findInput.value, this.#elements.regexCheckbox.checked).regex;
  }

  /**
   * Shows the position among the matches, or a message.
   * @param {string} [message] Text to show instead of the position.
   * @returns {void}
   */
  #renderCount(message) {
    const hasHits = this.#hits.length > 0;
    const position = hasHits ? this.#position + 1 : 0;
    this.#elements.countLabel.textContent = message ?? (this.#elements.findInput.value ? `${position}/${this.#hits.length}` : '');
    ChatFindBar.#MATCH_BUTTONS.forEach(name => { this.#elements[name].disabled = !hasHits; });
  }
}
