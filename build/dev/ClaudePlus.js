// ==UserScript==
// @name         ClaudePlus
// @namespace    skydotnet.claudeplus
// @version      1.2.0
// @description  Replaces claude.ai's UI with a VS Code-style dockable, resizable, tabbed workspace: conversation list, chat, composer, plus Stats / Web Sources / Files panels, all driven by claude.ai's internal REST/completion API.
// @match        https://claude.ai/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
  'use strict';

  /**
   * IndexedDB database: conversation summaries keyed by conversation id, active time keyed by day,
   * extracted widget cards keyed by a hash of their tool name and data, and imported-data-export
   * records. Each store maps to its key path; a key path can be a single field or, for a record with
   * no single natural id, an array of fields forming a compound key.
   * @type {Readonly<{name: string, version: number, stores: Readonly<Record<string, string>>, keyPaths: Readonly<Record<string, string|string[]>>}>}
   */
  const DATABASE = Object.freeze({
    name: 'claudePlus',
    version: 3,
    stores: Object.freeze({
      conversationSummaries: 'conversationSummaries',
      activity: 'activity',
      widgetCards: 'widgetCards',
      importedConversations: 'importedConversations',
      importedMemoryFiles: 'importedMemoryFiles',
      importedArtifacts: 'importedArtifacts',
      importedProjects: 'importedProjects',
      importedFeedbackPeriods: 'importedFeedbackPeriods',
      importedAccountProfiles: 'importedAccountProfiles',
      importedLoginEvents: 'importedLoginEvents',
    }),
    keyPaths: Object.freeze({
      conversationSummaries: 'conversationId',
      activity: 'day',
      widgetCards: 'hash',
      importedConversations: 'conversationId',
      importedMemoryFiles: ['accountId', 'path'],
      importedArtifacts: 'artifactId',
      importedProjects: 'projectId',
      importedFeedbackPeriods: ['accountId', 'period'],
      importedAccountProfiles: 'accountId',
      importedLoginEvents: ['accountId', 'timestamp', 'ipAddress'],
    }),
  });

  /**
   * Minimal publish/subscribe base class.
   */
  class EventEmitter {
    /**
     * Listeners per event name.
     * @type {Map<string, Set<function(*): void>>}
     */
    #listenersByEvent = new Map();

    /**
     * Subscribes to an event.
     * @param {string} eventName Event name.
     * @param {function(*): void} listener Called with the event payload.
     * @returns {function(): void} Unsubscribes the listener.
     */
    subscribe(eventName, listener) {
      if (!this.#listenersByEvent.has(eventName)) this.#listenersByEvent.set(eventName, new Set());
      this.#listenersByEvent.get(eventName).add(listener);
      return () => this.#listenersByEvent.get(eventName).delete(listener);
    }

    /**
     * Calls every listener of an event. Listeners added or removed during the call don't affect it.
     * @param {string} eventName Event name.
     * @param {*} [payload] Value passed to each listener.
     * @returns {void}
     */
    publish(eventName, payload) {
      for (const listener of [...(this.#listenersByEvent.get(eventName) ?? [])]) listener(payload);
    }
  }

  /**
   * Prefix for every console message this script writes.
   * @type {string}
   */
  const LOG_PREFIX = '[ClaudePlus]';

  /**
   * Timing in milliseconds. rateLimitPollMs: usage polling interval. activitySampleMs: activity
   * sampling interval. idleAfterMs: time without input after which the user counts as idle.
   * activitySaveMs: how often activity is written to IndexedDB. backfillPauseMs: pause between
   * conversation fetches during a backfill. maxResponseGapMs: longest prompt-to-answer gap still
   * counted as a response time. copyFeedbackMs: how long the copy button shows a check mark.
   * downloadUrlLifetimeMs: how long a download's object URL stays valid after the download starts.
   * widgetExtractPollMs: how often the widget extractor checks its hidden iframe for the rendered card.
   * modelCatalogPollMs: how often the model catalog extractor checks its hidden iframe.
   * modelCatalogTimeoutMs: time budget for extracting the model/effort catalog before giving up.
   * modelCatalogTtlMs: how long an extracted catalog is trusted before it's refreshed again.
   * messageHighlightMs: how long a message stays highlighted after being scrolled to from search.
   * resizeSettleMs: how long a list's width must stay unchanged before it is laid out again, so
   * dragging a panel divider doesn't re-render on every pixel.
   * findTypingMs: pause after the last keystroke in the in-chat search field before it searches.
   * @type {Readonly<Record<string, number>>}
   */
  const TIMING = Object.freeze({
    rateLimitPollMs: 30_000,
    activitySampleMs: 1_000,
    idleAfterMs: 60_000,
    activitySaveMs: 15_000,
    backfillPauseMs: 300,
    maxResponseGapMs: 30 * 60 * 1000,
    copyFeedbackMs: 1_000,
    downloadUrlLifetimeMs: 10_000,
    widgetExtractPollMs: 500,
    modelCatalogPollMs: 300,
    modelCatalogTimeoutMs: 20_000,
    modelCatalogTtlMs: 12 * 60 * 60 * 1000,
    messageHighlightMs: 2_000,
    resizeSettleMs: 200,
    findTypingMs: 150,
  });

  /**
   * Counts time the tab is visible and receiving input, per day. Time is added to the stored day
   * total rather than overwriting it, so several open tabs accumulate.
   * @fires ActivityTracker#activity After every sample.
   */
  class ActivityTracker extends EventEmitter {
    /**
     * Events that count as user input.
     * @type {string[]}
     */
    static #INPUT_EVENTS = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'];

    /**
     * Activity storage.
     * @type {IndexedDbStore}
     */
    #database;

    /**
     * Day being counted, as YYYY-MM-DD in UTC.
     * @type {string}
     */
    #countedDay = ActivityTracker.#today();

    /**
     * Epoch milliseconds of the last input.
     * @type {number}
     */
    #lastInputTime = Date.now();

    /**
     * Active milliseconds not yet written to storage.
     * @type {number}
     */
    #unsavedMs = 0;

    /**
     * Creates the tracker.
     * @param {IndexedDbStore} database Activity storage.
     */
    constructor(database) {
      super();
      this.#database = database;
      this.activeTodayMs = 0;
      this.activeAllTimeMs = 0;
      this.isIdle = false;
    }

    /**
     * The current day key.
     * @returns {string} Today as YYYY-MM-DD in UTC.
     */
    static #today() {
      return new Date().toISOString().slice(0, 10);
    }

    /**
     * Loads stored totals and starts sampling and periodic saving. Also saves when the tab is hidden
     * or closed.
     * @returns {Promise<void>} Resolves once started.
     */
    async start() {
      await this.#loadTotals();
      for (const eventType of ActivityTracker.#INPUT_EVENTS) document.addEventListener(eventType, this.#recordInput, { passive: true });
      document.addEventListener('visibilitychange', this.#saveWhenHidden);
      window.addEventListener('pagehide', () => this.#saveUnsavedTime());
      setInterval(() => this.#sampleActivity(), TIMING.activitySampleMs);
      setInterval(() => this.#saveUnsavedTime(), TIMING.activitySaveMs);
      this.publish('activity');
    }

    /**
     * Records the time of user input.
     * @returns {void}
     */
    #recordInput = () => {
      this.#lastInputTime = Date.now();
    };

    /**
     * Saves unsaved time when the tab becomes hidden.
     * @returns {void}
     */
    #saveWhenHidden = () => {
      if (document.visibilityState === 'hidden') this.#saveUnsavedTime();
    };

    /**
     * Reads today's and the all-time totals, ignoring malformed records. Failures are logged and leave both at zero.
     * @returns {Promise<void>} Resolves once loaded or failed.
     */
    async #loadTotals() {
      try {
        const records = (await this.#database.readAll(DATABASE.stores.activity)).filter(record => Boolean(record) && Number.isFinite(record.activeMs));
        const todayRecord = records.find(record => record.day === this.#countedDay);
        this.activeTodayMs = todayRecord ? todayRecord.activeMs : 0;
        this.activeAllTimeMs = records.reduce((sum, record) => sum + record.activeMs, 0);
      } catch (error) {
        console.warn(LOG_PREFIX, 'reading activity failed', error);
      }
    }

    /**
     * Takes one sample: rolls over at midnight, then counts the interval if the user is active.
     * @returns {void}
     */
    #sampleActivity() {
      if (ActivityTracker.#today() !== this.#countedDay) this.#startNewDay();
      this.isIdle = !this.#isUserActive();
      if (!this.isIdle) this.#addActiveTime(TIMING.activitySampleMs);
      this.publish('activity');
    }

    /**
     * Saves the finished day and starts counting a new one.
     * @returns {void}
     */
    #startNewDay() {
      this.#saveUnsavedTime();
      this.#countedDay = ActivityTracker.#today();
      this.activeTodayMs = 0;
    }

    /**
     * Whether the tab is visible and had input within the idle timeout.
     * @returns {boolean} True when the user counts as active.
     */
    #isUserActive() {
      return document.visibilityState === 'visible' && Date.now() - this.#lastInputTime <= TIMING.idleAfterMs;
    }

    /**
     * Adds active time to the totals and to the unsaved amount.
     * @param {number} durationMs Time to add.
     * @returns {void}
     */
    #addActiveTime(durationMs) {
      this.activeTodayMs += durationMs;
      this.activeAllTimeMs += durationMs;
      this.#unsavedMs += durationMs;
    }

    /**
     * Adds unsaved time to the stored day total. On failure the time is kept for the next attempt
     * unless the day has changed.
     * @returns {Promise<void>} Resolves once saved or failed.
     */
    async #saveUnsavedTime() {
      if (this.#unsavedMs === 0) return;
      const day = this.#countedDay;
      const durationMs = this.#unsavedMs;
      this.#unsavedMs = 0;
      try {
        await this.#database.update(DATABASE.stores.activity, day, record => ({ day, activeMs: (record ? record.activeMs : 0) + durationMs }));
      } catch (error) {
        this.#keepUnsavedTime(day, durationMs);
        console.warn(LOG_PREFIX, 'saving activity failed', error);
      }
    }

    /**
     * Puts back time that failed to save, if it belongs to the day still being counted.
     * @param {string} day Day the time belongs to.
     * @param {number} durationMs Time that failed to save.
     * @returns {void}
     */
    #keepUnsavedTime(day, durationMs) {
      if (day === this.#countedDay) this.#unsavedMs += durationMs;
    }
  }

  /**
   * The hotkey commands specific to claude.ai, in the order the Anthropic settings tab lists them,
   * shaped like the app's own (id, label, defaultChord). Ids start with "anthropic." so they never
   * collide with another group's. None exist yet; a command added here appears in the settings with
   * its chord rebindable, and runs the action registered for its id.
   * @type {ReadonlyArray<Readonly<{id: string, label: string, defaultChord: string}>>}
   */
  const ANTHROPIC_HOTKEY_COMMANDS = Object.freeze([]);

  /**
   * Whether an id belongs to a chat pane.
   * @param {*} panelId Panel id.
   * @returns {boolean} True for ids starting with "chat-".
   */
  function isChatPaneId(panelId) {
    return String(panelId).startsWith('chat-');
  }

  /**
   * Decides which border each chat pane shows: borders only appear while more than one chat pane
   * is visible, so the focused one can be told apart.
   */
  class ChatPaneBorders {
    /**
     * Whether more than one chat pane is visible at the moment.
     * @type {boolean}
     */
    #hasSeveralVisiblePanes = false;

    /**
     * Records which panels are visible after a layout.
     * @param {Set<string>} visiblePanelIds Ids of the visible panels.
     * @param {string[]} paneIds Ids of every chat pane.
     * @returns {boolean} True when the "several chat panes visible" state changed.
     */
    update(visiblePanelIds, paneIds) {
      const hasSeveral = paneIds.filter(paneId => visiblePanelIds.has(paneId)).length > 1;
      if (hasSeveral === this.#hasSeveralVisiblePanes) return false;
      this.#hasSeveralVisiblePanes = hasSeveral;
      return true;
    }

    /**
     * Which border a chat pane's tab and content should show, so its tab strip, frame and content
     * all agree: the focused pane gets the active (green) border, every other one a faint
     * theme-aware border, both only while more than one chat pane is visible. An id that isn't a
     * chat pane, or a chat pane while only one is visible, gets none.
     * @param {string} panelId Panel id.
     * @param {?string} focusedPaneId Id of the focused pane.
     * @returns {?('active'|'inactive')} The border kind, or null for none.
     */
    kindOf(panelId, focusedPaneId) {
      if (!isChatPaneId(panelId) || !this.#hasSeveralVisiblePanes) return null;
      return focusedPaneId === panelId ? 'active' : 'inactive';
    }
  }

  /**
   * The pattern of an in-chat search, built from what was typed: plain text in which * stands for any
   * run of characters within a line, or a regular expression. Matching ignores case.
   */
  class ChatFindPattern {
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

  /**
   * Finds a pattern in the text of a chat's messages themselves rather than in what is currently
   * rendered, so it also finds messages the windowed message list has not rendered.
   */
  class ChatFinder {
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

  /**
   * Collects the stylesheets of all components. Every component registers its own stylesheet when
   * its module is evaluated, so the app injects one combined stylesheet without knowing the components.
   */
  class StyleRegistry {
    /**
     * Registered stylesheets, in registration order.
     * @type {string[]}
     */
    static #stylesheets = [];

    /**
     * Adds a component's stylesheet.
     * @param {string} css The stylesheet text.
     * @returns {void}
     */
    static register(css) {
      StyleRegistry.#stylesheets.push(css);
    }

    /**
     * All registered stylesheets joined into one.
     * @returns {string} The combined stylesheet text.
     */
    static get combinedCss() {
      return StyleRegistry.#stylesheets.join('\n');
    }
  }

  /**
   * Collects every descendant marked with a data-name attribute, keyed by that name.
   * @param {HTMLElement} root Element to search.
   * @returns {Object<string, HTMLElement>} The marked elements by name.
   */
  function collectNamedElements(root) {
    return Object.fromEntries([...root.querySelectorAll('[data-name]')].map(element => [element.dataset.name, element]));
  }

  var stylesheet$v = ".claude-plus-find-bar {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  flex: none;\n  padding: 4px 6px;\n  background: var(--claude-plus-color-raised);\n  border: 1px solid var(--claude-plus-color-border);\n  border-radius: 6px;\n  font-size: 12px;\n}\n\n.claude-plus-find-bar[hidden] {\n  display: none;\n}\n\n.claude-plus-find-bar__input {\n  flex: 1;\n  min-width: 80px;\n  background: var(--claude-plus-color-background);\n  color: inherit;\n  border: 1px solid var(--claude-plus-color-border-strong);\n  border-radius: 4px;\n  padding: 3px 6px;\n  font: inherit;\n}\n\n.claude-plus-find-bar__input--invalid {\n  border-color: var(--claude-plus-color-error);\n}\n\n.claude-plus-find-bar__regex {\n  display: flex;\n  align-items: center;\n  gap: 3px;\n  white-space: nowrap;\n  cursor: pointer;\n}\n\n.claude-plus-find-bar__count {\n  min-width: 48px;\n  text-align: center;\n  color: var(--claude-plus-color-text-muted);\n  white-space: nowrap;\n}\n\n.claude-plus-find-bar__button {\n  background: var(--claude-plus-color-button);\n  border: none;\n  border-radius: 4px;\n  color: inherit;\n  cursor: pointer;\n  font: inherit;\n  line-height: 1;\n  padding: 4px 8px;\n}\n\n.claude-plus-find-bar__button:hover:not(:disabled) {\n  background: var(--claude-plus-color-button-hover);\n}\n\n.claude-plus-find-bar__button:disabled {\n  opacity: 0.4;\n  cursor: default;\n}\n\n::highlight(claude-plus-find) {\n  background-color: rgba(245, 197, 66, 0.45);\n  color: inherit;\n}\n\n::highlight(claude-plus-find-current) {\n  background-color: #ff9632;\n  color: #000;\n}\n";

  StyleRegistry.register(stylesheet$v);

  /**
   * The in-chat search bar at the bottom of a chat pane: a search field, a regular-expression
   * checkbox remembered per conversation, the current position among the matches, and buttons for the
   * previous, next, first and last match. It searches the messages' text, not the DOM, so it finds
   * matches in messages the windowed message list has not rendered.
   */
  class ChatFindBar {
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

  /**
   * localStorage keys.
   * @type {Readonly<Record<string, string>>}
   */
  const STORAGE_KEYS = Object.freeze({
    dockLayout: 'claudePlus.dockLayout',
    model: 'claudePlus.model',
    effort: 'claudePlus.effort',
    thinkingMode: 'claudePlus.thinkingMode',
    messageFontSize: 'claudePlus.messageFontSize',
    chatPanes: 'claudePlus.chatPanes',
    savedLayouts: 'claudePlus.savedLayouts',
    subPaneEdges: 'claudePlus.subPaneEdges',
    conversationSettings: 'claudePlus.conversationSettings',
    hotkeys: 'claudePlus.hotkeys',
    tablePrefix: 'claudePlus.table.',
    modelCatalog: 'claudePlus.modelCatalog',
    theme: 'claudePlus.theme',
  });

  /**
   * Settings remembered per conversation, such as whether its in-chat search reads a regular
   * expression, kept in one stored object keyed by conversation id.
   */
  class ConversationSettings {
    /**
     * Storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Creates the store.
     * @param {Preferences} preferences Storage.
     */
    constructor(preferences) {
      this.#preferences = preferences;
    }

    /**
     * A conversation's setting.
     * @param {?string} conversationId Conversation id; null for a chat that has not been saved yet.
     * @param {string} name Setting name.
     * @param {*} fallback Value when the conversation has none stored.
     * @returns {*} The stored value, or the fallback.
     */
    get(conversationId, name, fallback) {
      const stored = conversationId ? this.#preferences.readJson(STORAGE_KEYS.conversationSettings)?.[conversationId] : null;
      return stored && name in stored ? stored[name] : fallback;
    }

    /**
     * Remembers a conversation's setting; skipped for a chat that has not been saved yet.
     * @param {?string} conversationId Conversation id.
     * @param {string} name Setting name.
     * @param {*} value JSON-serializable value.
     * @returns {void}
     */
    set(conversationId, name, value) {
      if (!conversationId) return;
      const stored = this.#preferences.readJson(STORAGE_KEYS.conversationSettings) ?? {};
      stored[conversationId] = { ...stored[conversationId], [name]: value };
      this.#preferences.writeJson(STORAGE_KEYS.conversationSettings, stored);
    }
  }

  /**
   * Characters escaped for HTML output and their entities.
   * @type {Readonly<Record<string, string>>}
   */
  const HTML_ENTITIES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

  /**
   * Escapes a value for safe insertion into HTML text or attribute values.
   * @param {*} value Value to escape; null and undefined become an empty string.
   * @returns {string} The escaped string.
   */
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => HTML_ENTITIES[character]);
  }

  /**
   * The header shared by every dockable sub-pane: a title, dock-edge arrows and a close button.
   */
  class SubPaneHeader {
    /**
     * HTML of the header.
     * @param {string} title Header title.
     * @returns {string} The header element's HTML.
     */
    static html(title) {
      return `
      <header class="claude-plus-subpane__header">
        <span class="claude-plus-subpane__title">${escapeHtml(title)}</span>
        <button class="claude-plus-subpane__button" data-edge="left" title="Dock left">←</button>
        <button class="claude-plus-subpane__button" data-edge="top" title="Dock top">↑</button>
        <button class="claude-plus-subpane__button" data-edge="right" title="Dock right">→</button>
        <button class="claude-plus-subpane__button" data-action="close" title="Close">×</button>
      </header>`;
    }

    /**
     * Runs the clicked header button: a dock arrow or close.
     * @param {MouseEvent} event Click inside the header.
     * @param {function(): void} onClose Close callback.
     * @param {function(string): void} onMove Redock callback, called with 'left', 'top' or 'right'.
     * @returns {void}
     */
    static onClick(event, onClose, onMove) {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.edge) onMove(button.dataset.edge);
      else onClose();
    }
  }

  /**
   * Arithmetic mean of a list of numbers.
   * @param {number[]} values The numbers.
   * @returns {number} The mean, or 0 for an empty list.
   */
  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  /**
   * Creates an element and assigns properties to it.
   * @param {string} tagName Tag name.
   * @param {object} properties Element properties to set, e.g. className, textContent, innerHTML, title, hidden.
   * @returns {HTMLElement} The new element.
   */
  function createElement(tagName, properties) {
    return Object.assign(document.createElement(tagName), properties);
  }

  var stylesheet$u = ".claude-plus-empty-state {\r\n  color: var(--claude-plus-color-text-faint);\r\n  font-style: italic;\r\n  padding: 6px 0;\r\n}\r\n\r\n.claude-plus-empty-state--padded {\r\n  padding: 24px;\r\n}\r\n";

  StyleRegistry.register(stylesheet$u);

  /**
   * HTML for an empty-state message.
   * @param {string} message The message.
   * @returns {string} A div with the message.
   */
  function emptyStateHtml(message) {
    return `<div class="claude-plus-empty-state">${escapeHtml(message)}</div>`;
  }

  /**
   * Entries of a count map, highest count first.
   * @param {Object<string, number>} counts The count map.
   * @returns {Array<[string, number]>} [key, count] pairs sorted by descending count.
   */
  function entriesByDescendingCount(counts) {
    return Object.entries(counts).sort((first, second) => second[1] - first[1]);
  }

  /**
   * Formats a duration compactly, e.g. "2h 5m", "3m 12s" or "40s".
   * @param {number} durationMs Duration in milliseconds; negative values count as zero.
   * @returns {string} The formatted duration.
   */
  function formatDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  var stylesheet$t = ".claude-plus-value-row {\r\n  display: flex;\r\n  justify-content: space-between;\r\n  padding: 2px 0;\r\n  gap: 8px;\r\n}\r\n\r\n.claude-plus-value-row span {\r\n  color: var(--claude-plus-color-text-muted);\r\n}\r\n";

  StyleRegistry.register(stylesheet$t);

  /**
   * HTML for a label/value row.
   * @param {string} label Row label.
   * @param {string|number} value Row value.
   * @returns {string} The row.
   */
  function valueRowHtml(label, value) {
    return `<div class="claude-plus-value-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
  }

  var stylesheet$s = ".claude-plus-conversation-stats {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 2px;\n}\n";

  StyleRegistry.register(stylesheet$s);

  /**
   * A sub-pane showing usage stats scoped to just the pane's own conversation (turns, average
   * response time, estimated tokens, tool calls), rather than the totals across every chat that the
   * global Stats panel shows. It can be docked to the pane's left, top or right edge and closed.
   */
  class ConversationStatsSubPane {
    /**
     * Session whose conversation is shown.
     * @type {ChatSession}
     */
    #session;

    /**
     * Conversation statistics.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * The sub-pane's root element.
     * @type {HTMLElement}
     */
    #element;

    /**
     * Undoes the subscriptions.
     * @type {Array<function(): void>}
     */
    #unsubscribers = [];

    /**
     * Builds the sub-pane.
     * @param {object} options Sub-pane options.
     * @param {ChatSession} options.session Session whose conversation is shown.
     * @param {StatsIndex} options.stats Conversation statistics.
     * @param {function(): void} options.onClose Called when × is clicked.
     * @param {function(string): void} options.onMove Called with 'left', 'top' or 'right' when an arrow is clicked.
     */
    constructor({ session, stats, onClose, onMove }) {
      this.#session = session;
      this.#stats = stats;
      this.#element = createElement('section', { className: 'claude-plus-subpane' });
      this.#element.addEventListener('click', event => this.#onClick(event, onClose, onMove));
      this.#unsubscribers.push(stats.subscribe('aggregate', () => this.render()), session.subscribe('openConversation', () => this.render()));
      this.render();
    }

    /**
     * The sub-pane's root element.
     * @returns {HTMLElement} The element.
     */
    get element() {
      return this.#element;
    }

    /**
     * Shows the open conversation's own stats, if it has any indexed yet.
     * @returns {Promise<void>} Resolves once rendered.
     */
    async render() {
      const conversationId = this.#session.openConversationId;
      this.#renderHeaderAndBody(conversationId ? null : emptyStateHtml('Start or open a chat to see its stats.'));
      if (!conversationId) return;
      const summary = await this.#stats.summaryFor(conversationId);
      if (this.#session.openConversationId !== conversationId) return;
      this.#renderHeaderAndBody(summary ? ConversationStatsSubPane.#summaryHtml(summary) : emptyStateHtml('Not indexed yet — send a message or wait a moment.'));
    }

    /**
     * Removes the sub-pane.
     * @returns {void}
     */
    dispose() {
      this.#unsubscribers.forEach(unsubscribe => unsubscribe());
      this.#element.remove();
    }

    /**
     * Runs a header click; other clicks are ignored.
     * @param {MouseEvent} event Click inside the sub-pane.
     * @param {function(): void} onClose Close callback.
     * @param {function(string): void} onMove Redock callback.
     * @returns {void}
     */
    #onClick(event, onClose, onMove) {
      if (event.target.closest('header')) SubPaneHeader.onClick(event, onClose, onMove);
    }

    /**
     * Replaces the sub-pane's content with the header and a body.
     * @param {string} bodyHtml The body's HTML.
     * @returns {void}
     */
    #renderHeaderAndBody(bodyHtml) {
      this.#element.innerHTML = `${SubPaneHeader.html('📈 Stats for this chat')}<div class="claude-plus-scrollable claude-plus-fill-remaining claude-plus-conversation-stats">${bodyHtml}</div>`;
    }

    /**
     * HTML of a conversation's stats: turns, response time, estimated tokens and a tool call ranking.
     * @param {ConversationSummary} summary The conversation's summary.
     * @returns {string} The HTML.
     */
    static #summaryHtml(summary) {
      const responseTimes = summary.responseTimesMs;
      const toolRanking = entriesByDescendingCount(summary.toolCallCounts);
      const rankingHtml = toolRanking.map(([toolName, count]) => valueRowHtml(toolName, count)).join('') || emptyStateHtml('No tool calls in this chat yet.');
      return `
      <div class="claude-plus-panel__section">${valueRowHtml('Turns', summary.promptCount)}${valueRowHtml('Avg response time', responseTimes.length ? formatDuration(average(responseTimes)) : '–')}</div>
      <div class="claude-plus-panel__section">${valueRowHtml('Est. tokens in / out', `~${summary.estimatedTokensIn.toLocaleString()} in / ~${summary.estimatedTokensOut.toLocaleString()} out`)}</div>
      <details class="claude-plus-panel__section" open><summary>Tool calls (${toolRanking.reduce((sum, [, count]) => sum + count, 0)})</summary>${rankingHtml}</details>`;
    }
  }

  /**
   * Which columns of a table are shown. Always-visible columns can never be hidden.
   */
  class ColumnVisibility {
    /**
     * All columns, in display order.
     * @type {TableColumn[]}
     */
    #columns;

    /**
     * Ids of the visible columns.
     * @type {Set<string>}
     */
    #visibleColumnIds;

    /**
     * Restores the visible columns from stored ids, or uses the columns visible by default.
     * @param {TableColumn[]} columns All columns, in display order.
     * @param {*} storedIds Stored ids of the visible columns; ignored unless an array.
     */
    constructor(columns, storedIds) {
      this.#columns = columns;
      const columnIds = columns.map(column => column.id);
      const knownStoredIds = Array.isArray(storedIds) ? storedIds.filter(columnId => columnIds.includes(columnId)) : null;
      this.#visibleColumnIds = new Set(knownStoredIds ?? columns.filter(column => column.isVisibleByDefault).map(column => column.id));
      columns.filter(column => column.isAlwaysVisible).forEach(column => this.#visibleColumnIds.add(column.id));
    }

    /**
     * Columns currently shown.
     * @returns {TableColumn[]} The visible columns, in display order.
     */
    get visibleColumns() {
      return this.#columns.filter(column => this.#visibleColumnIds.has(column.id));
    }

    /**
     * Ids of the visible columns, in a storable form.
     * @returns {string[]} The ids.
     */
    get visibleColumnIds() {
      return [...this.#visibleColumnIds];
    }

    /**
     * Whether a column is shown.
     * @param {string} columnId Column id.
     * @returns {boolean} True when shown.
     */
    isVisible(columnId) {
      return this.#visibleColumnIds.has(columnId);
    }

    /**
     * Shows or hides a column.
     * @param {string} columnId Column id.
     * @param {boolean} isVisible Whether it should be shown.
     * @returns {void}
     */
    setVisible(columnId, isVisible) {
      if (isVisible) this.#visibleColumnIds.add(columnId);
      else this.#visibleColumnIds.delete(columnId);
    }
  }

  /**
   * Manually resized widths of a table's columns, in pixels. A column the user hasn't dragged keeps
   * its normal (auto-sized or flexible) width.
   */
  class ColumnWidths {
    /**
     * Widths in pixels, by column id; only columns the user has resized appear here.
     * @type {Object<string, number>}
     */
    #widths;

    /**
     * Restores stored widths.
     * @param {*} stored Stored widths; ignored unless a plain object.
     */
    constructor(stored) {
      this.#widths = stored && typeof stored === 'object' ? { ...stored } : {};
    }

    /**
     * A column's resized width, if it has been resized.
     * @param {string} columnId Column id.
     * @returns {?number} The width in pixels, or null when not resized.
     */
    widthOf(columnId) {
      return this.#widths[columnId] ?? null;
    }

    /**
     * Sets a column's resized width.
     * @param {string} columnId Column id.
     * @param {number} width Width in pixels.
     * @returns {void}
     */
    setWidth(columnId, width) {
      this.#widths[columnId] = width;
    }

    /**
     * Clears a column's resized width, restoring its normal width.
     * @param {string} columnId Column id.
     * @returns {void}
     */
    reset(columnId) {
      delete this.#widths[columnId];
    }

    /**
     * The widths, in a storable form.
     * @returns {Object<string, number>} The widths by column id.
     */
    get stored() {
      return { ...this.#widths };
    }
  }

  /**
   * Parses a date string into epoch milliseconds.
   * @param {?string} isoDate ISO date string.
   * @returns {number} Epoch milliseconds, or 0 when missing or invalid.
   */
  function toEpochMs(isoDate) {
    return Date.parse(isoDate) || 0;
  }

  /**
   * Calendar day of a timestamp in local time.
   * @param {?string} isoDate ISO timestamp.
   * @returns {string} The day as YYYY-MM-DD, or an empty string when missing or invalid.
   */
  function localDateKey(isoDate) {
    const epochMs = toEpochMs(isoDate);
    if (!epochMs) return '';
    const date = new Date(epochMs);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  /**
   * An inclusive range of calendar days in local time; either end may be open.
   */
  class DateRange {
    /**
     * First day, as YYYY-MM-DD, or an empty string for no lower bound.
     * @type {string}
     */
    #firstDay;

    /**
     * Last day, as YYYY-MM-DD, or an empty string for no upper bound.
     * @type {string}
     */
    #lastDay;

    /**
     * Creates the range.
     * @param {?string} firstDay First day as YYYY-MM-DD; empty or missing for no lower bound.
     * @param {?string} lastDay Last day as YYYY-MM-DD; empty or missing for no upper bound.
     */
    constructor(firstDay, lastDay) {
      this.#firstDay = firstDay || '';
      this.#lastDay = lastDay || '';
    }

    /**
     * Whether a timestamp falls on a day inside the range. With both ends open everything matches;
     * otherwise missing or invalid timestamps never match.
     * @param {?string} isoDate ISO timestamp.
     * @returns {boolean} True when inside the range.
     */
    contains(isoDate) {
      if (!this.#firstDay && !this.#lastDay) return true;
      const day = localDateKey(isoDate);
      return day !== '' && this.#isNotBeforeFirstDay(day) && this.#isNotAfterLastDay(day);
    }

    /**
     * Whether a day is on or after the first day.
     * @param {string} day Day as YYYY-MM-DD.
     * @returns {boolean} True when there is no lower bound or the day isn't before it.
     */
    #isNotBeforeFirstDay(day) {
      return !this.#firstDay || day >= this.#firstDay;
    }

    /**
     * Whether a day is on or before the last day.
     * @param {string} day Day as YYYY-MM-DD.
     * @returns {boolean} True when there is no upper bound or the day isn't after it.
     */
    #isNotAfterLastDay(day) {
      return !this.#lastDay || day <= this.#lastDay;
    }
  }

  /**
   * Case-insensitive text matching with `*` wildcards. A pattern without a wildcard matches any text
   * containing it; a pattern with wildcards must match the whole text, each `*` standing for any
   * characters (so `*nbc*` matches both "NBC" and "MSNBC").
   */
  class WildcardPattern {
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

  /**
   * Value a column's filter tests for a row.
   * @param {TableColumn} column The column.
   * @param {object} row The row.
   * @returns {*} The filter value, or the sort value when the column has no separate filter value.
   */
  function columnFilterValue(column, row) {
    return column.filterValue ? column.filterValue(row) : column.sortValue(row);
  }

  /**
   * The values entered into a table's filter inputs and the rows passing them: a wildcard pattern
   * for value filters, a from/to range for date filters.
   */
  class RowFilterSet {
    /**
     * All columns.
     * @type {TableColumn[]}
     */
    #columns;

    /**
     * Entered values per column id, keyed by bound ('text', 'from' or 'to').
     * @type {Map<string, Object<string, string>>}
     */
    #valuesByColumn = new Map();

    /**
     * Creates an empty filter set.
     * @param {TableColumn[]} columns All columns.
     */
    constructor(columns) {
      this.#columns = columns;
    }

    /**
     * Records the value of one filter input.
     * @param {string} columnId Column id.
     * @param {string} bound 'text', 'from' or 'to'.
     * @param {string} value Entered value.
     * @returns {void}
     */
    record(columnId, bound, value) {
      const values = this.#valuesByColumn.get(columnId) ?? {};
      values[bound] = value;
      this.#valuesByColumn.set(columnId, values);
    }

    /**
     * The recorded value of one filter input.
     * @param {string} columnId Column id.
     * @param {string} bound 'text', 'from' or 'to'.
     * @returns {string} The value, or empty when none was entered.
     */
    valueOf(columnId, bound) {
      return this.#valuesByColumn.get(columnId)?.[bound] ?? '';
    }

    /**
     * Drops a column's filter.
     * @param {string} columnId Column id.
     * @returns {void}
     */
    drop(columnId) {
      this.#valuesByColumn.delete(columnId);
    }

    /**
     * Rows passing every filter of a visible column.
     * @param {object[]} rows Rows to filter.
     * @param {ColumnVisibility} visibility Which columns are shown; filters of hidden columns are ignored.
     * @returns {object[]} The passing rows.
     */
    apply(rows, visibility) {
      const rowTests = [...this.#valuesByColumn]
        .filter(([columnId]) => visibility.isVisible(columnId))
        .map(([columnId, values]) => this.#createRowTest(columnId, values));
      return rows.filter(row => rowTests.every(passes => passes(row)));
    }

    /**
     * Creates the test for one column's filter.
     * @param {string} columnId Column id.
     * @param {Object<string, string>} values Filter input values by bound.
     * @returns {function(object): boolean} Returns whether a row passes.
     */
    #createRowTest(columnId, values) {
      const column = this.#columns.find(candidate => candidate.id === columnId);
      if (column.filter === 'date') {
        const range = new DateRange(values.from, values.to);
        return row => range.contains(columnFilterValue(column, row));
      }
      const pattern = new WildcardPattern(values.text ?? '');
      return row => pattern.matches(columnFilterValue(column, row));
    }
  }

  /**
   * Orders two sortable values ascending.
   * @param {string|number} first First value.
   * @param {string|number} second Second value.
   * @returns {number} Negative if the first sorts first, positive if the second does, 0 if equal.
   */
  function compareAscending(first, second) {
    if (first === second) return 0;
    return first < second ? -1 : 1;
  }

  /**
   * The column a table is sorted by and the direction. Sorting by the current column again reverses
   * the direction; another column starts ascending.
   */
  class SortOrder {
    /**
     * All columns.
     * @type {TableColumn[]}
     */
    #columns;

    /**
     * Id of the sort column.
     * @type {string}
     */
    #columnId;

    /**
     * 1 ascending, -1 descending.
     * @type {number}
     */
    #direction;

    /**
     * Restores the order from stored settings, or uses the default one.
     * @param {TableColumn[]} columns All columns.
     * @param {*} stored Stored sort order; ignored unless it names a known column.
     * @param {{column: string, direction: number}} defaultSort Sort used until the user sorts.
     */
    constructor(columns, stored, defaultSort) {
      this.#columns = columns;
      const isValid = Boolean(stored) && columns.some(column => column.id === stored.column);
      this.#columnId = isValid ? stored.column : defaultSort.column;
      this.#direction = SortOrder.#validDirection(isValid ? stored.direction : defaultSort.direction);
    }

    /**
     * A direction limited to the two valid values.
     * @param {*} direction Direction to check.
     * @returns {number} 1 for 1, otherwise -1.
     */
    static #validDirection(direction) {
      return direction === 1 ? 1 : -1;
    }

    /**
     * Sorts by a column; the current column reverses direction, another one starts ascending.
     * @param {string} columnId Column id.
     * @returns {void}
     */
    sortBy(columnId) {
      this.#direction = this.#columnId === columnId ? -this.#direction : 1;
      this.#columnId = columnId;
    }

    /**
     * Arrow shown after a column's header label.
     * @param {string} columnId Column id.
     * @returns {string} " ▲" or " ▼" for the sort column, otherwise empty.
     */
    indicatorFor(columnId) {
      if (this.#columnId !== columnId) return '';
      return this.#direction === 1 ? ' ▲' : ' ▼';
    }

    /**
     * Rows in this order.
     * @param {object[]} rows Rows to sort.
     * @returns {object[]} A sorted copy.
     */
    sort(rows) {
      const column = this.#columns.find(candidate => candidate.id === this.#columnId) ?? this.#columns[0];
      return [...rows].sort((first, second) => compareAscending(column.sortValue(first), column.sortValue(second)) * this.#direction);
    }

    /**
     * Serializable form.
     * @returns {{column: string, direction: number}} The sort column and direction.
     */
    toJSON() {
      return { column: this.#columnId, direction: this.#direction };
    }
  }

  /**
   * Result limits. sidebarPageSize / backfillPageSize: conversations requested per API page.
   * rankedOutlets: outlets in the ranking.
   * toolResultCharacters: characters of a tool result shown. provisionalTitleLength: characters of
   * the first prompt used as a new conversation's title. backfillRefreshInterval: conversations
   * stored between aggregate refreshes during a backfill. followOutputDistance: distance from the
   * bottom, in pixels, within which the chat keeps following new output. exportFileNameLength:
   * characters of the conversation title used in an export file name. comboboxEntries: values listed
   * by a filter typeahead.
   * @type {Readonly<Record<string, number>>}
   */
  const LIMITS = Object.freeze({
    sidebarPageSize: 100,
    backfillPageSize: 100,
    listedSources: 500,
    rankedOutlets: 30,
    toolResultCharacters: 4000,
    provisionalTitleLength: 60,
    backfillRefreshInterval: 10,
    followOutputDistance: 40,
    exportFileNameLength: 80,
    comboboxEntries: 200,
    searchResults: 300,
  });

  var stylesheet$r = ".claude-plus-value-combobox {\r\n  position: fixed;\r\n  z-index: var(--claude-plus-layer-popup-menu);\r\n  max-height: 240px;\r\n  overflow-y: auto;\r\n  background: var(--claude-plus-color-raised);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  padding: 4px;\r\n  font-size: 12px;\r\n}\r\n\r\n.claude-plus-value-combobox__entry {\r\n  padding: 4px 8px;\r\n  border-radius: 4px;\r\n  cursor: pointer;\r\n  white-space: nowrap;\r\n}\r\n\r\n.claude-plus-value-combobox__entry:hover {\r\n  background: var(--claude-plus-color-raised-hover);\r\n}\r\n";

  StyleRegistry.register(stylesheet$r);

  /**
   * A text input that shows the distinct values it can filter by in a list below it while focused.
   * Typing narrows the list live with the same wildcard matching the filter uses; choosing an entry
   * copies it into the input.
   */
  class ValueCombobox {
    /**
     * The input being enhanced.
     * @type {HTMLInputElement}
     */
    #input;

    /**
     * Returns the values to offer.
     * @type {function(): string[]}
     */
    #listValues;

    /**
     * The open list, or null while closed.
     * @type {?HTMLElement}
     */
    #listElement = null;

    /**
     * Enhances an input.
     * @param {HTMLInputElement} input The input.
     * @param {function(): string[]} listValues Returns the values to offer, already distinct and sorted.
     */
    constructor(input, listValues) {
      this.#input = input;
      this.#listValues = listValues;
      input.addEventListener('focus', this.#showList);
      input.addEventListener('input', this.#showList);
      input.addEventListener('blur', this.#hideList);
      input.addEventListener('keydown', this.#onKeydown);
    }

    /**
     * Closes the list.
     * @returns {void}
     */
    dispose() {
      this.#hideList();
    }

    /**
     * Opens or refreshes the list with the values matching the input.
     * @returns {void}
     */
    #showList = () => {
      const pattern = new WildcardPattern(this.#input.value);
      const values = this.#listValues().filter(value => pattern.matches(value)).slice(0, LIMITS.comboboxEntries);
      this.#ensureListElement();
      this.#listElement.innerHTML = values.map(value => `<div class="claude-plus-value-combobox__entry" data-value="${escapeHtml(value)}">${escapeHtml(value)}</div>`).join('')
        || emptyStateHtml('No matching values.');
      this.#positionList();
    };

    /**
     * Closes the list if open.
     * @returns {void}
     */
    #hideList = () => {
      if (!this.#listElement) return;
      this.#listElement.remove();
      this.#listElement = null;
    };

    /**
     * Closes the list on Escape.
     * @param {KeyboardEvent} event Key press in the input.
     * @returns {void}
     */
    #onKeydown = (event) => {
      if (event.key === 'Escape') this.#hideList();
    };

    /**
     * Copies the pressed entry into the input and announces the change; keeps focus in the input.
     * @param {MouseEvent} event Mouse press inside the list.
     * @returns {void}
     */
    #onListPress = (event) => {
      event.preventDefault();
      const entry = event.target.closest('[data-value]');
      if (!entry) return;
      this.#input.value = entry.dataset.value;
      this.#input.dispatchEvent(new Event('input', { bubbles: true }));
      this.#hideList();
    };

    /**
     * Creates the list element on first use.
     * @returns {void}
     */
    #ensureListElement() {
      if (this.#listElement) return;
      this.#listElement = createElement('div', { className: 'claude-plus-themed claude-plus-value-combobox' });
      this.#listElement.addEventListener('mousedown', this.#onListPress);
      document.body.append(this.#listElement);
    }

    /**
     * Places the list directly below the input.
     * @returns {void}
     */
    #positionList() {
      const bounds = this.#input.getBoundingClientRect();
      Object.assign(this.#listElement.style, { left: `${bounds.left}px`, top: `${bounds.bottom + 2}px`, minWidth: `${bounds.width}px` });
    }
  }

  /**
   * Coalesces repeated requests into one callback per animation frame.
   */
  class FrameScheduler {
    /**
     * Work to run.
     * @type {function(): void}
     */
    #callback;

    /**
     * Pending animation frame id, or 0 when none is pending.
     * @type {number}
     */
    #pendingFrameId = 0;

    /**
     * Creates a scheduler for a callback.
     * @param {function(): void} callback Work to run at most once per frame.
     */
    constructor(callback) {
      this.#callback = callback;
    }

    /**
     * Runs the callback on the next animation frame unless already scheduled.
     * @returns {void}
     */
    schedule() {
      if (this.#pendingFrameId) return;
      this.#pendingFrameId = requestAnimationFrame(() => {
        this.#pendingFrameId = 0;
        this.#callback();
      });
    }

    /**
     * Cancels a pending run.
     * @returns {void}
     */
    cancel() {
      cancelAnimationFrame(this.#pendingFrameId);
      this.#pendingFrameId = 0;
    }
  }

  /**
   * The heights of a long list's items: measured for the ones that have been rendered, estimated
   * (from the average of what has been measured) for the rest. Gives the offsets and spacer sizes a
   * windowed list needs without ever rendering the items in between.
   */
  class ItemHeights {
    /**
     * Fraction of the measured heights dropped from each end before averaging.
     * @type {number}
     */
    static #TRIM_FRACTION = 0.1;

    /**
     * How much the number of measurements must grow, as a factor, before the estimate is recomputed.
     * @type {number}
     */
    static #REFRESH_GROWTH = 1.25;

    /**
     * Measurements added on top of that growth before the estimate is recomputed.
     * @type {number}
     */
    static #REFRESH_SLACK = 4;

    /**
     * Gap after every item, in pixels; counted between items but not after the last one.
     * @type {number}
     */
    #gap;

    /**
     * Height used for an item until any has been measured.
     * @type {number}
     */
    #initialEstimate;

    /**
     * Measured heights by item index; unmeasured items are absent.
     * @type {Array<number|undefined>}
     */
    #measured = [];

    /**
     * Number of measured items.
     * @type {number}
     */
    #measuredCount = 0;

    /**
     * Number of items in the list.
     * @type {number}
     */
    #count = 0;

    /**
     * The current estimate for unmeasured items, kept until enough new measurements have arrived to
     * be worth recomputing it: an estimate that moved with every render would move the whole
     * unrendered part of the list under the view with it.
     * @type {?number}
     */
    #estimateCache = null;

    /**
     * Number of measurements the cached estimate was computed from.
     * @type {number}
     */
    #estimateBasis = 0;

    /**
     * Creates an empty model.
     * @param {number} gap Gap after every item, in pixels.
     * @param {number} initialEstimate Height assumed for items until some have been measured.
     */
    constructor(gap, initialEstimate) {
      this.#gap = gap;
      this.#initialEstimate = initialEstimate;
    }

    /**
     * Number of items in the list.
     * @returns {number} The count.
     */
    get count() {
      return this.#count;
    }

    /**
     * Sets the number of items, forgetting measurements of items beyond it.
     * @param {number} count New item count.
     * @returns {void}
     */
    setCount(count) {
      for (let index = count; index < this.#measured.length; index += 1) this.#forget(index);
      this.#measured.length = Math.min(this.#measured.length, count);
      this.#count = count;
    }

    /**
     * Forgets every measurement, keeping the current average as the estimate for all items.
     * @returns {void}
     */
    clear() {
      this.#initialEstimate = this.#estimate();
      this.#measured = [];
      this.#measuredCount = 0;
      this.#estimateCache = null;
      this.#estimateBasis = 0;
    }

    /**
     * Records an item's measured height.
     * @param {number} index Item index.
     * @param {number} height Measured height in pixels.
     * @returns {boolean} True when it differs from what was known before.
     */
    record(index, height) {
      const previous = this.#measured[index];
      if (previous === height) return false;
      this.#forget(index);
      this.#measured[index] = height;
      this.#measuredCount += 1;
      return true;
    }

    /**
     * An item's height, measured if known, else estimated.
     * @param {number} index Item index.
     * @returns {number} The height in pixels.
     */
    heightOf(index) {
      return this.#measured[index] ?? this.#estimate();
    }

    /**
     * Distance from the top of the list to the top of an item.
     * @param {number} index Item index.
     * @returns {number} The offset in pixels.
     */
    offsetOf(index) {
      return this.#slotsBetween(0, index);
    }

    /**
     * The index of the item covering an offset.
     * @param {number} offset Distance from the top of the list, in pixels.
     * @returns {number} The item's index, clamped to the list; 0 for an empty list.
     */
    indexAt(offset) {
      const estimate = this.#estimate();
      let covered = 0;
      for (let index = 0; index < this.#count; index += 1) {
        covered += (this.#measured[index] ?? estimate) + this.#gap;
        if (covered > offset) return index;
      }
      return Math.max(0, this.#count - 1);
    }

    /**
     * The size of the empty space standing in for a run of unrendered items: their heights and the
     * gaps between them, less the one gap the neighbouring rendered item's own margin supplies.
     * @param {number} from First item index of the run.
     * @param {number} until Index after the run's last item.
     * @returns {number} The space in pixels; 0 for an empty run.
     */
    spanBetween(from, until) {
      return from < until ? this.#slotsBetween(from, until) - this.#gap : 0;
    }

    /**
     * Total height of every item and the gaps between them.
     * @returns {number} The height in pixels.
     */
    get totalHeight() {
      return this.#count > 0 ? this.#slotsBetween(0, this.#count) - this.#gap : 0;
    }

    /**
     * Height of every item in a range, each with its trailing gap.
     * @param {number} from First item index.
     * @param {number} until Index after the last item.
     * @returns {number} The sum in pixels.
     */
    #slotsBetween(from, until) {
      const estimate = this.#estimate();
      let sum = 0;
      for (let index = from; index < until; index += 1) sum += (this.#measured[index] ?? estimate) + this.#gap;
      return sum;
    }

    /**
     * The height assumed for an unmeasured item.
     * @returns {number} The trimmed average of the measured heights, refreshed only once the number
     * of measurements has grown by a quarter; the initial estimate before any measurement.
     */
    #estimate() {
      if (this.#measuredCount === 0) return this.#initialEstimate;
      if (this.#estimateCache === null || this.#measuredCount > this.#estimateBasis * ItemHeights.#REFRESH_GROWTH + ItemHeights.#REFRESH_SLACK) {
        this.#estimateCache = this.#trimmedAverage();
        this.#estimateBasis = this.#measuredCount;
      }
      return this.#estimateCache;
    }

    /**
     * The average of the measured heights without the tallest and shortest tenth, so a few enormous
     * (or empty) items don't drag the estimate for all the others.
     * @returns {number} The average in pixels.
     */
    #trimmedAverage() {
      const heights = this.#measured.filter(height => height !== undefined).sort((first, second) => first - second);
      const trim = Math.floor(heights.length * ItemHeights.#TRIM_FRACTION);
      const kept = heights.slice(trim, heights.length - trim);
      return kept.reduce((sum, height) => sum + height, 0) / kept.length;
    }

    /**
     * Drops one item's measurement from the running totals.
     * @param {number} index Item index.
     * @returns {void}
     */
    #forget(index) {
      const previous = this.#measured[index];
      if (previous === undefined) return;
      this.#measuredCount -= 1;
      this.#measured[index] = undefined;
    }
  }

  var stylesheet$q = ".claude-plus-virtual-spacer {\n  flex: none;\n}\n\ntr.claude-plus-virtual-spacer td {\n  padding: 0;\n  border: 0;\n}\n";

  StyleRegistry.register(stylesheet$q);

  /**
   * Windowed rendering for a long list: only the items near the visible area exist in the DOM, with
   * two empty spacers standing in for everything above and below, so a list of tens of thousands of
   * items costs as much as one screenful. Items entering the window are created and items leaving it
   * are removed one by one; the ones staying are never touched, so widgets, focus and hover state
   * survive scrolling. Item heights are measured as items are rendered (and re-measured when they
   * resize, e.g. an image loading) and estimated for the rest; the item at the top of the view is
   * kept steady while those numbers change.
   */
  class VirtualList {
    /**
     * Most times the window is re-rendered in one update while measured heights shift the estimates.
     * @type {number}
     */
    static #MAX_FILL_PASSES = 6;

    /**
     * Times an item scrolled to is aligned, since rendering and measuring the items around it can
     * move it a little each time.
     * @type {number}
     */
    static #ALIGN_PASSES = 3;

    /**
     * Options given to the constructor, with defaults filled in.
     * @type {object}
     */
    #options;

    /**
     * Element that scrolls.
     * @type {HTMLElement}
     */
    #scrollElement;

    /**
     * Element holding the spacers and the rendered items; the scroll element itself or a descendant.
     * @type {HTMLElement}
     */
    #contentElement;

    /**
     * Item heights, measured and estimated.
     * @type {ItemHeights}
     */
    #heights;

    /**
     * Elements of the rendered items, in order.
     * @type {HTMLElement[]}
     */
    #items = [];

    /**
     * Index of the first rendered item.
     * @type {number}
     */
    #start = 0;

    /**
     * Index after the last rendered item.
     * @type {number}
     */
    #end = 0;

    /**
     * Spacer standing in for the items above the window; null while nothing is rendered.
     * @type {?HTMLElement}
     */
    #topSpacer = null;

    /**
     * Spacer standing in for the items below the window; null while nothing is rendered.
     * @type {?HTMLElement}
     */
    #bottomSpacer = null;

    /**
     * Index of each rendered item's element.
     * @type {WeakMap<HTMLElement, number>}
     */
    #indexByElement = new WeakMap();

    /**
     * Whether the view was at the end of the list when it last scrolled.
     * @type {boolean}
     */
    #isAtEnd = true;

    /**
     * The item at the top of the view and where it was, kept in place while heights change.
     * @type {?{element: HTMLElement, top: number}}
     */
    #anchor = null;

    /**
     * Width of the scroll element when last laid out.
     * @type {number}
     */
    #width;

    /**
     * Timer waiting for the scroll element's width to stop changing, or null while none is.
     * @type {?number}
     */
    #resizeTimer = null;

    /**
     * Runs the window update once per frame while scrolling.
     * @type {FrameScheduler}
     */
    #frame = new FrameScheduler(() => this.#onFrame());

    /**
     * Watches the scroll element and the rendered items for size changes.
     * @type {ResizeObserver}
     */
    #observer = new ResizeObserver(entries => this.#onResize(entries));

    /**
     * Creates the list and starts following its scrolling and size.
     * @param {object} options List options.
     * @param {HTMLElement} options.scrollElement Element that scrolls.
     * @param {HTMLElement} options.contentElement Element the spacers and items are rendered into.
     * @param {number} options.gap Gap between items, in pixels (0 for none).
     * @param {number} options.estimatedHeight Height assumed for items until some are measured.
     * @param {function(number, number): string} options.renderItems HTML of the items from an index up to another, each exactly one root element.
     * @param {function(): string} options.emptyHtml HTML shown while the list has no items.
     * @param {function(): HTMLElement} [options.createSpacer] Creates a spacer element; a div by default.
     * @param {function(HTMLElement, number): void} [options.setSpacerHeight] Sizes a spacer, hiding it when 0.
     * @param {function(HTMLElement[], number): void} [options.onItemsRendered] Called with newly created item elements and the index of the first.
     * @param {function(): void} [options.onWidthChange] Called instead of a plain refresh when the scroll element's width changed.
     * @param {boolean} [options.followsEnd] Whether the view stays at the end while it was there and content grows.
     * @param {number} [options.endDistance] Distance from the end, in pixels, still counting as "at the end".
     */
    constructor(options) {
      this.#options = { createSpacer: VirtualList.#createDivSpacer, setSpacerHeight: VirtualList.#setDivSpacerHeight, followsEnd: false, endDistance: 40, ...options };
      this.#scrollElement = options.scrollElement;
      this.#contentElement = options.contentElement;
      this.#heights = new ItemHeights(options.gap, options.estimatedHeight);
      this.#width = this.#scrollElement.clientWidth;
      this.#scrollElement.style.overflowAnchor = 'none';
      this.#scrollElement.addEventListener('scroll', this.#onScroll);
      this.#observer.observe(this.#scrollElement);
    }

    /**
     * Number of items in the list.
     * @returns {number} The count.
     */
    get count() {
      return this.#heights.count;
    }

    /**
     * Sets the number of items and re-renders the window.
     * @param {number} count New item count.
     * @returns {void}
     */
    setCount(count) {
      this.#heights.setCount(count);
      this.refresh();
    }

    /**
     * Re-renders every item of the window from scratch, e.g. after the items' content changed; a
     * list that follows its end stays at the end if it was there.
     * @returns {void}
     */
    refresh() {
      this.#detachItems();
      this.#update(true);
      if (this.#options.followsEnd && this.#isAtEnd) this.scrollToEnd();
    }

    /**
     * Forgets every measured height and starts following the end again; for a different list.
     * @returns {void}
     */
    reset() {
      this.#heights.clear();
      this.#isAtEnd = true;
    }

    /**
     * The element of a rendered item.
     * @param {number} index Item index.
     * @returns {?HTMLElement} The element, or null while that item isn't in the window.
     */
    elementAt(index) {
      return index >= this.#start && index < this.#end ? this.#items[index - this.#start] : null;
    }

    /**
     * Scrolls an item into view. The window is rendered around the item itself, then the scroll
     * position is set from where the rendered item actually is - not from the estimated heights of
     * everything above it, which are far off in a long list and put the view on the wrong items.
     * @param {number} index Item index.
     * @param {'start'|'center'} block Where in the view to put it.
     * @returns {void}
     */
    scrollToIndex(index, block) {
      if (!this.#canRender() || index < 0 || index >= this.#heights.count) return;
      this.#renderAround(index);
      for (let pass = 0; pass < VirtualList.#ALIGN_PASSES; pass += 1) this.#alignRendered(index, block);
    }

    /**
     * Replaces the window with the items around one: those a view's height above and below it.
     * @param {number} index Item index.
     * @returns {void}
     */
    #renderAround(index) {
      const height = this.#scrollElement.clientHeight;
      const top = this.#heights.offsetOf(index);
      const start = this.#heights.indexAt(Math.max(0, top - height));
      const end = Math.min(this.#heights.count, this.#heights.indexAt(top + this.#heights.heightOf(index) + height) + 1);
      this.#replaceWith(start, end);
    }

    /**
     * Scrolls to the end of the list; a few passes, since the estimated heights above settle into
     * measured ones as the items near the end are rendered.
     * @returns {void}
     */
    scrollToEnd() {
      for (let pass = 0; pass < 3; pass += 1) {
        this.#scrollElement.scrollTop = this.#scrollElement.scrollHeight;
        this.#update(false);
      }
      this.#isAtEnd = true;
      this.#anchor = this.#captureAnchor();
    }

    /**
     * Keeps the end in view after content grew, if the view was following the end.
     * @returns {void}
     */
    keepEndInView() {
      if (this.#options.followsEnd && this.#isAtEnd) this.#scrollElement.scrollTop = this.#scrollElement.scrollHeight;
    }

    /**
     * Stops watching the scroll element and its items.
     * @returns {void}
     */
    dispose() {
      this.#cancelWidthSettle();
      this.#frame.cancel();
      this.#observer.disconnect();
      this.#scrollElement.removeEventListener('scroll', this.#onScroll);
    }

    /**
     * A spacer that is a plain block.
     * @returns {HTMLElement} The spacer.
     */
    static #createDivSpacer() {
      return createElement('div', { className: 'claude-plus-virtual-spacer' });
    }

    /**
     * Sizes a plain spacer, hiding it while it has no size.
     * @param {HTMLElement} spacer The spacer.
     * @param {number} height Height in pixels.
     * @returns {void}
     */
    static #setDivSpacerHeight(spacer, height) {
      spacer.hidden = height <= 0;
      spacer.style.height = `${height}px`;
    }

    /**
     * Follows the scroll position and keeps the window around it.
     * @returns {void}
     */
    #onScroll = () => {
      this.#frame.schedule();
    };

    /**
     * Once per frame of scrolling: notes whether the view is at the end, then moves the window.
     * @returns {void}
     */
    #onFrame() {
      this.#isAtEnd = this.#isNearEnd();
      this.#update(false);
      this.#anchor = this.#captureAnchor();
    }

    /**
     * Whether the view is at (or near) the end of its content.
     * @returns {boolean} True within the configured distance of the end.
     */
    #isNearEnd() {
      const element = this.#scrollElement;
      return element.scrollHeight - element.scrollTop - element.clientHeight < this.#options.endDistance;
    }

    /**
     * Whether anything can be laid out: a hidden element has no size to measure or fill.
     * @returns {boolean} True while the scroll element has a height.
     */
    #canRender() {
      return this.#scrollElement.clientHeight > 0;
    }

    /**
     * Renders the items the view needs, unless the window already covers it.
     * @param {boolean} force Whether to render even when the window already covers the view.
     * @returns {void}
     */
    #update(force) {
      if (!this.#canRender()) return;
      if (this.#heights.count === 0) this.#showEmpty();
      else this.#fill(force);
    }

    /**
     * Renders the window until it covers the view. Rendering measures items, which changes the
     * estimate for every item not yet measured and so where the view lies among them, so it can take
     * a few passes to settle.
     * @param {boolean} force Whether to render at least once even when the window already covers the view.
     * @returns {void}
     */
    #fill(force) {
      let isForced = force;
      for (let pass = 0; pass < VirtualList.#MAX_FILL_PASSES; pass += 1) {
        const view = this.#view();
        if (!isForced && this.#covers(view)) return;
        isForced = false;
        this.#apply(this.#windowFor(view));
      }
      this.#frame.schedule();
    }

    /**
     * The visible part of the content.
     * @returns {{top: number, bottom: number, height: number}} Top and bottom edges, relative to the first item's top, and the height.
     */
    #view() {
      const height = this.#scrollElement.clientHeight;
      const top = this.#scrollElement.scrollTop - this.#contentOffset();
      return { top, bottom: top + height, height };
    }

    /**
     * Distance from the top of the scrollable content to the top of the first item.
     * @returns {number} The offset in pixels.
     */
    #contentOffset() {
      if (this.#contentElement === this.#scrollElement) return parseFloat(getComputedStyle(this.#scrollElement).paddingTop) || 0;
      return this.#contentElement.getBoundingClientRect().top - this.#scrollElement.getBoundingClientRect().top + this.#scrollElement.scrollTop;
    }

    /**
     * Whether the rendered items reach half a view beyond the visible area on both sides.
     * @param {{top: number, bottom: number, height: number}} view The visible part of the content.
     * @returns {boolean} True when nothing needs rendering yet.
     */
    #covers(view) {
      if (this.#items.length === 0) return false;
      const margin = view.height / 2;
      return this.#heights.indexAt(Math.max(0, view.top - margin)) >= this.#start && this.#heights.indexAt(Math.max(0, view.bottom + margin)) < this.#end;
    }

    /**
     * The items to render for a view: those in it plus a view's height beyond it on both sides.
     * @param {{top: number, bottom: number, height: number}} view The visible part of the content.
     * @returns {{start: number, end: number}} Index of the first item and the index after the last.
     */
    #windowFor(view) {
      return {
        start: this.#heights.indexAt(Math.max(0, view.top - view.height)),
        end: Math.min(this.#heights.count, this.#heights.indexAt(Math.max(0, view.bottom + view.height)) + 1),
      };
    }

    /**
     * Renders a window of items, keeping the item at the top of the view where it is.
     * @param {{start: number, end: number}} range The items to render: the index of the first and the index after the last.
     * @returns {void}
     */
    #apply({ start, end }) {
      const anchor = this.#captureAnchor();
      if (this.#items.length > 0 && start < this.#end && end > this.#start) this.#slideTo(start, end);
      else this.#replaceWith(start, end);
      this.#updateSpacers();
      this.#restoreAnchor(anchor);
      this.#anchor = this.#captureAnchor();
    }

    /**
     * Replaces everything rendered with a window of items.
     * @param {number} start Index of the first item.
     * @param {number} end Index after the last item.
     * @returns {void}
     */
    #replaceWith(start, end) {
      this.#detachItems();
      this.#topSpacer = this.#options.createSpacer();
      this.#bottomSpacer = this.#options.createSpacer();
      const elements = this.#createElements(start, end);
      this.#contentElement.replaceChildren(this.#topSpacer, ...elements, this.#bottomSpacer);
      this.#items = elements;
      this.#start = start;
      this.#end = end;
      this.#updateSpacers();
      this.#register(elements, start);
      this.#updateSpacers();
    }

    /**
     * Moves the window over the rendered items: removes the ones that left it and creates the ones
     * that entered it, leaving the rest alone.
     * @param {number} start Index of the first item.
     * @param {number} end Index after the last item.
     * @returns {void}
     */
    #slideTo(start, end) {
      while (this.#start < start) {
        this.#release(this.#items.shift());
        this.#start += 1;
      }
      while (this.#end > end) {
        this.#release(this.#items.pop());
        this.#end -= 1;
      }
      this.#updateSpacers();
      if (start < this.#start) this.#growAbove(start);
      if (end > this.#end) this.#growBelow(end);
    }

    /**
     * Creates the items between a new window start and the rendered ones.
     * @param {number} start Index of the new first item.
     * @returns {void}
     */
    #growAbove(start) {
      const elements = this.#createElements(start, this.#start);
      this.#items[0].before(...elements);
      this.#items = [...elements, ...this.#items];
      this.#start = start;
      this.#register(elements, start);
    }

    /**
     * Creates the items between the rendered ones and a new window end.
     * @param {number} end Index after the new last item.
     * @returns {void}
     */
    #growBelow(end) {
      const elements = this.#createElements(this.#end, end);
      this.#items[this.#items.length - 1].after(...elements);
      const from = this.#end;
      this.#items = [...this.#items, ...elements];
      this.#end = end;
      this.#register(elements, from);
    }

    /**
     * Creates the elements of a run of items.
     * @param {number} from Index of the first item.
     * @param {number} until Index after the last item.
     * @returns {HTMLElement[]} One element per item.
     */
    #createElements(from, until) {
      const range = document.createRange();
      range.selectNodeContents(this.#contentElement);
      return [...range.createContextualFragment(this.#options.renderItems(from, until)).children];
    }

    /**
     * Starts tracking newly created items: their indexes, sizes and creation callback.
     * @param {HTMLElement[]} elements The new items' elements.
     * @param {number} from Index of the first one.
     * @returns {void}
     */
    #register(elements, from) {
      elements.forEach((element, offset) => {
        this.#indexByElement.set(element, from + offset);
        this.#observer.observe(element);
        this.#heights.record(from + offset, element.getBoundingClientRect().height);
      });
      if (this.#options.onItemsRendered) this.#options.onItemsRendered(elements, from);
    }

    /**
     * Removes an item that left the window.
     * @param {HTMLElement} element The item's element.
     * @returns {void}
     */
    #release(element) {
      this.#observer.unobserve(element);
      element.remove();
    }

    /**
     * Removes every rendered item.
     * @returns {void}
     */
    #detachItems() {
      this.#items.forEach(element => this.#observer.unobserve(element));
      this.#items = [];
      this.#start = 0;
      this.#end = 0;
      this.#anchor = null;
    }

    /**
     * Shows the empty state in place of any items.
     * @returns {void}
     */
    #showEmpty() {
      this.#detachItems();
      this.#topSpacer = null;
      this.#bottomSpacer = null;
      this.#contentElement.innerHTML = this.#options.emptyHtml();
    }

    /**
     * Sizes the spacers from the item heights; a spacer with nothing to stand in for is removed.
     * @returns {void}
     */
    #updateSpacers() {
      this.#sizeSpacer(this.#topSpacer, this.#heights.spanBetween(0, this.#start), () => this.#contentElement.prepend(this.#topSpacer));
      this.#sizeSpacer(this.#bottomSpacer, this.#heights.spanBetween(this.#end, this.#heights.count), () => this.#contentElement.append(this.#bottomSpacer));
    }

    /**
     * Sizes one spacer, putting it in the content or taking it out as needed.
     * @param {HTMLElement} spacer The spacer.
     * @param {number} height Height in pixels; 0 when it has nothing to stand in for.
     * @param {function(): void} attach Puts the spacer into the content at its end.
     * @returns {void}
     */
    #sizeSpacer(spacer, height, attach) {
      this.#options.setSpacerHeight(spacer, height);
      if (height <= 0) spacer.remove();
      else if (!spacer.isConnected) attach();
    }

    /**
     * The first item in the view and where it is.
     * @returns {?{element: HTMLElement, top: number}} The anchor, or null when nothing is rendered.
     */
    #captureAnchor() {
      const viewTop = this.#scrollElement.getBoundingClientRect().top;
      const element = this.#items.find(item => item.getBoundingClientRect().bottom > viewTop + 1);
      return element ? { element, top: element.getBoundingClientRect().top } : null;
    }

    /**
     * Scrolls so an anchor item is back where it was.
     * @param {?{element: HTMLElement, top: number}} anchor The anchor to restore.
     * @returns {void}
     */
    #restoreAnchor(anchor) {
      if (!anchor || !anchor.element.isConnected) return;
      const shift = anchor.element.getBoundingClientRect().top - anchor.top;
      if (Math.abs(shift) > 0.5) this.#scrollElement.scrollTop += shift;
    }

    /**
     * Fine-tunes the scroll position once an item is rendered and measured.
     * @param {number} index Item index.
     * @param {'start'|'center'} block Where in the view to put it.
     * @returns {void}
     */
    #alignRendered(index, block) {
      const element = this.elementAt(index);
      if (!element) return;
      const viewTop = this.#scrollElement.getBoundingClientRect().top;
      const rect = element.getBoundingClientRect();
      const wanted = block === 'center' ? viewTop + (this.#scrollElement.clientHeight - rect.height) / 2 : viewTop;
      this.#scrollElement.scrollTop += rect.top - wanted;
      this.#update(false);
      this.#anchor = this.#captureAnchor();
    }

    /**
     * Reacts to size changes of the scroll element and of rendered items.
     * @param {ResizeObserverEntry[]} entries The changed elements.
     * @returns {void}
     */
    #onResize(entries) {
      if (entries.some(entry => entry.target === this.#scrollElement)) this.#onContainerResized();
      if (this.#resizeTimer !== null) return;
      if (entries.filter(entry => entry.target !== this.#scrollElement).map(entry => this.#noteItemSize(entry.target)).some(Boolean)) this.#stabilize();
    }

    /**
     * Records a rendered item's current height.
     * @param {HTMLElement} element The item's element.
     * @returns {boolean} True when its height differs from the recorded one.
     */
    #noteItemSize(element) {
      const index = this.#indexByElement.get(element);
      return index !== undefined && this.#canRender() && this.#heights.record(index, element.getBoundingClientRect().height);
    }

    /**
     * Reacts to the scroll element changing size: just fills any newly visible space when only its
     * height changed, and lays everything out again when its width changed - but only once the width
     * has stopped changing, so dragging a divider doesn't re-render on every pixel of movement.
     * @returns {void}
     */
    #onContainerResized() {
      if (!this.#canRender()) return;
      if (this.#scrollElement.clientWidth === this.#width) {
        this.#cancelWidthSettle();
        this.#update(this.#items.length === 0);
      } else if (this.#items.length === 0) {
        this.#applyWidthChange();
      } else {
        clearTimeout(this.#resizeTimer);
        this.#resizeTimer = setTimeout(() => this.#applyWidthChange(), TIMING.resizeSettleMs);
      }
    }

    /**
     * Forgets a width change that is waiting to settle.
     * @returns {void}
     */
    #cancelWidthSettle() {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = null;
    }

    /**
     * Lays everything out from scratch for the scroll element's new width, since that rewraps every
     * item and so changes every height.
     * @returns {void}
     */
    #applyWidthChange() {
      this.#resizeTimer = null;
      if (!this.#canRender()) return;
      this.#width = this.#scrollElement.clientWidth;
      this.#heights.clear();
      if (this.#options.onWidthChange) this.#options.onWidthChange();
      else this.refresh();
    }

    /**
     * After rendered items changed height: resizes the spacers and either stays at the end or keeps
     * the item at the top of the view where it was.
     * @returns {void}
     */
    #stabilize() {
      this.#updateSpacers();
      if (this.#options.followsEnd && this.#isAtEnd) this.#scrollElement.scrollTop = this.#scrollElement.scrollHeight;
      else this.#restoreAnchor(this.#anchor);
      this.#anchor = this.#captureAnchor();
    }
  }

  /**
   * Filter control HTML per filter kind: none, a typeahead text input for values, or a from/to pair
   * of date inputs for dates.
   * @type {Readonly<Record<string, function(TableColumn): string>>}
   */
  const FILTER_CONTROLS = Object.freeze({
    none: () => '',
    values: column => `<input type="text" class="claude-plus-column-table__filter-input" data-filter-column="${column.id}" data-filter-bound="text" placeholder="Filter…" />`,
    date: column => `<input type="date" class="claude-plus-column-table__filter-input" data-filter-column="${column.id}" data-filter-bound="from" title="From" /><input type="date" class="claude-plus-column-table__filter-input" data-filter-column="${column.id}" data-filter-bound="to" title="To" />`,
  });

  /**
   * HTML of the filter control under a column's header.
   * @param {TableColumn} column The column.
   * @returns {string} The control's HTML; empty for a column without a filter.
   */
  function filterControlHtml(column) {
    return FILTER_CONTROLS[column.filter ?? 'none'](column);
  }

  var stylesheet$p = ".claude-plus-column-table__column-picker {\r\n  flex-shrink: 0;\r\n  font-size: 11px;\r\n  color: var(--claude-plus-color-text-muted);\r\n}\r\n\r\ndetails.claude-plus-column-table__column-picker summary {\r\n  padding: 0;\r\n}\r\n\r\n.claude-plus-column-table__column-toggle {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  gap: 4px;\r\n  margin: 2px 10px 2px 0;\r\n  cursor: pointer;\r\n}\r\n\r\n.claude-plus-column-table__table {\r\n  width: 100%;\r\n  border-collapse: collapse;\r\n  font-size: 12px;\r\n}\r\n\r\n.claude-plus-column-table__table th {\r\n  text-align: left;\r\n  padding: 4px 6px;\r\n  color: var(--claude-plus-color-text-muted);\r\n  background: var(--claude-plus-color-raised);\r\n  position: sticky;\r\n  z-index: 1;\r\n  white-space: nowrap;\r\n  font-weight: 600;\r\n}\r\n\r\n.claude-plus-column-table__table--locked {\n  table-layout: fixed;\n}\n\n.claude-plus-column-table__table--locked .claude-plus-column-table__cell {\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.claude-plus-column-table__resize-handle {\r\n  position: absolute;\r\n  top: 0;\r\n  right: 0;\r\n  bottom: 0;\r\n  width: 6px;\r\n  cursor: col-resize;\r\n  z-index: 2;\r\n}\r\n\r\n.claude-plus-column-table__resize-handle:hover,\r\n.claude-plus-column-table__resize-handle:active {\r\n  background: var(--claude-plus-color-accent);\r\n}\r\n\r\n.claude-plus-column-table__table thead tr:first-child th {\r\n  top: 0;\r\n}\r\n\r\n.claude-plus-column-table__filter-row th {\r\n  top: 24px;\r\n  padding-top: 0;\r\n  border-bottom: 1px solid var(--claude-plus-color-border-strong);\r\n  font-weight: normal;\r\n}\r\n\r\n.claude-plus-column-table__sortable {\r\n  cursor: pointer;\r\n  user-select: none;\r\n}\r\n\r\n.claude-plus-column-table__sortable:hover {\r\n  color: var(--claude-plus-color-text);\r\n}\r\n\r\n.claude-plus-panel .claude-plus-column-table__filter-input {\r\n  display: block;\r\n  width: 100%;\r\n  min-width: 40px;\r\n  box-sizing: border-box;\r\n  padding: 2px 4px;\r\n  font-size: 11px;\r\n}\r\n\r\n.claude-plus-panel input[type=date].claude-plus-column-table__filter-input {\r\n  min-width: 0;\r\n  max-width: 112px;\r\n  padding: 1px 2px;\r\n  font-size: 10px;\r\n}\r\n\r\n.claude-plus-panel input[type=date].claude-plus-column-table__filter-input + input[type=date] {\r\n  margin-top: 2px;\r\n}\r\n\r\n.claude-plus-column-table__cell {\r\n  padding: 4px 6px;\r\n  border-bottom: 1px solid var(--claude-plus-color-border-faint);\r\n  vertical-align: top;\r\n}\r\n\r\n.claude-plus-column-table__cell--name,\r\n.claude-plus-column-table__cell--title,\r\n.claude-plus-column-table__cell--match {\r\n  width: 100%;\r\n  max-width: 1px;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.claude-plus-column-table__cell a {\r\n  color: var(--claude-plus-color-accent);\r\n  text-decoration: none;\r\n}\r\n\r\n.claude-plus-column-table__cell a:hover {\r\n  text-decoration: underline;\r\n}\r\n";

  StyleRegistry.register(stylesheet$p);

  /**
   * A reusable table with toggleable columns, sorting by clicking a header (clicking again reverses
   * it), per-column filters under the headers (typeahead wildcard filters for text columns and date
   * ranges for timestamp columns), and a drag handle on each header's right edge to resize it
   * (double-click a handle to restore that column's normal width). Column visibility, sort order and
   * resized widths persist per table id.
   */
  class ColumnTable {
    /**
     * Narrowest a column can be dragged to, in pixels.
     * @type {number}
     */
    static #MIN_COLUMN_WIDTH = 40;

    /**
     * Height assumed for a row until some have been measured, in pixels.
     * @type {number}
     */
    static #ESTIMATED_ROW_HEIGHT = 27;

    /**
     * Class of the table while its columns are locked to fixed widths.
     * @type {string}
     */
    static #LOCKED_CLASS = 'claude-plus-column-table__table--locked';

    /**
     * Storage key of the column and sort settings.
     * @type {string}
     */
    #storageKey;

    /**
     * All columns, in display order.
     * @type {TableColumn[]}
     */
    #columns;

    /**
     * Settings storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Returns the attributes of a row's tr element.
     * @type {function(object): string}
     */
    #rowAttributes;

    /**
     * Shown when no row passes the filters.
     * @type {string}
     */
    #emptyText;

    /**
     * Current rows, unfiltered.
     * @type {object[]}
     */
    #rows = [];

    /**
     * The rows passing the filters, in sort order: what the windowed list renders from.
     * @type {object[]}
     */
    #visibleRows = [];

    /**
     * Renders only the rows near the visible area, however many there are.
     * @type {VirtualList}
     */
    #virtualList;

    /**
     * Which columns are shown.
     * @type {ColumnVisibility}
     */
    #visibility;

    /**
     * Sort column and direction.
     * @type {SortOrder}
     */
    #sortOrder;

    /**
     * Entered filter values.
     * @type {RowFilterSet}
     */
    #filters;

    /**
     * Manually resized column widths.
     * @type {ColumnWidths}
     */
    #columnWidths;

    /**
     * Column being dragged to resize, while a drag is in progress. currentWidth is the width being
     * dragged to, tracked as a plain number rather than re-measured from the header afterwards: a
     * flexible column's body cells keep their own competing width until #renderBody() next runs, so
     * the header's rendered width mid-drag doesn't reliably reflect what was actually requested.
     * @type {?{columnId: string, headerElement: HTMLElement, startX: number, currentWidth: number}}
     */
    #resizing = null;

    /**
     * Named elements of the table.
     * @type {Object<string, HTMLElement>}
     */
    #elements;

    /**
     * Typeaheads of the current filter row.
     * @type {ValueCombobox[]}
     */
    #comboboxes = [];

    /**
     * Builds the table into a container.
     * @param {object} options Table options.
     * @param {HTMLElement} options.container Element the table is built into.
     * @param {string} options.tableId Id under which column and sort settings are stored.
     * @param {TableColumn[]} options.columns Columns in display order.
     * @param {Preferences} options.preferences Settings storage.
     * @param {{column: string, direction: number}} options.defaultSort Sort used until the user sorts.
     * @param {function(object): string} options.rowAttributes Returns the escaped attributes of a row's tr element.
     * @param {string} options.emptyText Shown when no row passes the filters.
     */
    constructor({ container, tableId, columns, preferences, defaultSort, rowAttributes, emptyText }) {
      this.#storageKey = `${STORAGE_KEYS.tablePrefix}${tableId}`;
      this.#columns = columns;
      this.#preferences = preferences;
      this.#rowAttributes = rowAttributes;
      this.#emptyText = emptyText;
      const stored = preferences.readJson(this.#storageKey) ?? {};
      this.#visibility = new ColumnVisibility(columns, stored.visibleColumnIds);
      this.#sortOrder = new SortOrder(columns, stored.sortOrder, defaultSort);
      this.#filters = new RowFilterSet(columns);
      this.#columnWidths = new ColumnWidths(stored.columnWidths);
      container.innerHTML = ColumnTable.#skeletonHtml(columns);
      this.#elements = collectNamedElements(container);
      this.#virtualList = this.#createVirtualList();
      this.#bindEvents();
      this.#renderColumns();
    }

    /**
     * The tbody element; row click handling is attached here by the table's owner.
     * @returns {HTMLElement} The body.
     */
    get bodyElement() {
      return this.#elements.tableBody;
    }

    /**
     * Replaces the rows and re-renders.
     * @param {object[]} rows New rows.
     * @returns {void}
     */
    setRows(rows) {
      this.#rows = rows;
      this.#renderBody();
    }

    /**
     * Closes any open typeahead list.
     * @returns {void}
     */
    dispose() {
      this.#comboboxes.forEach(combobox => combobox.dispose());
      this.#virtualList.dispose();
    }

    /**
     * HTML of the column picker and the empty table.
     * @param {TableColumn[]} columns All columns.
     * @returns {string} The HTML.
     */
    static #skeletonHtml(columns) {
      const toggles = columns.filter(column => !column.isAlwaysVisible)
        .map(column => `<label class="claude-plus-column-table__column-toggle"><input type="checkbox" data-column-toggle="${column.id}" /> ${escapeHtml(column.label)}</label>`)
        .join('');
      const picker = toggles ? `<details class="claude-plus-column-table__column-picker"><summary>Columns</summary><div data-name="columnToggles">${toggles}</div></details>` : '';
      return `${picker}<div class="claude-plus-scrollable claude-plus-fill-remaining claude-plus-column-table" data-name="scroller"><table class="claude-plus-column-table__table" data-name="table"><colgroup data-name="columnGroup"></colgroup><thead><tr data-name="headerRow"></tr><tr class="claude-plus-column-table__filter-row" data-name="filterRow"></tr></thead><tbody data-name="tableBody"></tbody></table></div>`;
    }

    /**
     * The windowed list rendering the rows into the table body: its rows are measured, and the
     * columns locked to the widths the visible rows gave them so they don't shift while scrolling.
     * @returns {VirtualList} The list.
     */
    #createVirtualList() {
      return new VirtualList({
        scrollElement: this.#elements.scroller,
        contentElement: this.#elements.tableBody,
        gap: 0,
        estimatedHeight: ColumnTable.#ESTIMATED_ROW_HEIGHT,
        renderItems: (start, end) => this.#rowsHtml(start, end),
        emptyHtml: () => `<tr><td colspan="${this.#visibility.visibleColumns.length}" class="claude-plus-empty-state">${escapeHtml(this.#emptyText)}</td></tr>`,
        createSpacer: () => this.#createRowSpacer(),
        setSpacerHeight: ColumnTable.#setRowSpacerHeight,
        onWidthChange: () => this.#relayout(),
      });
    }

    /**
     * A spacer standing in for unrendered rows: a row with one cell spanning every column.
     * @returns {HTMLElement} The spacer row.
     */
    #createRowSpacer() {
      const row = createElement('tr', { className: 'claude-plus-virtual-spacer' });
      row.append(createElement('td', { colSpan: this.#visibility.visibleColumns.length }));
      return row;
    }

    /**
     * Sizes a spacer row, hiding it while it has no size.
     * @param {HTMLElement} spacer The spacer row.
     * @param {number} height Height in pixels.
     * @returns {void}
     */
    static #setRowSpacerHeight(spacer, height) {
      spacer.hidden = height <= 0;
      spacer.firstElementChild.style.height = `${height}px`;
    }

    /**
     * Wires sorting, column toggles and filters.
     * @returns {void}
     */
    #bindEvents() {
      this.#elements.headerRow.addEventListener('click', event => this.#onHeaderClick(event));
      this.#elements.headerRow.addEventListener('mousedown', event => this.#onResizeHandleMouseDown(event));
      this.#elements.headerRow.addEventListener('dblclick', event => this.#onResizeHandleDoubleClick(event));
      this.#elements.filterRow.addEventListener('input', event => this.#onFilterInput(event));
      if (this.#elements.columnToggles) this.#elements.columnToggles.addEventListener('change', event => this.#onColumnToggle(event));
    }

    /**
     * Sorts by the clicked header's column; ignored for a press on its resize handle.
     * @param {MouseEvent} event Click in the header row.
     * @returns {void}
     */
    #onHeaderClick(event) {
      if (event.target.closest('[data-resize-handle]')) return;
      const header = event.target.closest('[data-sort-column]');
      if (!header) return;
      this.#sortOrder.sortBy(header.dataset.sortColumn);
      this.#saveSettings();
      this.#renderHeader();
      this.#renderBody();
    }

    /**
     * Shows or hides the toggled column; a hidden column's filter is dropped.
     * @param {Event} event Change of a column checkbox.
     * @returns {void}
     */
    #onColumnToggle(event) {
      const checkbox = event.target.closest('[data-column-toggle]');
      if (!checkbox) return;
      const columnId = checkbox.dataset.columnToggle;
      this.#visibility.setVisible(columnId, checkbox.checked);
      if (!checkbox.checked) this.#filters.drop(columnId);
      this.#saveSettings();
      this.#renderColumns();
    }

    /**
     * Records a filter input's value and re-renders the rows.
     * @param {Event} event Input in the filter row.
     * @returns {void}
     */
    #onFilterInput(event) {
      const input = event.target.closest('[data-filter-column]');
      if (!input) return;
      this.#filters.record(input.dataset.filterColumn, input.dataset.filterBound, input.value);
      this.#renderBody();
    }

    /**
     * Starts dragging a header's resize handle.
     * @param {MouseEvent} event Mouse press in the header row.
     * @returns {void}
     */
    #onResizeHandleMouseDown(event) {
      const handle = event.target.closest('[data-resize-handle]');
      if (!handle) return;
      event.preventDefault();
      const headerElement = handle.closest('th');
      this.#resizing = { columnId: handle.dataset.resizeHandle, headerElement, startX: event.clientX, currentWidth: headerElement.getBoundingClientRect().width };
      document.addEventListener('mousemove', this.#onResizeMouseMove);
      document.addEventListener('mouseup', this.#onResizeMouseUp);
    }

    /**
     * Resizes the dragged column's header live as the pointer moves; the header's own width governs
     * the whole column's width, so the body cells don't need touching until the drag ends.
     * @param {MouseEvent} event The pointer move.
     * @returns {void}
     */
    #onResizeMouseMove = (event) => {
      this.#resizing.currentWidth = ColumnTable.#clampedWidth(this.#resizing.currentWidth + (event.clientX - this.#resizing.startX));
      this.#resizing.startX = event.clientX;
      const { headerElement, currentWidth } = this.#resizing;
      headerElement.style.width = `${currentWidth}px`;
      const column = this.#elements.columnGroup.children[[...this.#elements.headerRow.children].indexOf(headerElement)];
      if (column) column.style.width = `${currentWidth}px`;
    };

    /**
     * Ends a resize drag, persisting the final width and applying it to the body cells too.
     * @returns {void}
     */
    #onResizeMouseUp = () => {
      this.#columnWidths.setWidth(this.#resizing.columnId, Math.round(this.#resizing.currentWidth));
      this.#resizing = null;
      document.removeEventListener('mousemove', this.#onResizeMouseMove);
      document.removeEventListener('mouseup', this.#onResizeMouseUp);
      this.#saveSettings();
      this.#renderBody();
    };

    /**
     * Restores a double-clicked handle's column to its normal width.
     * @param {MouseEvent} event Double-click in the header row.
     * @returns {void}
     */
    #onResizeHandleDoubleClick(event) {
      const handle = event.target.closest('[data-resize-handle]');
      if (!handle) return;
      this.#columnWidths.reset(handle.dataset.resizeHandle);
      this.#saveSettings();
      this.#renderHeader();
      this.#renderBody();
    }

    /**
     * Clamps a dragged width to a sensible minimum.
     * @param {number} width Proposed width in pixels.
     * @returns {number} At least MIN_COLUMN_WIDTH.
     */
    static #clampedWidth(width) {
      return Math.max(ColumnTable.#MIN_COLUMN_WIDTH, width);
    }

    /**
     * Stores column visibility, sort order and resized widths.
     * @returns {void}
     */
    #saveSettings() {
      this.#preferences.writeJson(this.#storageKey, { visibleColumnIds: this.#visibility.visibleColumnIds, sortOrder: this.#sortOrder, columnWidths: this.#columnWidths.stored });
    }

    /**
     * Renders the column picker state, the header, the filter row and the rows.
     * @returns {void}
     */
    #renderColumns() {
      this.#syncColumnToggles();
      this.#renderHeader();
      this.#renderFilterRow();
      this.#renderBody();
    }

    /**
     * Checks the picker boxes of the visible columns.
     * @returns {void}
     */
    #syncColumnToggles() {
      if (!this.#elements.columnToggles) return;
      this.#elements.columnToggles.querySelectorAll('[data-column-toggle]').forEach(checkbox => {
        checkbox.checked = this.#visibility.isVisible(checkbox.dataset.columnToggle);
      });
    }

    /**
     * Renders the header cells with the sort indicator.
     * @returns {void}
     */
    #renderHeader() {
      this.#elements.headerRow.innerHTML = this.#visibility.visibleColumns.map(column => this.#headerCellHtml(column)).join('');
    }

    /**
     * HTML of one header cell, with a resize handle on its right edge.
     * @param {TableColumn} column The column.
     * @returns {string} The cell; sortable columns carry data-sort-column and show ▲ or ▼ while sorted.
     */
    #headerCellHtml(column) {
      const labelHtml = column.isNotSortable ? escapeHtml(column.label) : `${escapeHtml(column.label)}${this.#sortOrder.indicatorFor(column.id)}`;
      const sortAttribute = column.isNotSortable ? '' : ` class="claude-plus-column-table__sortable" data-sort-column="${column.id}"`;
      const handleHtml = `<span class="claude-plus-column-table__resize-handle" data-resize-handle="${column.id}"></span>`;
      return `<th${sortAttribute}${this.#widthStyleAttribute(column.id)}>${labelHtml}${handleHtml}</th>`;
    }

    /**
     * A style attribute pinning a column to its manually resized width, truncating overflowing
     * content; empty for a column the user hasn't resized.
     * @param {string} columnId Column id.
     * @returns {string} The attribute, or an empty string.
     */
    #widthStyleAttribute(columnId) {
      const width = this.#columnWidths.widthOf(columnId);
      return width ? ` style="width:${width}px;max-width:${width}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"` : '';
    }

    /**
     * Renders the filter controls under the visible columns, keeping entered values, and attaches
     * the typeaheads.
     * @returns {void}
     */
    #renderFilterRow() {
      this.#comboboxes.forEach(combobox => combobox.dispose());
      this.#elements.filterRow.innerHTML = this.#visibility.visibleColumns.map(column => `<th>${filterControlHtml(column)}</th>`).join('');
      this.#elements.filterRow.querySelectorAll('[data-filter-column]').forEach(input => {
        input.value = this.#filters.valueOf(input.dataset.filterColumn, input.dataset.filterBound);
      });
      this.#comboboxes = [...this.#elements.filterRow.querySelectorAll('[data-filter-bound="text"]')]
        .map(input => new ValueCombobox(input, () => this.#distinctFilterValues(input.dataset.filterColumn)));
    }

    /**
     * Distinct non-empty filter values of a column across all rows.
     * @param {string} columnId Column id.
     * @returns {string[]} The values, sorted.
     */
    #distinctFilterValues(columnId) {
      const column = this.#columns.find(candidate => candidate.id === columnId);
      const values = this.#rows.map(row => columnFilterValue(column, row)).filter(Boolean).map(String);
      return [...new Set(values)].sort((first, second) => first.localeCompare(second));
    }

    /**
     * Filters and sorts the rows, then lays the table out for them.
     * @returns {void}
     */
    #renderBody() {
      this.#visibleRows = this.#sortOrder.sort(this.#filters.apply(this.#rows, this.#visibility));
      this.#relayout();
    }

    /**
     * Renders the visible window of rows with the columns sized to fit them, then locks the columns
     * at those widths: the window changes as the table scrolls, and columns sized by whichever rows
     * happen to be rendered would jitter.
     * @returns {void}
     */
    #relayout() {
      this.#elements.table.classList.remove(ColumnTable.#LOCKED_CLASS);
      this.#elements.columnGroup.innerHTML = '';
      this.#virtualList.setCount(this.#visibleRows.length);
      this.#lockColumns();
    }

    /**
     * Fixes every column at its current width; skipped while the table is hidden and has none.
     * @returns {void}
     */
    #lockColumns() {
      const widths = [...this.#elements.headerRow.children].map(header => header.getBoundingClientRect().width);
      if (widths.length === 0 || widths.includes(0)) return;
      this.#elements.columnGroup.innerHTML = widths.map(width => `<col style="width:${width}px">`).join('');
      this.#elements.table.classList.add(ColumnTable.#LOCKED_CLASS);
    }

    /**
     * HTML of a run of the visible rows.
     * @param {number} start Index of the first row.
     * @param {number} end Index after the last row.
     * @returns {string} The tr elements.
     */
    #rowsHtml(start, end) {
      const visibleColumns = this.#visibility.visibleColumns;
      return this.#visibleRows.slice(start, end).map(row => this.#rowHtml(row, visibleColumns)).join('');
    }

    /**
     * HTML of one row.
     * @param {object} row The row.
     * @param {TableColumn[]} visibleColumns Columns to render.
     * @returns {string} The tr element.
     */
    #rowHtml(row, visibleColumns) {
      const cells = visibleColumns.map(column => `<td class="claude-plus-column-table__cell claude-plus-column-table__cell--${column.id}"${this.#widthStyleAttribute(column.id)}>${column.cellHtml(row)}</td>`);
      return `<tr ${this.#rowAttributes(row)}>${cells.join('')}</tr>`;
    }
  }

  /**
   * A column naming the conversation a row belongs to, read from the row's conversationTitle.
   * @returns {TableColumn} The column.
   */
  function createConversationColumn() {
    return {
      id: 'conversation', label: 'Chat', isVisibleByDefault: true, filter: 'values',
      sortValue: row => (row.conversationTitle || '').toLowerCase(),
      filterValue: row => row.conversationTitle,
      cellHtml: row => escapeHtml(row.conversationTitle || ''),
    };
  }

  /**
   * A timestamp as local date and time.
   * @param {?string} isoDate ISO timestamp.
   * @returns {string} The formatted date and time, or an empty string when missing or invalid.
   */
  function formatTimestamp(isoDate) {
    const epochMs = toEpochMs(isoDate);
    return epochMs ? new Date(epochMs).toLocaleString() : '';
  }

  /**
   * A sortable, date-range-filterable timestamp column.
   * @param {function(object): ?string} timestampOf Returns a row's ISO timestamp.
   * @returns {TableColumn} The column.
   */
  function createDateColumn(timestampOf) {
    return {
      id: 'date', label: 'Date', isVisibleByDefault: true, filter: 'date',
      sortValue: row => toEpochMs(timestampOf(row)),
      filterValue: row => timestampOf(row),
      cellHtml: row => escapeHtml(formatTimestamp(timestampOf(row))),
    };
  }

  /**
   * Last segment of a slash-separated path.
   * @param {?string} path The path.
   * @returns {string} The last segment, or an empty string.
   */
  function lastPathSegment(path) {
    return (path || '').split('/').pop();
  }

  /**
   * Lower-case extension of a file name or path, ignoring any query string.
   * @param {?string} fileName File name or path.
   * @returns {string} The extension without the dot, or "file" when there is none.
   */
  function fileExtension(fileName) {
    const match = lastPathSegment(fileName).split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
    return match ? match[1].toLowerCase() : 'file';
  }

  /**
   * Who provided a file.
   * @param {FileEntry} file The file.
   * @returns {string} "User" or "Claude".
   */
  function fileSourceLabel(file) {
    return file.source === 'user' ? 'User' : 'Claude';
  }

  /**
   * Columns of a file table: name, type, date, who provided it and optionally the conversation.
   * @param {boolean} includesConversation Whether to offer a column with the file's conversation.
   * @returns {TableColumn[]} The columns.
   */
  function createFileColumns(includesConversation) {
    const columns = [
      { id: 'name', label: 'Name', isAlwaysVisible: true, filter: 'values', sortValue: file => (file.title || '').toLowerCase(), filterValue: file => file.title, cellHtml: file => escapeHtml(file.title || '(file)') },
      { id: 'type', label: 'Type', isVisibleByDefault: true, filter: 'values', sortValue: file => fileExtension(file.title || file.path), cellHtml: file => escapeHtml(fileExtension(file.title || file.path)) },
      createDateColumn(file => file.timestamp),
      { id: 'source', label: 'Source', isVisibleByDefault: true, filter: 'values', sortValue: file => fileSourceLabel(file), cellHtml: file => fileSourceLabel(file) },
    ];
    return includesConversation ? [...columns, createConversationColumn()] : columns;
  }

  /**
   * Columns of a web source table: title (a link), outlet, top-level domain, date and optionally
   * the conversation.
   * @param {boolean} includesConversation Whether to offer a column with the source's conversation.
   * @returns {TableColumn[]} The columns.
   */
  function createSourceColumns(includesConversation) {
    const columns = [
      { id: 'title', label: 'Title', isAlwaysVisible: true, filter: 'values', sortValue: source => (source.title || '').toLowerCase(), filterValue: source => source.title, cellHtml: source => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a>` },
      { id: 'outlet', label: 'Outlet', isVisibleByDefault: true, filter: 'values', sortValue: source => source.outlet || '', cellHtml: source => escapeHtml(source.outlet || '') },
      { id: 'topLevelDomain', label: 'TLD', filter: 'values', sortValue: source => source.topLevelDomain || '', cellHtml: source => escapeHtml(source.topLevelDomain ? `.${source.topLevelDomain}` : '') },
      createDateColumn(source => source.timestamp),
    ];
    return includesConversation ? [...columns, createConversationColumn()] : columns;
  }

  var stylesheet$o = ".claude-plus-subpane {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 4px;\r\n  min-height: 0;\r\n  flex: 1;\r\n  padding: 6px;\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  background: var(--claude-plus-color-bar);\r\n}\r\n\r\n.claude-plus-subpane__header {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 2px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-subpane__title {\r\n  flex: 1;\r\n  min-width: 0;\r\n  font-size: 12px;\r\n  font-weight: 600;\r\n  white-space: nowrap;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n}\r\n\r\n.claude-plus-subpane__button {\r\n  background: none;\r\n  border: none;\r\n  color: var(--claude-plus-color-text-faint);\r\n  cursor: pointer;\r\n  padding: 2px 5px;\r\n  border-radius: 4px;\r\n}\r\n\r\n.claude-plus-subpane__button:hover {\r\n  background: var(--claude-plus-color-hover);\r\n  color: var(--claude-plus-color-text);\r\n}\r\n";

  StyleRegistry.register(stylesheet$o);

  /**
   * A sub-pane inside a chat pane listing the web sources or files of that pane's conversation.
   * It can be docked to the pane's left, top or right edge and closed. Double-clicking a row jumps
   * to the message it came from.
   */
  class ConversationSubPane {
    /**
     * Title, table id, columns and row source per kind.
     * @type {Readonly<Record<string, {title: string, tableId: string, columns: function(): TableColumn[], rowsOf: function(StatsAggregate, string): object[]}>>}
     */
    static #KINDS = Object.freeze({
      sources: {
        title: '🌐 Sources in this chat',
        tableId: 'conversationSources',
        columns: () => createSourceColumns(false),
        rowsOf: (aggregate, conversationId) => aggregate.sources.filter(source => source.conversationId === conversationId),
      },
      files: {
        title: '📁 Files in this chat',
        tableId: 'conversationFiles',
        columns: () => createFileColumns(false),
        rowsOf: (aggregate, conversationId) => ConversationSubPane.#folderFiles(aggregate, conversationId),
      },
    });

    /**
     * Kind of content: 'sources' or 'files'.
     * @type {string}
     */
    #kind;

    /**
     * Session whose conversation is shown.
     * @type {ChatSession}
     */
    #session;

    /**
     * Conversation statistics.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * The sub-pane's root element.
     * @type {HTMLElement}
     */
    #element;

    /**
     * The table.
     * @type {ColumnTable}
     */
    #table;

    /**
     * Undoes the subscriptions.
     * @type {Array<function(): void>}
     */
    #unsubscribers = [];

    /**
     * Builds the sub-pane.
     * @param {object} options Sub-pane options.
     * @param {string} options.kind 'sources' or 'files'.
     * @param {ChatSession} options.session Session whose conversation is shown.
     * @param {StatsIndex} options.stats Conversation statistics.
     * @param {Preferences} options.preferences Table settings storage.
     * @param {function(string): void} options.onClose Called with the kind when × is clicked.
     * @param {function(string, string): void} options.onMove Called with the kind and 'left', 'top' or 'right' when an arrow is clicked.
     * @param {function(string): void} options.onJumpToMessage Called with a message id when a row tied
     * to one is double-clicked.
     */
    constructor({ kind, session, stats, preferences, onClose, onMove, onJumpToMessage }) {
      const definition = ConversationSubPane.#KINDS[kind];
      this.#kind = kind;
      this.#session = session;
      this.#stats = stats;
      this.#element = createElement('section', { className: 'claude-plus-subpane', innerHTML: ConversationSubPane.#bodyHtml(definition.title) });
      this.#table = new ColumnTable({
        container: this.#element.querySelector('[data-name="tableHost"]'),
        tableId: definition.tableId,
        columns: definition.columns(),
        preferences,
        defaultSort: { column: 'date', direction: -1 },
        rowAttributes: row => `data-message-id="${escapeHtml(row.messageId ?? '')}"`,
        emptyText: 'Nothing recorded for this chat yet.',
      });
      this.#table.bodyElement.addEventListener('dblclick', event => ConversationSubPane.#onRowDoubleClick(event, onJumpToMessage));
      this.#element.querySelector('header').addEventListener('click', event => SubPaneHeader.onClick(event, () => onClose(kind), edge => onMove(kind, edge)));
      this.#unsubscribers.push(stats.subscribe('aggregate', () => this.render()), session.subscribe('openConversation', () => this.render()));
      this.render();
    }

    /**
     * The sub-pane's root element.
     * @returns {HTMLElement} The element.
     */
    get element() {
      return this.#element;
    }

    /**
     * Shows the rows of the session's current conversation.
     * @returns {void}
     */
    render() {
      const conversationId = this.#session.openConversationId;
      const rowsOf = ConversationSubPane.#KINDS[this.#kind].rowsOf;
      this.#table.setRows(conversationId ? rowsOf(this.#stats.aggregate, conversationId) : []);
    }

    /**
     * Jumps to the message a double-clicked row belongs to, if it's tied to one - a chat-agnostic
     * folder summary row (a file or source) rather than a specific occurrence never carries one.
     * @param {MouseEvent} event The double-click.
     * @param {function(string): void} onJumpToMessage Called with a message id.
     * @returns {void}
     */
    static #onRowDoubleClick(event, onJumpToMessage) {
      const messageId = event.target.closest('[data-message-id]')?.dataset.messageId;
      if (messageId) onJumpToMessage(messageId);
    }

    /**
     * Ends the subscriptions and removes the sub-pane.
     * @returns {void}
     */
    dispose() {
      this.#unsubscribers.forEach(unsubscribe => unsubscribe());
      this.#table.dispose();
      this.#element.remove();
    }

    /**
     * HTML of the sub-pane: a header with title, dock arrows and close button, and the table host.
     * @param {string} title Header title.
     * @returns {string} The HTML.
     */
    static #bodyHtml(title) {
      return `${SubPaneHeader.html(title)}<div class="claude-plus-table-host" data-name="tableHost"></div>`;
    }

    /**
     * Files of one conversation.
     * @param {StatsAggregate} aggregate Current totals.
     * @param {string} conversationId Conversation id.
     * @returns {FileEntry[]} Its files, or none when it has no folder.
     */
    static #folderFiles(aggregate, conversationId) {
      const folder = aggregate.folders.find(candidate => candidate.conversationId === conversationId);
      return folder ? folder.files : [];
    }
  }

  /**
   * Marks the matches of an in-chat search in the rendered messages using the browser's CSS Custom
   * Highlight API, which paints ranges of text without changing the DOM - so the marks neither
   * disturb the message list's measuring nor need undoing before a message is re-rendered.
   */
  class ChatFindHighlighter {
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

  /**
   * Base of every modal dialog: a themed overlay over the whole page holding the dialog's content.
   * Showing returns a promise resolved with the dialog's result once it closes. Pressing Escape or
   * pressing the backdrop closes it with the cancel value. Subclasses supply the overlay class and
   * the content, and can react once the dialog is on screen.
   * @abstract
   */
  class Dialog {
    /**
     * The overlay while the dialog is shown, otherwise null.
     * @type {?HTMLElement}
     */
    #overlay = null;

    /**
     * Resolves the promise returned by show().
     * @type {?function(*): void}
     */
    #resolveResult = null;

    /**
     * CSS class of the overlay, which also styles the content inside it.
     * @abstract
     * @returns {string} The class name.
     * @throws {Error} When a subclass does not override it.
     */
    get overlayClassName() {
      throw new Error(`${this.constructor.name} must override overlayClassName`);
    }

    /**
     * Result of the dialog when dismissed by Escape or a press on the backdrop.
     * @returns {*} The cancel result; undefined unless overridden.
     */
    get cancelValue() {
      return undefined;
    }

    /**
     * Builds the elements placed inside the overlay.
     * @abstract
     * @returns {HTMLElement[]} The content elements.
     * @throws {Error} When a subclass does not override it.
     */
    createContent() {
      throw new Error(`${this.constructor.name} must override createContent`);
    }

    /**
     * Called once the dialog is on screen, e.g. to focus an input. Does nothing unless overridden.
     * @returns {void}
     */
    afterShow() {}

    /**
     * Puts the dialog on screen.
     * @returns {Promise<*>} Resolves with the result passed to close(), or the cancel value.
     */
    show() {
      return new Promise(resolve => {
        this.#resolveResult = resolve;
        this.#overlay = createElement('div', { className: `claude-plus-themed ${this.overlayClassName}` });
        this.#overlay.append(...this.createContent());
        this.#overlay.addEventListener('mousedown', this.#closeOnBackdropPress);
        document.addEventListener('keydown', this.#closeOnEscape);
        document.body.append(this.#overlay);
        this.afterShow();
      });
    }

    /**
     * Removes the dialog and resolves its promise. Does nothing when it is not shown.
     * @param {*} result Result of the dialog.
     * @returns {void}
     */
    close(result) {
      if (!this.#overlay) return;
      this.#overlay.remove();
      this.#overlay = null;
      document.removeEventListener('keydown', this.#closeOnEscape);
      this.#resolveResult(result);
    }

    /**
     * Closes with the cancel value when the press landed on the backdrop itself.
     * @param {MouseEvent} event The mousedown event.
     * @returns {void}
     */
    #closeOnBackdropPress = event => {
      if (event.target === this.#overlay) this.close(this.cancelValue);
    };

    /**
     * Closes with the cancel value when Escape is pressed.
     * @param {KeyboardEvent} event The keydown event.
     * @returns {void}
     */
    #closeOnEscape = event => {
      if (event.key === 'Escape') this.close(this.cancelValue);
    };
  }

  /**
   * Tracks one mouse drag gesture on the window. Its listeners exist only while the button is held
   * and are always removed on release.
   */
  class DragGesture {
    /**
     * Pointer x when the button was pressed.
     * @type {number}
     */
    #startPointerX;

    /**
     * Pointer y when the button was pressed.
     * @type {number}
     */
    #startPointerY;

    /**
     * Movement in pixels before the gesture counts as a drag.
     * @type {number}
     */
    #threshold;

    /**
     * Called on every move once dragging.
     * @type {function(MouseEvent): void}
     */
    #onMove;

    /**
     * Called on release with whether a drag happened.
     * @type {function(MouseEvent, boolean): void}
     */
    #onEnd;

    /**
     * Whether the threshold has been passed.
     * @type {boolean}
     */
    #isDragging;

    /**
     * Starts tracking from a mousedown event.
     * @param {MouseEvent} startEvent The mousedown that starts the gesture.
     * @param {object} handlers Gesture configuration.
     * @param {number} handlers.threshold Movement in pixels before moves are reported; 0 reports all.
     * @param {function(MouseEvent): void} handlers.onMove Called for each move while dragging.
     * @param {function(MouseEvent, boolean): void} handlers.onEnd Called on release with whether the threshold was passed.
     */
    constructor(startEvent, { threshold, onMove, onEnd }) {
      this.#startPointerX = startEvent.clientX;
      this.#startPointerY = startEvent.clientY;
      this.#threshold = threshold;
      this.#onMove = onMove;
      this.#onEnd = onEnd;
      this.#isDragging = threshold === 0;
      window.addEventListener('mousemove', this.#handleMove);
      window.addEventListener('mouseup', this.#handleRelease);
    }

    /**
     * Reports a move once the threshold has been passed.
     * @param {MouseEvent} event The mousemove event.
     * @returns {void}
     */
    #handleMove = (event) => {
      if (!this.#isDragging && !this.#hasPassedThreshold(event)) return;
      this.#isDragging = true;
      this.#onMove(event);
    };

    /**
     * Ends the gesture and removes the window listeners.
     * @param {MouseEvent} event The mouseup event.
     * @returns {void}
     */
    #handleRelease = (event) => {
      window.removeEventListener('mousemove', this.#handleMove);
      window.removeEventListener('mouseup', this.#handleRelease);
      this.#onEnd(event, this.#isDragging);
    };

    /**
     * Whether the pointer has moved far enough from the start to count as a drag.
     * @param {MouseEvent} event Current pointer event.
     * @returns {boolean} True once either axis moved at least the threshold.
     */
    #hasPassedThreshold(event) {
      const movedX = Math.abs(event.clientX - this.#startPointerX);
      const movedY = Math.abs(event.clientY - this.#startPointerY);
      return movedX >= this.#threshold || movedY >= this.#threshold;
    }
  }

  /**
   * Limits a number to a range.
   * @param {number} value The number.
   * @param {number} minimum Lower bound.
   * @param {number} maximum Upper bound.
   * @returns {number} The value, raised to the minimum or lowered to the maximum if outside the range.
   */
  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  /**
   * Zooms an image with the mouse wheel over its frame and pans it by dragging, through a CSS transform.
   */
  class ImageZoomPan {
    /**
     * Factor applied to the scale per wheel step.
     * @type {number}
     */
    static #ZOOM_STEP = 1.15;

    /**
     * Smallest scale; the image's fitted size.
     * @type {number}
     */
    static #MIN_SCALE = 1;

    /**
     * Largest scale.
     * @type {number}
     */
    static #MAX_SCALE = 8;

    /**
     * The transformed image.
     * @type {HTMLImageElement}
     */
    #image;

    /**
     * Current scale.
     * @type {number}
     */
    #scale = ImageZoomPan.#MIN_SCALE;

    /**
     * Current horizontal offset in pixels.
     * @type {number}
     */
    #offsetX = 0;

    /**
     * Current vertical offset in pixels.
     * @type {number}
     */
    #offsetY = 0;

    /**
     * Makes an image zoomable and pannable.
     * @param {HTMLElement} frame Element receiving the wheel events.
     * @param {HTMLImageElement} image The image to transform.
     */
    constructor(frame, image) {
      this.#image = image;
      frame.addEventListener('wheel', event => this.#zoom(event), { passive: false });
      image.addEventListener('mousedown', event => this.#startPan(event));
    }

    /**
     * Zooms one step in or out, keeping the offset proportional to the scale.
     * @param {WheelEvent} event The wheel event.
     * @returns {void}
     */
    #zoom(event) {
      event.preventDefault();
      const stepFactor = event.deltaY < 0 ? ImageZoomPan.#ZOOM_STEP : 1 / ImageZoomPan.#ZOOM_STEP;
      const nextScale = clamp(this.#scale * stepFactor, ImageZoomPan.#MIN_SCALE, ImageZoomPan.#MAX_SCALE);
      const scaleRatio = nextScale / this.#scale;
      this.#scale = nextScale;
      this.#moveTo(this.#offsetX * scaleRatio, this.#offsetY * scaleRatio);
    }

    /**
     * Pans the image along with the pointer until the button is released.
     * @param {MouseEvent} startEvent The mousedown on the image.
     * @returns {void}
     */
    #startPan(startEvent) {
      startEvent.preventDefault();
      const startOffsetX = this.#offsetX;
      const startOffsetY = this.#offsetY;
      new DragGesture(startEvent, {
        threshold: 0,
        onMove: event => this.#moveTo(startOffsetX + event.clientX - startEvent.clientX, startOffsetY + event.clientY - startEvent.clientY),
        onEnd: () => undefined,
      });
    }

    /**
     * Sets the offset and applies the transform.
     * @param {number} offsetX Horizontal offset in pixels.
     * @param {number} offsetY Vertical offset in pixels.
     * @returns {void}
     */
    #moveTo(offsetX, offsetY) {
      this.#offsetX = offsetX;
      this.#offsetY = offsetY;
      this.#image.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${this.#scale})`;
    }
  }

  var stylesheet$n = ".claude-plus-image-viewer-overlay {\r\n  position: fixed;\r\n  inset: 0;\r\n  z-index: var(--claude-plus-layer-drag-label);\r\n  background: rgba(0, 0, 0, 0.8);\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: center;\r\n  justify-content: center;\r\n  gap: 12px;\r\n}\r\n\r\n.claude-plus-image-viewer__frame {\r\n  max-width: 90vw;\r\n  max-height: 90vh;\r\n  overflow: hidden;\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n}\r\n\r\n.claude-plus-image-viewer__image {\r\n  max-width: 90vw;\r\n  max-height: 90vh;\r\n  width: auto;\r\n  height: auto;\r\n  cursor: grab;\r\n  user-select: none;\r\n}\r\n\r\n.claude-plus-image-viewer__open-button {\r\n  flex-shrink: 0;\r\n}\r\n";

  StyleRegistry.register(stylesheet$n);

  /**
   * Shows an image at full size over a dark backdrop, capped at 90% of the viewport. Scrolling zooms;
   * dragging pans. A button below opens the same image in a new browser tab.
   */
  class ImageViewerDialog extends Dialog {
    /**
     * Image URL.
     * @type {string}
     */
    #imageUrl;

    /**
     * Alt text of the image.
     * @type {string}
     */
    #altText;

    /**
     * Creates the viewer without showing it.
     * @param {string} imageUrl Image URL.
     * @param {string} altText Alt text of the image.
     */
    constructor(imageUrl, altText) {
      super();
      this.#imageUrl = imageUrl;
      this.#altText = altText;
    }

    /**
     * CSS class of the dark overlay stacking the image and the button.
     * @returns {string} The class name.
     */
    get overlayClassName() {
      return 'claude-plus-image-viewer-overlay';
    }

    /**
     * Builds the zoomable image frame and the button opening the image in a new tab.
     * @returns {HTMLElement[]} The frame and the button.
     */
    createContent() {
      const image = createElement('img', { className: 'claude-plus-image-viewer__image', src: this.#imageUrl, alt: this.#altText });
      const frame = createElement('div', { className: 'claude-plus-image-viewer__frame' });
      frame.append(image);
      new ImageZoomPan(frame, image);
      const openButton = createElement('button', {
        className: 'claude-plus-toolbar__button claude-plus-image-viewer__open-button',
        textContent: 'Open in new window',
      });
      openButton.addEventListener('click', () => window.open(this.#imageUrl, '_blank', 'noopener'));
      return [frame, openButton];
    }
  }

  /**
   * Tool names claude.ai treats as interactive display widgets rather than ordinary tool calls; a
   * call to one of these renders as a card inline in the message, not hidden in its "thinking and
   * tool calls" sub-pane like an ordinary tool call.
   * @type {ReadonlyArray<string>}
   */
  const WIDGET_TOOL_NAMES = Object.freeze([
    'weather_fetch',
    'recipe_display_v0',
    'places_map_display_v0',
    'message_compose_v1',
    'ask_user_input_v0',
    'recommend_claude_apps',
    'show_recommendation_cards',
    'chart_display_v0',
    'places_search',
    'fetch_sports_data',
    'options_card_display_v0',
    'step_card_display_v0',
    'itinerary_display_v0',
    'translation_display_v0',
    'comparison_card_display_v0',
    'featured_card_display_v0',
    'product_carousel_display_v0',
    'link_preview_display_v0',
    'places_list_display_v0',
    'quiz_display_v0',
  ]);

  /**
   * Whether a widget tool call actually has a card to show: a known widget tool name with a
   * completed, non-error result, or an Artifact call whose real HTML was resolved at import time
   * (see ClaudeExportMapper). A call without a card to show (still streaming, a failed attempt
   * superseded by a later retry, or an Artifact with nothing resolved for it) is treated as an
   * ordinary tool call instead, so it doesn't leave an empty or duplicate slot in the chat log.
   */
  class WidgetToolCall {
    /**
     * Whether a tool call rendered a widget or Artifact card.
     * @param {ContentBlock} useBlock The tool_use block.
     * @param {?ContentBlock} resultBlock Its tool_result block, if the call has completed.
     * @returns {boolean} True when it has a card to show.
     */
    static isRendered(useBlock, resultBlock) {
      return WidgetToolCall.#isKnownWidget(useBlock, resultBlock) || WidgetToolCall.#isResolvedArtifact(useBlock, resultBlock);
    }

    /**
     * Whether a tool call is a known widget tool with a completed, non-error result.
     * @param {ContentBlock} useBlock The tool_use block.
     * @param {?ContentBlock} resultBlock Its tool_result block, if the call has completed.
     * @returns {boolean} True when it's a widget tool with a successful result.
     */
    static #isKnownWidget(useBlock, resultBlock) {
      return WIDGET_TOOL_NAMES.includes(useBlock.name) && Boolean(resultBlock) && !resultBlock.is_error;
    }

    /**
     * Whether a tool call is an Artifact publish whose real HTML was resolved at import time.
     * @param {ContentBlock} useBlock The tool_use block.
     * @param {?ContentBlock} resultBlock Its tool_result block, if the call has completed.
     * @returns {boolean} True when it's an Artifact call with resolved HTML to show.
     */
    static #isResolvedArtifact(useBlock, resultBlock) {
      return useBlock.name === 'Artifact' && Boolean(resultBlock?.structured_content?.resolvedArtifactHtml);
    }
  }

  /**
   * Groups a message's thinking, injected-prompt and ordinary tool-call content blocks into a
   * chronological list of steps — each tool call paired with its result — so a message's "thinking
   * and tool calls" sub-pane can list what happened without that ever appearing in the chat log
   * itself. A widget tool call that actually rendered a card (see WidgetToolCall) is excluded here
   * since it shows inline in the message instead (see MessageContent); one that didn't (still
   * pending, or a failed attempt superseded by a retry) is kept, same as any other tool call. An
   * injected_prompt_block (a backend-injected system/memory-snapshot reminder, seen on imported
   * conversations) is never a message a human wrote or should read inline, so it's listed here too
   * rather than in the chat log.
   */
  class MessageToolSteps {
    /**
     * Step kind produced by a content block whose whole block becomes the step, keyed by block type.
     * @type {ReadonlyMap<string, string>}
     */
    static #SIMPLE_STEP_KINDS = new Map([['thinking', 'thinking'], ['injected_prompt_block', 'injectedPrompt']]);

    /**
     * Steps of a message, in the order they happened.
     * @param {?ApiMessage} apiMessage The message; null or content-less for a local-only message.
     * @returns {Array<{kind: 'thinking', block: ContentBlock}|{kind: 'tool', useBlock: ContentBlock, resultBlock: ?ContentBlock}|{kind: 'injectedPrompt', block: ContentBlock}>}
     * The steps; empty when the message has none.
     */
    static stepsOf(apiMessage) {
      const blocks = apiMessage?.content ?? [];
      const resultByUseId = MessageToolSteps.#resultsByUseId(blocks);
      const steps = [];
      const stepByToolUseId = new Map();
      blocks.forEach(block => MessageToolSteps.#addBlock(block, steps, stepByToolUseId, resultByUseId));
      return steps;
    }

    /**
     * Tool results by the id of the call they answer.
     * @param {ContentBlock[]} blocks The message's content blocks.
     * @returns {Map<string, ContentBlock>} The results, by tool_use_id.
     */
    static #resultsByUseId(blocks) {
      return new Map(blocks.filter(block => block.type === 'tool_result').map(block => [block.tool_use_id, block]));
    }

    /**
     * Folds one content block into the steps being built.
     * @param {ContentBlock} block The block.
     * @param {Array<object>} steps Steps accumulated so far.
     * @param {Map<string, object>} stepByToolUseId Tool steps by their call's id, to attach a matching result.
     * @param {Map<string, ContentBlock>} resultByUseId Tool results by the id of the call they answer.
     * @returns {void}
     */
    static #addBlock(block, steps, stepByToolUseId, resultByUseId) {
      const simpleKind = MessageToolSteps.#SIMPLE_STEP_KINDS.get(block.type);
      if (simpleKind) steps.push({ kind: simpleKind, block });
      else if (block.type === 'tool_use' && !WidgetToolCall.isRendered(block, resultByUseId.get(block.id))) MessageToolSteps.#addToolUse(block, steps, stepByToolUseId);
      else if (block.type === 'tool_result') MessageToolSteps.#attachResult(block, stepByToolUseId);
    }

    /**
     * Starts a tool step from its call.
     * @param {ContentBlock} block A tool_use block.
     * @param {Array<object>} steps Steps accumulated so far.
     * @param {Map<string, object>} stepByToolUseId Tool steps by their call's id.
     * @returns {void}
     */
    static #addToolUse(block, steps, stepByToolUseId) {
      const step = { kind: 'tool', useBlock: block, resultBlock: null };
      steps.push(step);
      stepByToolUseId.set(block.id, step);
    }

    /**
     * Attaches a result to its matching tool step.
     * @param {ContentBlock} block A tool_result block.
     * @param {Map<string, object>} stepByToolUseId Tool steps by their call's id.
     * @returns {void}
     */
    static #attachResult(block, stepByToolUseId) {
      const step = stepByToolUseId.get(block.tool_use_id);
      if (step) step.resultBlock = block;
    }
  }

  var stylesheet$m = ".claude-plus-selection-reply {\n  position: absolute;\n  z-index: var(--claude-plus-layer-drag-label);\n  background: var(--claude-plus-color-raised);\n  border: 1px solid var(--claude-plus-color-border-strong);\n  border-radius: 6px;\n  color: var(--claude-plus-color-text);\n  cursor: pointer;\n  font-size: 12px;\n  padding: 5px 10px;\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);\n}\n\n.claude-plus-selection-reply:hover {\n  background: var(--claude-plus-color-button-hover);\n}\n";

  StyleRegistry.register(stylesheet$m);

  /**
   * The floating "Reply" button claude.ai shows above a text selection, offering to quote it.
   */
  class SelectionReplyButton {
    /**
     * The button, while shown.
     * @type {?HTMLElement}
     */
    #buttonElement = null;

    /**
     * Called when the button is clicked.
     * @type {?function(): void}
     */
    #onReply = null;

    /**
     * Shows the button above a rectangle, replacing one already shown.
     * @param {DOMRect} aboveRect Viewport rectangle to show the button above.
     * @param {function(): void} onReply Called when the button is clicked.
     * @returns {void}
     */
    show(aboveRect, onReply) {
      this.hide();
      this.#onReply = onReply;
      this.#buttonElement = createElement('button', { className: 'claude-plus-selection-reply', textContent: '↩ Reply' });
      Object.assign(this.#buttonElement.style, { left: `${aboveRect.left + window.scrollX}px`, top: `${aboveRect.top + window.scrollY}px` });
      document.body.append(this.#buttonElement);
      this.#buttonElement.style.top = `${aboveRect.top + window.scrollY - this.#buttonElement.offsetHeight - 6}px`;
      this.#buttonElement.addEventListener('mousedown', this.#handleClick);
      document.addEventListener('mousedown', this.#handleOutsidePress, true);
    }

    /**
     * Hides the button if shown.
     * @returns {void}
     */
    hide() {
      if (!this.#buttonElement) return;
      this.#buttonElement.remove();
      this.#buttonElement = null;
      this.#onReply = null;
      document.removeEventListener('mousedown', this.#handleOutsidePress, true);
    }

    /**
     * Runs the reply callback and hides the button. mousedown (not click) so it fires before the
     * document-level mousedown handler that would otherwise clear the selection first.
     * @param {MouseEvent} event The press.
     * @returns {void}
     */
    #handleClick = (event) => {
      event.preventDefault();
      const onReply = this.#onReply;
      this.hide();
      onReply();
    };

    /**
     * Hides the button when the pointer is pressed anywhere else, which also lets that press collapse
     * the selection natively instead of the button swallowing it.
     * @param {MouseEvent} event Mouse press anywhere.
     * @returns {void}
     */
    #handleOutsidePress = (event) => {
      if (!this.#buttonElement.contains(event.target)) this.hide();
    };
  }

  var stylesheet$l = ".claude-plus-message-list {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  padding: 4px 2px;\n}\n\n.claude-plus-message {\n  max-width: 78%;\n}\n\n.claude-plus-message--human {\n  align-self: flex-end;\n  text-align: right;\n}\n\n.claude-plus-message--human:not(.claude-plus-message--editing) {\n  display: flex;\n  flex-direction: column;\n  align-items: flex-end;\n}\n\n.claude-plus-message--human .claude-plus-message__actions {\n  justify-content: flex-end;\n}\n\n.claude-plus-message--assistant {\n  align-self: stretch;\n  max-width: 100%;\n}\n\n.claude-plus-message--editing {\n  max-width: 92%;\n}\n\n.claude-plus-message__attachments {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  margin-bottom: 6px;\n}\n\n.claude-plus-message--human .claude-plus-message__bubble {\n  background: var(--claude-plus-color-message-human-bg);\n  border-radius: 14px;\n  padding: 8px 12px;\n}\n\n.claude-plus-message__body {\n  font-size: var(--claude-plus-message-font-size, 14px);\n  font-family: var(--claude-plus-message-font-family, inherit);\n  line-height: 1.55;\n  overflow-wrap: break-word;\n}\n\n.claude-plus-message--assistant .claude-plus-message__body {\n  font-size: calc(var(--claude-plus-message-font-size, 14px) + 2px);\n}\n\n.claude-plus-message__actions {\n  display: flex;\n  align-items: center;\n  gap: 2px;\n  margin-top: 6px;\n  flex-wrap: wrap;\n}\n\n.claude-plus-message__action-button {\n  background: none;\n  border: none;\n  color: var(--claude-plus-color-text-muted);\n  cursor: pointer;\n  font-size: 13px;\n  line-height: 1.4;\n  padding: 4px 6px;\n  border-radius: 20px;\n}\n\n.claude-plus-message__action-button:hover {\n  background: var(--claude-plus-color-border-strong);\n  color: var(--claude-plus-color-text);\n}\n\n.claude-plus-message__action-button--primary {\n  background: var(--claude-plus-color-accent);\n  color: #fff;\n}\n\n.claude-plus-message__action-button--primary:hover {\n  background: var(--claude-plus-color-accent);\n  filter: brightness(1.1);\n}\n\n.claude-plus-message__branch-nav {\n  display: inline-flex;\n  align-items: center;\n  gap: 2px;\n  margin-right: 4px;\n  font-size: 12px;\n  color: var(--claude-plus-color-text-faint);\n}\n\n.claude-plus-message__branch-nav-button {\n  background: none;\n  border: none;\n  color: inherit;\n  cursor: pointer;\n  font-size: 15px;\n  line-height: 1;\n  padding: 4px 6px;\n  border-radius: 20px;\n}\n\n.claude-plus-message__branch-nav-button:hover:not(:disabled) {\n  background: var(--claude-plus-color-border-strong);\n  color: var(--claude-plus-color-text);\n}\n\n.claude-plus-message__branch-nav-button:disabled {\n  opacity: 0.35;\n  cursor: default;\n}\n\n.claude-plus-message__branch-nav-count {\n  min-width: 28px;\n  text-align: center;\n}\n\n.claude-plus-message__edit-input {\n  width: 100%;\n  box-sizing: border-box;\n  resize: vertical;\n  min-height: 60px;\n  border-radius: 10px;\n  padding: 8px 10px;\n  font: inherit;\n  font-size: var(--claude-plus-message-font-size, 14px);\n  line-height: 1.5;\n  text-align: left;\n  background: var(--claude-plus-color-bar);\n  border: 1px solid var(--claude-plus-color-border-strong);\n  color: var(--claude-plus-color-text);\n}\n\n.claude-plus-message-error {\n  color: var(--claude-plus-color-error);\n  margin-top: 6px;\n}\n\n.claude-plus-streaming-cursor {\n  animation: claude-plus-blink 1s step-start infinite;\n}\n\n@keyframes claude-plus-blink {\n  50% {\n    opacity: 0;\n  }\n}\n\n.claude-plus-message--highlighted {\n  outline: 2px solid var(--claude-plus-color-accent);\n  outline-offset: 4px;\n  border-radius: 14px;\n}\n";

  StyleRegistry.register(stylesheet$l);

  /**
   * The messages of a chat session: copy, retry, branch navigation between a message's edits and
   * retries, and double-click (or the edit button) to edit a human message, which sends the new text
   * as a sibling branch. Selecting text offers a Reply button that requests a quote of it for the
   * next prompt. Streaming updates re-render only the affected message, at most once per animation
   * frame.
   */
  class MessageListView {
    /**
     * Gap between messages, in pixels; matches the list's CSS.
     * @type {number}
     */
    static #MESSAGE_GAP = 10;

    /**
     * Height assumed for a message until some have been measured, in pixels.
     * @type {number}
     */
    static #ESTIMATED_MESSAGE_HEIGHT = 110;

    /**
     * List element the messages are rendered into.
     * @type {HTMLElement}
     */
    #listElement;

    /**
     * Session whose messages are shown.
     * @type {ChatSession}
     */
    #session;

    /**
     * Messages whose content changed since the last frame.
     * @type {Set<ChatMessage>}
     */
    #changedMessages = new Set();

    /**
     * Batches message updates per frame.
     * @type {FrameScheduler}
     */
    #updateScheduler = new FrameScheduler(() => this.#renderChangedMessages());

    /**
     * Position of the message being edited, or null while none is.
     * @type {?number}
     */
    #editingIndex = null;

    /**
     * Handler per data-action value.
     * @type {Map<string, function(HTMLElement): void>}
     */
    #actionHandlers = new Map([
      ['retry', () => this.#session.retryLastPrompt()],
      ['copy', button => this.#copyMessageText(button)],
      ['openImage', image => new ImageViewerDialog(image.dataset.fullSrc, image.alt).show()],
      ['startEdit', button => this.#startEdit(MessageListView.#indexOf(button))],
      ['cancelEdit', () => this.#cancelEdit()],
      ['saveEdit', button => this.#commitEdit(button.closest('.claude-plus-message'))],
      ['prevBranch', button => this.#switchBranch(button, -1)],
      ['nextBranch', button => this.#switchBranch(button, 1)],
      ['toolSteps', button => this.#showToolSteps(button)],
    ]);

    /**
     * Called with a message to show its thinking and tool-call steps.
     * @type {function(ChatMessage): void}
     */
    #onShowToolSteps;

    /**
     * Fills a widget's placeholder slot with its real, extracted card.
     * @type {WidgetExtractor}
     */
    #widgetExtractor;

    /**
     * The floating "Reply" button shown above a text selection.
     * @type {SelectionReplyButton}
     */
    #replyButton = new SelectionReplyButton();

    /**
     * Renders only the messages near the visible area, however long the conversation is.
     * @type {VirtualList}
     */
    #virtualList;

    /**
     * Position of the message offering Retry, or -1 for none; decided once per render so messages
     * created later, as the list scrolls, agree with the ones created then.
     * @type {number}
     */
    #retryableIndex = -1;

    /**
     * Position of the message highlighted after a jump to it, or -1 for none; kept here rather than
     * only on the element because the element is recreated whenever the list lays out again.
     * @type {number}
     */
    #highlightedIndex = -1;

    /**
     * Timer that removes the current highlight.
     * @type {?number}
     */
    #highlightTimer = null;

    /**
     * Marks the in-chat search's matches in the rendered messages.
     * @type {ChatFindHighlighter}
     */
    #findHighlighter = new ChatFindHighlighter();

    /**
     * Expression of the in-chat search being shown, or null while there is none.
     * @type {?RegExp}
     */
    #findRegex = null;

    /**
     * The in-chat search's current match, or null for none.
     * @type {?{messageIndex: number, ordinal: number}}
     */
    #findHit = null;

    /**
     * The conversation the list last rendered, to notice a different one.
     * @type {?string|undefined}
     */
    #renderedConversationId;

    /**
     * Wires the view to its list element and session.
     * @param {Panel} ownerPanel Panel owning the subscriptions.
     * @param {HTMLElement} listElement List element the messages are rendered into.
     * @param {ChatSession} session Session whose messages are shown.
     * @param {function(ChatMessage): void} onShowToolSteps Called with a message to show its thinking and tool-call steps.
     * @param {WidgetExtractor} widgetExtractor Fills a widget's placeholder slot with its real, extracted card.
     */
    constructor(ownerPanel, listElement, session, onShowToolSteps, widgetExtractor) {
      this.#listElement = listElement;
      this.#session = session;
      this.#onShowToolSteps = onShowToolSteps;
      this.#widgetExtractor = widgetExtractor;
      this.#virtualList = this.#createVirtualList();
      listElement.addEventListener('click', event => this.#onClick(event));
      listElement.addEventListener('dblclick', event => this.#onDoubleClick(event));
      listElement.addEventListener('keydown', event => this.#onEditKeydown(event));
      listElement.addEventListener('mouseup', () => this.#onSelectionMaybeChanged());
      listElement.addEventListener('scroll', () => this.#replyButton.hide());
      ownerPanel.listenTo(session, 'messages', () => this.render());
      ownerPanel.listenTo(session, 'sending', () => this.render());
      ownerPanel.listenTo(session, 'messageContent', message => this.#scheduleMessageUpdate(message));
    }

    /**
     * Re-renders the messages near the visible area, keeping the view at the bottom if it was there
     * and starting at the bottom for a different conversation.
     * @returns {void}
     */
    render() {
      this.#changedMessages.clear();
      this.#updateScheduler.cancel();
      this.#replyButton.hide();
      const messages = this.#session.messages;
      this.#retryableIndex = this.#session.isSending || this.#session.isReadOnly ? -1 : messages.findLastIndex(message => message.sender === 'assistant');
      this.#resetForNewConversation();
      this.#virtualList.setCount(messages.length);
      this.#focusEditInputIfEditing();
    }

    /**
     * Stops following the list's scrolling and size.
     * @returns {void}
     */
    dispose() {
      this.#findHighlighter.clear();
      this.#virtualList.dispose();
    }

    /**
     * Shows an in-chat search's matches in the messages that are rendered now and in any that are
     * rendered later, as the list scrolls; without an expression, shows none.
     * @param {?RegExp} regex The global expression to mark, or null to stop marking.
     * @param {?{messageIndex: number, ordinal: number}} currentHit The match to mark as current, if any.
     * @returns {void}
     */
    showFind(regex, currentHit) {
      this.#findRegex = regex;
      this.#findHit = currentHit;
      this.#paintFind();
    }

    /**
     * Scrolls an in-chat search match to the middle of the view, whichever message it is in.
     * @param {{messageIndex: number, ordinal: number}} hit The match.
     * @returns {void}
     */
    revealFindHit(hit) {
      this.#findHit = hit;
      this.#virtualList.scrollToIndex(hit.messageIndex, 'center');
      this.#centerFindHit();
      requestAnimationFrame(() => this.#centerFindHit());
    }

    /**
     * Position of the first message that is at least partly in view.
     * @returns {number} The position; 0 when none is rendered.
     */
    firstVisibleIndex() {
      const top = this.#listElement.getBoundingClientRect().top;
      const visible = [...this.#listElement.querySelectorAll('[data-message-index]')].find(element => element.getBoundingClientRect().bottom > top);
      return visible ? Number(visible.dataset.messageIndex) : 0;
    }

    /**
     * Repaints the search matches and scrolls the current one into the middle of the view.
     * @returns {void}
     */
    #centerFindHit() {
      const range = this.#paintFind();
      if (!range) return;
      const rect = range.getBoundingClientRect();
      const listRect = this.#listElement.getBoundingClientRect();
      this.#listElement.scrollTop += rect.top + rect.height / 2 - (listRect.top + listRect.height / 2);
    }

    /**
     * Marks the search's matches in the rendered messages.
     * @returns {?Range} The current match's range, when it is in a rendered message.
     */
    #paintFind() {
      if (!this.#findRegex) {
        this.#findHighlighter.clear();
        return null;
      }
      const bodies = [...this.#listElement.querySelectorAll('[data-message-index] .claude-plus-message__body')];
      const messages = bodies.map(body => ({ body, messageIndex: Number(body.closest('[data-message-index]').dataset.messageIndex) }));
      return this.#findHighlighter.paint(messages, this.#findRegex, this.#findHit);
    }

    /**
     * The windowed list rendering the messages into the list element.
     * @returns {VirtualList} The list.
     */
    #createVirtualList() {
      return new VirtualList({
        scrollElement: this.#listElement,
        contentElement: this.#listElement,
        gap: MessageListView.#MESSAGE_GAP,
        estimatedHeight: MessageListView.#ESTIMATED_MESSAGE_HEIGHT,
        renderItems: (start, end) => this.#messagesHtml(start, end),
        emptyHtml: () => '<div class="claude-plus-empty-state claude-plus-empty-state--padded">Start a conversation using the message box below.</div>',
        onItemsRendered: (elements, from) => this.#onMessagesRendered(elements, from),
        followsEnd: true,
        endDistance: LIMITS.followOutputDistance,
      });
    }

    /**
     * Forgets the measured message heights when the list now shows a different conversation.
     * @returns {void}
     */
    #resetForNewConversation() {
      const conversationId = this.#session.openConversationId;
      if (conversationId === this.#renderedConversationId) return;
      this.#renderedConversationId = conversationId;
      this.#highlightedIndex = -1;
      this.#virtualList.reset();
    }

    /**
     * HTML of a run of messages.
     * @param {number} start Index of the first message.
     * @param {number} end Index after the last message.
     * @returns {string} The messages.
     */
    #messagesHtml(start, end) {
      const messages = this.#session.messages;
      let html = '';
      for (let index = start; index < end; index += 1) html += this.#messageHtml(messages[index], index, index === this.#retryableIndex);
      return html;
    }

    /**
     * Starts filling the widget slots of messages that just entered the window.
     * @param {HTMLElement[]} elements The new message elements.
     * @param {number} from Position of the first one.
     * @returns {void}
     */
    #onMessagesRendered(elements, from) {
      elements.forEach((element, offset) => {
        this.#fillWidgetSlotsIn(element, this.#session.messages[from + offset]);
        element.classList.toggle('claude-plus-message--highlighted', from + offset === this.#highlightedIndex);
      });
      this.#paintFind();
    }

    /**
     * Scrolls a message into view and briefly highlights it, if it's part of the branch shown; does
     * nothing when it belongs to a different branch (an edit or retry from before this conversation
     * was exported), rather than switching branches to find it.
     * @param {string} messageId Message id.
     * @returns {void}
     */
    scrollToMessage(messageId) {
      const index = this.#session.messages.findIndex(message => message.id === messageId);
      if (index === -1) return;
      this.#virtualList.scrollToIndex(index, 'center');
      this.#highlight(index);
    }

    /**
     * Highlights a message for TIMING.messageHighlightMs, surviving the list laying out again.
     * @param {number} index Position of the message.
     * @returns {void}
     */
    #highlight(index) {
      this.#removeHighlight();
      this.#highlightedIndex = index;
      this.#virtualList.elementAt(index)?.classList.add('claude-plus-message--highlighted');
      this.#highlightTimer = setTimeout(() => this.#removeHighlight(), TIMING.messageHighlightMs);
    }

    /**
     * Removes the current highlight, if any, and its timer.
     * @returns {void}
     */
    #removeHighlight() {
      clearTimeout(this.#highlightTimer);
      const index = this.#highlightedIndex;
      this.#highlightedIndex = -1;
      if (index >= 0) this.#virtualList.elementAt(index)?.classList.remove('claude-plus-message--highlighted');
    }

    /**
     * Queues a message for re-rendering on the next frame.
     * @param {ChatMessage} message The changed message.
     * @returns {void}
     */
    #scheduleMessageUpdate(message) {
      this.#changedMessages.add(message);
      this.#updateScheduler.schedule();
    }

    /**
     * Re-renders the queued messages.
     * @returns {void}
     */
    #renderChangedMessages() {
      this.#changedMessages.forEach(message => this.#renderMessageBody(message));
      this.#changedMessages.clear();
      this.#virtualList.keepEndInView();
    }

    /**
     * Re-renders one message's body, if it is still shown.
     * @param {ChatMessage} message The message.
     * @returns {void}
     */
    #renderMessageBody(message) {
      const index = this.#session.messages.indexOf(message);
      const container = this.#listElement.querySelector(`[data-message-index="${index}"]`);
      if (!container) return;
      const body = container.querySelector('.claude-plus-message__body');
      if (body) body.innerHTML = MessageListView.#messageBodyHtml(message);
      this.#fillWidgetSlotsIn(container, message);
      this.#paintFind();
    }

    /**
     * Starts filling one message's widget slots with their real cards.
     * @param {HTMLElement} container The message's element.
     * @param {ChatMessage} message The message.
     * @returns {void}
     */
    #fillWidgetSlotsIn(container, message) {
      const conversationId = this.#session.openConversationId;
      message.widgets.forEach(job => this.#fillWidgetSlot(container, conversationId, job));
    }

    /**
     * Fills one widget's placeholder slot with its real, extracted card.
     * @param {HTMLElement} container The message's element.
     * @param {?string} conversationId Conversation the widget's message belongs to.
     * @param {{toolName: string, data: object, toolUseId: string}} job The widget to render.
     * @returns {void}
     */
    #fillWidgetSlot(container, conversationId, job) {
      const slot = container.querySelector(`[data-widget-key="${CSS.escape(job.toolUseId)}"]`);
      if (slot) this.#widgetExtractor.render(slot, conversationId, job);
    }

    /**
     * HTML of one message: its edit form while being edited, else its bubble with actions.
     * @param {ChatMessage} message The message.
     * @param {number} index Position in the list.
     * @param {boolean} offersRetry Whether to offer retry on it.
     * @returns {string} The message.
     */
    #messageHtml(message, index, offersRetry) {
      if (index === this.#editingIndex) return MessageListView.#editingMessageHtml(message, index);
      const sender = message.sender === 'human' ? 'human' : 'assistant';
      const bodyHtml = MessageListView.#messageBodyHtml(message);
      return `
      <div class="claude-plus-message claude-plus-message--${sender}" data-message-index="${index}">
        ${MessageListView.#attachmentsHtmlOrEmpty(message)}
        ${bodyHtml ? `<div class="claude-plus-message__bubble"><div class="claude-plus-message__body">${bodyHtml}</div></div>` : ''}
        ${this.#actionsHtmlOrEmpty(sender, message, offersRetry)}
      </div>`;
    }

    /**
     * HTML of a message's uploads, shown above it rather than inside it.
     * @param {ChatMessage} message The message.
     * @returns {string} The uploads, wrapped in their own container; an empty string when there are none.
     */
    static #attachmentsHtmlOrEmpty(message) {
      return message.attachmentsHtml ? `<div class="claude-plus-message__attachments">${message.attachmentsHtml}</div>` : '';
    }

    /**
     * A message's action row, or an empty string while it is still streaming.
     * @param {'human'|'assistant'} sender The message's sender.
     * @param {ChatMessage} message The message.
     * @param {boolean} offersRetry Whether to include retry.
     * @returns {string} The action row, or an empty string.
     */
    #actionsHtmlOrEmpty(sender, message, offersRetry) {
      if (message.isStreaming) return '';
      const branchInfo = message.isPersisted ? this.#session.branchInfoFor(message.id) : null;
      return this.#actionsHtml(sender, message, offersRetry, branchInfo);
    }

    /**
     * HTML of a human message's inline edit form: an editable copy of its text, and Cancel/Save.
     * @param {ChatMessage} message The message.
     * @param {number} index Position in the list.
     * @returns {string} The form.
     */
    static #editingMessageHtml(message, index) {
      return `
      <div class="claude-plus-message claude-plus-message--human claude-plus-message--editing" data-message-index="${index}">
        ${MessageListView.#attachmentsHtmlOrEmpty(message)}
        <textarea class="claude-plus-message__edit-input" data-name="editInput">${escapeHtml(message.text)}</textarea>
        <div class="claude-plus-message__actions">
          <button class="claude-plus-message__action-button" data-action="cancelEdit">Cancel</button>
          <button class="claude-plus-message__action-button claude-plus-message__action-button--primary" data-action="saveEdit">Save &amp; branch</button>
        </div>
      </div>`;
    }

    /**
     * HTML of a message's action row: branch navigation, copy, edit (human only) and retry.
     * @param {'human'|'assistant'} sender The message's sender.
     * @param {ChatMessage} message The message.
     * @param {boolean} offersRetry Whether to include retry.
     * @param {?{index: number, count: number}} branchInfo Its sibling position, if it has siblings.
     * @returns {string} The action row.
     */
    #actionsHtml(sender, message, offersRetry, branchInfo) {
      const branchNavHtml = branchInfo ? MessageListView.#branchNavHtml(branchInfo) : '';
      const editButton = this.#editButtonHtml(sender, message);
      const retryButton = offersRetry ? '<button class="claude-plus-message__action-button" data-action="retry" title="Retry">🔁</button>' : '';
      const toolStepsButton = MessageListView.#toolStepsButtonHtml(message);
      return `
      <div class="claude-plus-message__actions">
        ${branchNavHtml}
        <button class="claude-plus-message__action-button" data-action="copy" title="Copy">📋</button>
        ${editButton}
        ${retryButton}
        ${toolStepsButton}
      </div>`;
    }

    /**
     * The edit-and-branch button, for a persisted human message in a conversation that isn't read-only.
     * @param {'human'|'assistant'} sender The message's sender.
     * @param {ChatMessage} message The message.
     * @returns {string} The button, or an empty string when it doesn't apply.
     */
    #editButtonHtml(sender, message) {
      return sender === 'human' && this.#isEditable(message)
        ? '<button class="claude-plus-message__action-button" data-action="startEdit" title="Edit and branch from here">✎</button>' : '';
    }

    /**
     * Whether a message can be edited: persisted, and not part of a read-only (imported) conversation.
     * @param {?ChatMessage} message The message.
     * @returns {boolean} True when it can be edited.
     */
    #isEditable(message) {
      return Boolean(message?.isPersisted) && !this.#session.isReadOnly;
    }

    /**
     * A lightbulb button opening the message's thinking and tool-call steps, when it has any.
     * @param {ChatMessage} message The message.
     * @returns {string} The button, or an empty string when the message has no steps.
     */
    static #toolStepsButtonHtml(message) {
      return MessageToolSteps.stepsOf(message.apiMessage).length > 0
        ? '<button class="claude-plus-message__action-button" data-action="toolSteps" title="Thinking and tool calls">💡</button>' : '';
    }

    /**
     * HTML of a branch-switch control: previous/next buttons around the sibling position.
     * @param {{index: number, count: number}} branchInfo Zero-based position and sibling count.
     * @returns {string} The control.
     */
    static #branchNavHtml({ index, count }) {
      const prevDisabled = index === 0 ? 'disabled' : '';
      const nextDisabled = index === count - 1 ? 'disabled' : '';
      return `
      <span class="claude-plus-message__branch-nav">
        <button class="claude-plus-message__branch-nav-button" data-action="prevBranch" ${prevDisabled} title="Previous version">‹</button>
        <span class="claude-plus-message__branch-nav-count">${index + 1}/${count}</span>
        <button class="claude-plus-message__branch-nav-button" data-action="nextBranch" ${nextDisabled} title="Next version">›</button>
      </span>`;
    }

    /**
     * HTML of a message's body: content, error and streaming cursor.
     * @param {ChatMessage} message The message.
     * @returns {string} The body.
     */
    static #messageBodyHtml(message) {
      const errorHtml = message.errorText ? `<div class="claude-plus-message-error">Error: ${escapeHtml(message.errorText)}</div>` : '';
      const cursorHtml = message.isStreaming ? '<span class="claude-plus-streaming-cursor">▍</span>' : '';
      return `${message.html}${errorHtml}${cursorHtml}`;
    }

    /**
     * Runs the action of a clicked button.
     * @param {MouseEvent} event Click inside the list.
     * @returns {void}
     */
    #onClick(event) {
      const button = event.target.closest('[data-action]');
      const handleAction = button ? this.#actionHandlers.get(button.dataset.action) : null;
      if (handleAction) handleAction(button);
    }

    /**
     * Shows the floating Reply button above a new, non-empty text selection inside one message, or
     * hides it otherwise.
     * @returns {void}
     */
    #onSelectionMaybeChanged() {
      const context = this.#selectionContext();
      if (context) this.#replyButton.show(context.rect, () => this.#session.requestQuote(context.text, context.sender));
      else this.#replyButton.hide();
    }

    /**
     * The current selection's text, sender and bounding rectangle, if it qualifies for a Reply button.
     * @returns {?{text: string, sender: string, rect: DOMRect}} The context, or null.
     */
    #selectionContext() {
      const selection = window.getSelection();
      if (!this.#isQuotableSelection(selection)) return null;
      const message = this.#messageAt(selection.anchorNode);
      const text = selection.toString().trim();
      return message && text ? { text, sender: message.sender, rect: selection.getRangeAt(0).getBoundingClientRect() } : null;
    }

    /**
     * Whether a selection is worth offering a Reply button for: not collapsed, inside this list, and
     * the conversation isn't read-only (there would be nothing to send the quote with).
     * @param {?Selection} selection The current selection.
     * @returns {boolean} True when it qualifies.
     */
    #isQuotableSelection(selection) {
      return !this.#session.isReadOnly && Boolean(selection) && !selection.isCollapsed && this.#listElement.contains(selection.anchorNode);
    }

    /**
     * The message a selection node belongs to.
     * @param {Node} node A node inside a message element; nodeType 3 is a text node, which has no
     * closest() of its own.
     * @returns {?ChatMessage} The message, or null when not found.
     */
    #messageAt(node) {
      const element = node.nodeType === 3 ? node.parentElement : node;
      const messageElement = element.closest('.claude-plus-message');
      return messageElement ? this.#session.messages[Number(messageElement.dataset.messageIndex)] : null;
    }

    /**
     * Starts editing the human message double-clicked on, unless it hasn't been persisted yet.
     * @param {MouseEvent} event Double-click inside the list.
     * @returns {void}
     */
    #onDoubleClick(event) {
      if (event.target.closest('[data-action], .claude-plus-message__edit-input')) return;
      const container = event.target.closest('.claude-plus-message--human');
      if (!container) return;
      const index = MessageListView.#indexOf(container);
      if (this.#isEditable(this.#session.messages[index])) this.#startEdit(index);
    }

    /**
     * Saves or cancels the edit in progress on Enter or Escape.
     * @param {KeyboardEvent} event Key press inside the list.
     * @returns {void}
     */
    #onEditKeydown(event) {
      if (!event.target.matches('.claude-plus-message__edit-input')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.#cancelEdit();
      } else if (MessageListView.#isCommitShortcut(event)) {
        event.preventDefault();
        this.#commitEdit(event.target.closest('.claude-plus-message'));
      }
    }

    /**
     * Whether a key press commits an edit in progress.
     * @param {KeyboardEvent} event The key press.
     * @returns {boolean} True for Enter without Shift outside IME composition.
     */
    static #isCommitShortcut(event) {
      return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
    }

    /**
     * Shows a message as an editable form.
     * @param {number} index Position of the message.
     * @returns {void}
     */
    #startEdit(index) {
      this.#editingIndex = index;
      this.render();
    }

    /**
     * Leaves edit mode without sending anything.
     * @returns {void}
     */
    #cancelEdit() {
      this.#editingIndex = null;
      this.render();
    }

    /**
     * Sends an edit form's text as a branch from the edited message's parent, or cancels for blank
     * text.
     * @param {HTMLElement} container The message element being edited.
     * @returns {void}
     */
    #commitEdit(container) {
      const index = MessageListView.#indexOf(container);
      const newText = container.querySelector('.claude-plus-message__edit-input').value;
      this.#editingIndex = null;
      if (newText.trim()) this.#session.editMessage(index, newText);
      else this.render();
    }

    /**
     * Focuses and places the caret at the end of the edit form's text, if one is open.
     * @returns {void}
     */
    #focusEditInputIfEditing() {
      if (this.#editingIndex === null) return;
      const input = this.#listElement.querySelector('.claude-plus-message__edit-input');
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    /**
     * Switches a message to its previous or next sibling version.
     * @param {HTMLElement} button The clicked branch-nav button.
     * @param {number} step -1 for the previous version, +1 for the next.
     * @returns {void}
     */
    #switchBranch(button, step) {
      const message = this.#session.messages[MessageListView.#indexOf(button)];
      if (message) this.#session.switchBranch(message.id, step);
    }

    /**
     * Shows a message's thinking and tool-call steps.
     * @param {HTMLElement} button The clicked lightbulb button.
     * @returns {void}
     */
    #showToolSteps(button) {
      const message = this.#session.messages[MessageListView.#indexOf(button)];
      if (message) this.#onShowToolSteps(message);
    }

    /**
     * Position encoded in the closest message element's data-message-index.
     * @param {HTMLElement} descendant An element inside, or equal to, a message element.
     * @returns {number} The position.
     */
    static #indexOf(descendant) {
      return Number(descendant.closest('.claude-plus-message').dataset.messageIndex);
    }

    /**
     * Copies a message's text to the clipboard and briefly shows a check mark.
     * @param {HTMLElement} button The copy button.
     * @returns {void}
     */
    #copyMessageText(button) {
      const message = this.#session.messages[MessageListView.#indexOf(button)];
      navigator.clipboard.writeText(MessageListView.#copyableText(message)).catch(() => undefined);
      const label = button.textContent;
      button.textContent = '✓';
      setTimeout(() => { button.textContent = label; }, TIMING.copyFeedbackMs);
    }

    /**
     * Text copied for a message.
     * @param {?ChatMessage} message The message.
     * @returns {string} Its text, else its error, else an empty string.
     */
    static #copyableText(message) {
      return message ? message.text || message.errorText || '' : '';
    }

  }

  var stylesheet$k = ".claude-plus-tool-steps {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 2px;\n}\n\n.claude-plus-tool-step {\n  background: var(--claude-plus-color-tool-details);\n  border-radius: 6px;\n  padding: 6px 8px;\n  font-size: 12px;\n}\n\n.claude-plus-tool-step--error {\n  box-shadow: inset 2px 0 0 var(--claude-plus-color-error);\n}\n\n.claude-plus-tool-step summary {\n  cursor: pointer;\n  font-weight: 600;\n}\n\n.claude-plus-tool-step__summaries {\n  margin: 6px 0 0;\n  padding-left: 18px;\n  color: var(--claude-plus-color-text-muted);\n}\n\n.claude-plus-tool-step__field-label {\n  margin-top: 8px;\n  font-size: 11px;\n  font-weight: 600;\n  color: var(--claude-plus-color-text-faint);\n  text-transform: uppercase;\n  letter-spacing: 0.03em;\n}\n\n.claude-plus-tool-step__pre {\n  margin: 2px 0 0;\n  white-space: pre-wrap;\n  overflow-wrap: break-word;\n  font-size: 11px;\n  color: var(--claude-plus-color-text-muted);\n}\n\n.claude-plus-tool-step__result-status {\n  margin-top: 8px;\n  font-weight: 600;\n}\n";

  StyleRegistry.register(stylesheet$k);

  /**
   * A sub-pane showing one message's thinking and tool-call steps, chronologically, each collapsed
   * until expanded. It can be docked to the pane's left, top or right edge and closed. Clicking a
   * different message's lightbulb button swaps its content via showMessage rather than opening
   * another instance.
   */
  class MessageToolStepsPane {
    /**
     * The sub-pane's root element.
     * @type {HTMLElement}
     */
    #element;

    /**
     * Message whose steps are shown.
     * @type {ChatMessage}
     */
    #message;

    /**
     * Builds the sub-pane for a message.
     * @param {object} options Sub-pane options.
     * @param {ChatMessage} options.message Message whose steps to show.
     * @param {function(): void} options.onClose Called when × is clicked.
     * @param {function(string): void} options.onMove Called with 'left', 'top' or 'right' when an arrow is clicked.
     */
    constructor({ message, onClose, onMove }) {
      this.#message = message;
      this.#element = createElement('section', { className: 'claude-plus-subpane' });
      this.#element.addEventListener('click', event => this.#onClick(event, onClose, onMove));
      this.render();
    }

    /**
     * The sub-pane's root element.
     * @returns {HTMLElement} The element.
     */
    get element() {
      return this.#element;
    }

    /**
     * Id of the message currently shown.
     * @returns {string} The message id.
     */
    get messageId() {
      return this.#message.id;
    }

    /**
     * Shows another message's steps instead, without recreating the sub-pane.
     * @param {ChatMessage} message The message to show.
     * @returns {void}
     */
    showMessage(message) {
      this.#message = message;
      this.render();
    }

    /**
     * Renders the header and the message's steps.
     * @returns {void}
     */
    render() {
      const steps = MessageToolSteps.stepsOf(this.#message.apiMessage);
      const stepsHtml = steps.map(step => MessageToolStepsPane.#stepHtml(step)).join('')
        || '<div class="claude-plus-empty-state">This message has no recorded steps.</div>';
      this.#element.innerHTML = `${SubPaneHeader.html('💡 Thinking & tool calls')}<div class="claude-plus-scrollable claude-plus-fill-remaining claude-plus-tool-steps">${stepsHtml}</div>`;
    }

    /**
     * Removes the sub-pane.
     * @returns {void}
     */
    dispose() {
      this.#element.remove();
    }

    /**
     * Runs a header click; other clicks are ignored.
     * @param {MouseEvent} event Click inside the sub-pane.
     * @param {function(): void} onClose Close callback.
     * @param {function(string): void} onMove Redock callback.
     * @returns {void}
     */
    #onClick(event, onClose, onMove) {
      if (event.target.closest('header')) SubPaneHeader.onClick(event, onClose, onMove);
    }

    /**
     * HTML of one step: a thinking pass or a tool call.
     * @param {{kind: string}} step The step.
     * @returns {string} The HTML.
     */
    static #stepHtml(step) {
      if (step.kind === 'thinking') return MessageToolStepsPane.#thinkingStepHtml(step);
      if (step.kind === 'injectedPrompt') return MessageToolStepsPane.#injectedPromptStepHtml(step);
      return MessageToolStepsPane.#toolStepHtml(step);
    }

    /**
     * HTML of a thinking step: its summaries as the always-visible line, its raw text (if kept) when expanded.
     * @param {{block: ContentBlock}} step The thinking step.
     * @returns {string} The HTML.
     */
    static #thinkingStepHtml({ block }) {
      const summaries = (block.summaries ?? []).map(entry => entry.summary).filter(Boolean);
      const headline = escapeHtml(summaries[0] ?? 'Thinking');
      const restHtml = summaries.length > 1 ? `<ul class="claude-plus-tool-step__summaries">${summaries.slice(1).map(summary => `<li>${escapeHtml(summary)}</li>`).join('')}</ul>` : '';
      const rawHtml = block.thinking ? `<pre class="claude-plus-tool-step__pre">${escapeHtml(block.thinking)}</pre>` : '';
      return `
      <details class="claude-plus-tool-step">
        <summary>💭 ${headline}</summary>
        ${restHtml}${rawHtml}
      </details>`;
    }

    /**
     * HTML of an injected-prompt step: a backend-injected system/memory-snapshot reminder, collapsed
     * behind its raw text like a thinking step's.
     * @param {{block: ContentBlock}} step The injected-prompt step.
     * @returns {string} The HTML.
     */
    static #injectedPromptStepHtml({ block }) {
      return `
      <details class="claude-plus-tool-step">
        <summary>🧾 Injected system reminder</summary>
        <pre class="claude-plus-tool-step__pre">${escapeHtml(block.prompt || '')}</pre>
      </details>`;
    }

    /**
     * HTML of a tool step: its name or description as the always-visible line, its input and result when expanded.
     * @param {{useBlock: ContentBlock, resultBlock: ?ContentBlock}} step The tool step.
     * @returns {string} The HTML.
     */
    static #toolStepHtml({ useBlock, resultBlock }) {
      const isError = MessageToolStepsPane.#isErrorResult(resultBlock);
      const icon = isError ? '⚠️' : '🔧';
      const errorClass = isError ? ' claude-plus-tool-step--error' : '';
      const toolName = MessageToolStepsPane.#toolName(useBlock);
      const headline = escapeHtml(MessageToolStepsPane.#toolHeadline(useBlock, toolName));
      const inputHtml = MessageToolStepsPane.#inputFieldsHtml(useBlock.input ?? {});
      const resultHtml = resultBlock ? MessageToolStepsPane.#resultHtml(resultBlock) : '';
      return `
      <details class="claude-plus-tool-step${errorClass}">
        <summary>${icon} ${escapeHtml(toolName)}: ${headline}</summary>
        ${inputHtml}${resultHtml}
      </details>`;
    }

    /**
     * Whether a tool step's result reports a failure.
     * @param {?ContentBlock} resultBlock The tool_result block, if the call has completed.
     * @returns {boolean} True when it has and is flagged as an error.
     */
    static #isErrorResult(resultBlock) {
      return Boolean(resultBlock && resultBlock.is_error);
    }

    /**
     * A tool call's name, falling back to a generic label.
     * @param {ContentBlock} useBlock The tool_use block.
     * @returns {string} The name.
     */
    static #toolName(useBlock) {
      return useBlock.name || 'tool';
    }

    /**
     * A tool call's human-readable summary: its input's description, or its name.
     * @param {ContentBlock} useBlock The tool_use block.
     * @param {string} toolName Its resolved name, for the fallback.
     * @returns {string} The summary.
     */
    static #toolHeadline(useBlock, toolName) {
      const description = useBlock.input && useBlock.input.description;
      return description || toolName;
    }

    /**
     * HTML of a tool call's input fields.
     * @param {object} input The input object.
     * @returns {string} The HTML.
     */
    static #inputFieldsHtml(input) {
      return Object.entries(input).map(([key, value]) => MessageToolStepsPane.#fieldHtml(key, value)).join('');
    }

    /**
     * HTML of one input field: a label, and either an inline value or a preformatted block for a
     * long or multi-line string, so multi-line text keeps its real line breaks instead of the
     * escaped "\n" a whole-object JSON dump would show.
     * @param {string} key Field name.
     * @param {*} value Field value.
     * @returns {string} The HTML.
     */
    static #fieldHtml(key, value) {
      const label = `<div class="claude-plus-tool-step__field-label">${escapeHtml(key)}</div>`;
      if (typeof value === 'string' && MessageToolStepsPane.#isLongText(value)) {
        return `${label}<pre class="claude-plus-tool-step__pre">${escapeHtml(value)}</pre>`;
      }
      const inlineText = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      return `${label}<pre class="claude-plus-tool-step__pre">${escapeHtml(inlineText)}</pre>`;
    }

    /**
     * Whether a string is long or multi-line enough to need its own block rather than an inline line.
     * @param {string} text The text.
     * @returns {boolean} True past 80 characters or containing a line break.
     */
    static #isLongText(text) {
      return text.length > 80 || text.includes('\n');
    }

    /**
     * HTML of a tool result: its status, then each result item.
     * @param {ContentBlock} resultBlock The tool_result block.
     * @returns {string} The HTML.
     */
    static #resultHtml(resultBlock) {
      const status = resultBlock.is_error ? '❌ Error' : '✅ Result';
      const items = Array.isArray(resultBlock.content) ? resultBlock.content : [];
      const itemsHtml = items.map(item => MessageToolStepsPane.#resultItemHtml(item)).join('');
      return `<div class="claude-plus-tool-step__result-status">${status}</div>${itemsHtml}`;
    }

    /**
     * HTML renderer per result item type.
     * @type {Map<string, function(object): string>}
     */
    static #RESULT_ITEM_RENDERERS = new Map([
      ['text', item => MessageToolStepsPane.#resultTextHtml(item.text || '')],
      ['local_resource', item => MessageToolStepsPane.#localResourceHtml(item)],
    ]);

    /**
     * HTML of one tool result item: readable text (pretty-printed if it is itself JSON), a file
     * chip for a local resource, or a JSON fallback for anything else.
     * @param {object} item The result item.
     * @returns {string} The HTML.
     */
    static #resultItemHtml(item) {
      const renderItem = MessageToolStepsPane.#RESULT_ITEM_RENDERERS.get(item.type);
      return renderItem ? renderItem(item) : MessageToolStepsPane.#fallbackResultItemHtml(item);
    }

    /**
     * HTML of a local-resource result item, shown as a plain named chip.
     * @param {object} item The result item.
     * @returns {string} The HTML.
     */
    static #localResourceHtml(item) {
      const name = item.name || item.file_path || 'file';
      return `<div class="claude-plus-message-attachment">📎 ${escapeHtml(name)}</div>`;
    }

    /**
     * HTML of a result item of an unrecognized type, as truncated JSON.
     * @param {object} item The result item.
     * @returns {string} The HTML.
     */
    static #fallbackResultItemHtml(item) {
      return `<pre class="claude-plus-tool-step__pre">${escapeHtml(JSON.stringify(item, null, 2).slice(0, LIMITS.toolResultCharacters))}</pre>`;
    }

    /**
     * HTML of a text result item: pretty-printed if it parses as JSON, else the raw text; both keep
     * real line breaks and are capped at LIMITS.toolResultCharacters.
     * @param {string} text The item's text.
     * @returns {string} The HTML.
     */
    static #resultTextHtml(text) {
      const pretty = MessageToolStepsPane.#prettyJsonOrNull(text);
      return `<pre class="claude-plus-tool-step__pre">${escapeHtml((pretty ?? text).slice(0, LIMITS.toolResultCharacters))}</pre>`;
    }

    /**
     * Re-indents a string if it parses as JSON.
     * @param {string} text Candidate JSON text.
     * @returns {?string} The pretty-printed text, or null when it isn't valid JSON.
     */
    static #prettyJsonOrNull(text) {
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return null;
      }
    }
  }

  var stylesheet$j = ".claude-plus-panel {\r\n  position: fixed;\r\n  z-index: var(--claude-plus-layer-panel);\r\n  box-sizing: border-box;\r\n  padding: 10px 12px;\r\n  overflow-y: auto;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  font-size: 13px;\r\n  background: var(--claude-plus-color-background);\r\n}\r\n\r\n.claude-plus-panel summary {\r\n  cursor: pointer;\r\n  padding: 4px 0;\r\n}\r\n\r\n.claude-plus-panel select,\r\n.claude-plus-panel input[type=text],\r\n.claude-plus-panel input[type=date],\r\n.claude-plus-panel textarea {\r\n  background: var(--claude-plus-color-bar);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  color: var(--claude-plus-color-text);\r\n  font-size: 12px;\r\n  font-family: inherit;\r\n}\r\n\r\n.claude-plus-panel__section {\r\n  padding: 8px 0;\r\n  border-bottom: 1px solid var(--claude-plus-color-hover);\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-panel__section:last-child {\r\n  border-bottom: none;\r\n}\r\n\r\n.claude-plus-spaced-above {\r\n  margin-top: 6px;\r\n}\r\n\r\n.claude-plus-hint {\r\n  color: var(--claude-plus-color-text-faint);\r\n  font-size: 11px;\r\n  margin-top: 4px;\r\n}\r\n\r\n.claude-plus-scrollable {\r\n  overflow-y: auto;\r\n}\r\n\r\n.claude-plus-fill-remaining {\r\n  flex: 1;\r\n  min-height: 0;\r\n}\r\n\r\n.claude-plus-pending {\r\n  opacity: 0.4;\r\n  pointer-events: none;\r\n}\r\n\r\n.claude-plus-primary-button {\r\n  padding: 8px;\r\n  background: var(--claude-plus-color-accent);\r\n  border: none;\r\n  border-radius: 6px;\r\n  color: #fff;\r\n  font-size: 13px;\r\n  cursor: pointer;\r\n  font-weight: 600;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-primary-button:disabled {\r\n  opacity: 0.6;\r\n  cursor: default;\r\n}\r\n\r\n.claude-plus-full-width {\r\n  width: 100%;\r\n}\r\n\r\n.claude-plus-search-input {\r\n  flex-shrink: 0;\r\n  padding: 6px 8px;\r\n}\r\n";

  StyleRegistry.register(stylesheet$j);

  /**
   * A dockable panel. Its DOM is built on first access and immediately rendered from current state,
   * so a panel opened late is never blank. Subclasses override createBodyHtml, bindEvents and
   * render, look up elements only inside their own root through elements, and subscribe through
   * listenTo so dispose can undo every subscription.
   */
  class Panel {
    /**
     * Root element, or null until first access.
     * @type {?HTMLElement}
     */
    #root = null;

    /**
     * Tab title.
     * @type {string}
     */
    #title;

    /**
     * Undoes each subscription made through listenTo.
     * @type {Array<function(): void>}
     */
    #unsubscribers = [];

    /**
     * Called when the tab's close button is clicked, or null when the panel can't be closed this way.
     * @type {?function(): void}
     */
    #closeHandler = null;

    /**
     * Creates the panel.
     * @param {string} title Tab title.
     */
    constructor(title) {
      this.#title = title;
      this.elements = {};
    }

    /**
     * Tab title.
     * @returns {string} The title.
     */
    get title() {
      return this.#title;
    }

    /**
     * Whether the DOM has been built.
     * @returns {boolean} True after the first access of element.
     */
    get isBuilt() {
      return this.#root !== null;
    }

    /**
     * Root element, built, wired and rendered on first access.
     * @returns {HTMLElement} The root.
     */
    get element() {
      if (!this.#root) this.#buildElement();
      return this.#root;
    }

    /**
     * Makes the panel closable from its tab.
     * @param {function(): void} closeHandler Called when the tab's close button is clicked.
     * @returns {void}
     */
    setCloseHandler(closeHandler) {
      this.#closeHandler = closeHandler;
    }

    /**
     * Whether the panel's tab offers a close button.
     * @returns {boolean} True once a close handler is set.
     */
    canClose() {
      return this.#closeHandler !== null;
    }

    /**
     * Handles the tab's close button.
     * @returns {void}
     */
    close() {
      if (this.#closeHandler) this.#closeHandler();
    }

    /**
     * Subscribes to an emitter for as long as the panel exists.
     * @param {EventEmitter} emitter Event source.
     * @param {string} eventName Event name.
     * @param {function(*): void} listener Called with the event payload.
     * @returns {void}
     */
    listenTo(emitter, eventName, listener) {
      this.#unsubscribers.push(emitter.subscribe(eventName, listener));
    }

    /**
     * Ends every subscription and removes the panel from the page.
     * @returns {void}
     */
    dispose() {
      this.#unsubscribers.forEach(unsubscribe => unsubscribe());
      this.#unsubscribers = [];
      if (this.#root) this.#root.remove();
    }

    /**
     * HTML of the panel body; elements used later carry a data-name attribute.
     * @returns {string} The HTML.
     */
    createBodyHtml() {
      return '';
    }

    /**
     * Attaches event listeners and subscriptions once the DOM exists.
     * @returns {void}
     */
    bindEvents() {
      return undefined;
    }

    /**
     * Updates the DOM from current state.
     * @returns {void}
     */
    render() {
      return undefined;
    }

    /**
     * Builds the root from the body HTML, collects named elements, wires and renders it.
     * @returns {void}
     */
    #buildElement() {
      this.#root = createElement('div', { className: 'claude-plus-themed claude-plus-panel', innerHTML: this.createBodyHtml() });
      this.elements = collectNamedElements(this.#root);
      this.bindEvents();
      this.render();
    }
  }

  var stylesheet$i = ".claude-plus-panel--active-among-several {\r\n  border: 1px solid var(--claude-plus-color-active-chat);\r\n  border-top: none;\r\n}\r\n\r\n.claude-plus-panel--inactive-among-several {\r\n  border: 1px solid var(--claude-plus-color-inactive-border, rgba(255, 255, 255, 0.16));\r\n  border-top: none;\r\n}\r\n\r\n.claude-plus-chat-layout {\r\n  display: flex;\r\n  gap: 8px;\r\n  flex: 1;\r\n  min-height: 0;\r\n}\r\n\r\n.claude-plus-chat-layout__center {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  flex: 1;\r\n  min-width: 0;\r\n}\r\n\r\n.claude-plus-chat-layout__side {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  width: 300px;\r\n  flex-shrink: 0;\r\n  min-height: 0;\r\n}\r\n\r\n.claude-plus-chat-layout__top {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-chat-layout__side:empty,\r\n.claude-plus-chat-layout__top:empty {\r\n  display: none;\r\n}\r\n\r\n.claude-plus-chat-layout__top .claude-plus-subpane {\r\n  height: 200px;\r\n  flex: none;\r\n}\r\n";

  StyleRegistry.register(stylesheet$i);

  /**
   * A chat pane: one session's messages, plus optional sub-panes listing the conversation's files
   * and web sources docked to its left, top or right edge. Its tab shows the conversation title; it
   * becomes the active chat when clicked, and gets a faint green border while it is active and more
   * than one chat pane is visible.
   */
  class ChatPanel extends Panel {
    /**
     * Edge a sub-pane docks to when the open conversation has no remembered choice.
     * @type {string}
     */
    static #DEFAULT_EDGE = 'right';

    /**
     * Pane id.
     * @type {string}
     */
    #paneId;

    /**
     * Session shown in this pane.
     * @type {ChatSession}
     */
    #session;

    /**
     * Shared conversation list, for the tab title.
     * @type {CombinedConversationDirectory}
     */
    #directory;

    /**
     * Chat panes, for focus and closing.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Conversation statistics, for the sub-panes.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Table settings storage, for the sub-panes.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Fills a widget's placeholder slot with its real, extracted card.
     * @type {WidgetExtractor}
     */
    #widgetExtractor;

    /**
     * The message list.
     * @type {?MessageListView}
     */
    #messageListView = null;

    /**
     * The in-chat search bar.
     * @type {?ChatFindBar}
     */
    #findBar = null;

    /**
     * Open sub-panes by kind: 'files' and 'sources' are ConversationSubPane, 'stats' (this
     * conversation's own usage stats) is a ConversationStatsSubPane, 'toolSteps' (a message's
     * thinking and tool-call steps) is a MessageToolStepsPane.
     * @type {Map<string, ConversationSubPane|ConversationStatsSubPane|MessageToolStepsPane>}
     */
    #subPanes = new Map();

    /**
     * Creates the pane's panel.
     * @param {object} services Panel dependencies.
     * @param {string} services.paneId Pane id.
     * @param {ChatSession} services.session Session shown in this pane.
     * @param {CombinedConversationDirectory} services.directory Shared conversation list, for the tab title.
     * @param {ChatPaneManager} services.paneManager Chat panes, for focus and closing.
     * @param {StatsIndex} services.stats Conversation statistics, for the sub-panes.
     * @param {Preferences} services.preferences Table settings storage, for the sub-panes.
     * @param {WidgetExtractor} services.widgetExtractor Fills a widget's placeholder slot with its real, extracted card.
     */
    constructor({ paneId, session, directory, paneManager, stats, preferences, widgetExtractor }) {
      super('Chat');
      this.#paneId = paneId;
      this.#session = session;
      this.#directory = directory;
      this.#paneManager = paneManager;
      this.#stats = stats;
      this.#preferences = preferences;
      this.#widgetExtractor = widgetExtractor;
    }

    /**
     * Tab title.
     * @returns {string} Title of the open conversation, or "New chat".
     */
    get title() {
      const conversationId = this.#session.openConversationId;
      return conversationId ? this.#directory.titleOf(conversationId) : 'New chat';
    }

    /**
     * Whether the tab offers a close button.
     * @returns {boolean} True while other panes exist.
     */
    canClose() {
      return this.#paneManager.paneCount > 1;
    }

    /**
     * Closes this pane.
     * @returns {void}
     */
    close() {
      this.#paneManager.closePane(this.#paneId);
    }

    /**
     * HTML of the panel body: side containers for sub-panes around the message list.
     * @returns {string} The layout.
     */
    createBodyHtml() {
      return `
      <div class="claude-plus-chat-layout">
        <div class="claude-plus-chat-layout__side" data-name="leftSide"></div>
        <div class="claude-plus-chat-layout__center">
          <div class="claude-plus-chat-layout__top" data-name="topSide"></div>
          <div class="claude-plus-scrollable claude-plus-fill-remaining claude-plus-message-list" data-name="messageList"></div>
          <div class="claude-plus-find-bar" data-name="findBar" hidden></div>
        </div>
        <div class="claude-plus-chat-layout__side" data-name="rightSide"></div>
      </div>`;
    }

    /**
     * Creates the message list, focuses the pane on interaction and follows focus and visibility changes.
     * @returns {void}
     */
    bindEvents() {
      this.#messageListView = new MessageListView(this, this.elements.messageList, this.#session, message => this.#showToolSteps(message), this.#widgetExtractor);
      this.#findBar = new ChatFindBar({ element: this.elements.findBar, ownerPanel: this, session: this.#session, listView: this.#messageListView, settings: new ConversationSettings(this.#preferences) });
      this.element.addEventListener('mousedown', () => this.#paneManager.focusPane(this.#paneId));
      this.element.addEventListener('focusin', () => this.#paneManager.focusPane(this.#paneId));
      this.listenTo(this.#paneManager, 'focus', () => this.#renderFocus());
      this.listenTo(this.#paneManager, 'visiblePanes', () => this.#renderFocus());
    }

    /**
     * Renders the focus markers and the messages.
     * @returns {void}
     */
    render() {
      this.#renderFocus();
      this.#messageListView.render();
    }

    /**
     * Scrolls a message into view and briefly highlights it, if it's part of the branch shown.
     * @param {string} messageId Message id.
     * @returns {void}
     */
    scrollToMessage(messageId) {
      this.#messageListView.scrollToMessage(messageId);
    }

    /**
     * Opens the in-chat search, closes it when its field already has the focus, or focuses it.
     * @returns {void}
     */
    toggleFind() {
      this.#findBar.toggle();
    }

    /**
     * Opens a sub-pane on the right edge, or closes it if one of that kind is already open.
     * @param {string} kind 'files', 'sources' or 'stats'.
     * @returns {void}
     */
    openSubPane(kind) {
      if (this.#subPanes.has(kind)) {
        this.#closeSubPane(kind);
        return;
      }
      this.#subPanes.set(kind, this.#createSubPane(kind));
      this.#dockSubPane(kind, this.#storedSubPaneEdge(kind));
    }

    /**
     * Builds a sub-pane of a kind: the conversation-scoped stats view, or the files/sources table.
     * @param {string} kind 'files', 'sources' or 'stats'.
     * @returns {ConversationSubPane|ConversationStatsSubPane} The sub-pane.
     */
    #createSubPane(kind) {
      if (kind === 'stats') {
        return new ConversationStatsSubPane({
          session: this.#session,
          stats: this.#stats,
          onClose: () => this.#closeSubPane(kind),
          onMove: edge => this.#dockSubPane(kind, edge),
        });
      }
      return new ConversationSubPane({
        kind,
        session: this.#session,
        stats: this.#stats,
        preferences: this.#preferences,
        onClose: closedKind => this.#closeSubPane(closedKind),
        onMove: (movedKind, edge) => this.#dockSubPane(movedKind, edge),
        onJumpToMessage: messageId => this.scrollToMessage(messageId),
      });
    }

    /**
     * Disposes the sub-panes and ends the subscriptions.
     * @returns {void}
     */
    dispose() {
      this.#findBar?.close();
      this.#messageListView?.dispose();
      this.#subPanes.forEach(subPane => subPane.dispose());
      this.#subPanes.clear();
      super.dispose();
    }

    /**
     * Moves a sub-pane to an edge of the pane.
     * @param {string} kind Sub-pane kind.
     * @param {string} edge 'left', 'top' or 'right'.
     * @returns {void}
     */
    #dockSubPane(kind, edge) {
      const sideElements = { left: this.elements.leftSide, top: this.elements.topSide, right: this.elements.rightSide };
      sideElements[edge].append(this.#subPanes.get(kind).element);
      this.#saveSubPaneEdge(kind, edge);
    }

    /**
     * Remembers a sub-pane's dock edge for the open conversation, so it reopens there next time;
     * skipped for a chat that hasn't been saved yet.
     * @param {string} kind Sub-pane kind.
     * @param {string} edge 'left', 'top' or 'right'.
     * @returns {void}
     */
    #saveSubPaneEdge(kind, edge) {
      const conversationId = this.#session.openConversationId;
      if (!conversationId) return;
      const stored = this.#preferences.readJson(STORAGE_KEYS.subPaneEdges) ?? {};
      stored[conversationId] = { ...stored[conversationId], [kind]: edge };
      this.#preferences.writeJson(STORAGE_KEYS.subPaneEdges, stored);
    }

    /**
     * The open conversation's remembered dock edge for a sub-pane kind.
     * @param {string} kind Sub-pane kind.
     * @returns {string} 'left', 'top' or 'right'; the default when unset or the chat is new.
     */
    #storedSubPaneEdge(kind) {
      const conversationId = this.#session.openConversationId;
      const stored = conversationId ? this.#preferences.readJson(STORAGE_KEYS.subPaneEdges)?.[conversationId] : null;
      return stored?.[kind] ?? ChatPanel.#DEFAULT_EDGE;
    }

    /**
     * Closes a sub-pane.
     * @param {string} kind Sub-pane kind.
     * @returns {void}
     */
    #closeSubPane(kind) {
      this.#subPanes.get(kind).dispose();
      this.#subPanes.delete(kind);
    }

    /**
     * Shows a message's thinking and tool-call steps: opens the tool-steps sub-pane if it's closed,
     * swaps its content in place if it's already open for a different message, or closes it if it's
     * already showing this one.
     * @param {ChatMessage} message The message whose steps to show.
     * @returns {void}
     */
    #showToolSteps(message) {
      const existing = this.#subPanes.get('toolSteps');
      if (existing?.messageId === message.id) {
        this.#closeSubPane('toolSteps');
        return;
      }
      if (existing) {
        existing.showMessage(message);
        return;
      }
      const pane = new MessageToolStepsPane({
        message,
        onClose: () => this.#closeSubPane('toolSteps'),
        onMove: edge => this.#dockSubPane('toolSteps', edge),
      });
      this.#subPanes.set('toolSteps', pane);
      this.#dockSubPane('toolSteps', this.#storedSubPaneEdge('toolSteps'));
    }

    /**
     * Marks the pane while it is the active chat, and borders every chat pane (green for the active
     * one, a faint theme-aware border for the rest) only while more than one is visible.
     * @returns {void}
     */
    #renderFocus() {
      const isActive = this.#paneManager.focusedPaneId === this.#paneId;
      const borderKind = this.#paneManager.borderKindOf(this.#paneId);
      this.element.classList.toggle('claude-plus-panel--focused', isActive);
      this.element.classList.toggle('claude-plus-panel--active-among-several', borderKind === 'active');
      this.element.classList.toggle('claude-plus-panel--inactive-among-several', borderKind === 'inactive');
    }
  }

  /**
   * Selects the branch of a conversation tree that claude.ai shows.
   */
  class ConversationTree {
    /**
     * The messages from the root to the current leaf. Falls back to every message when the tree
     * fields aren't present.
     * @param {ApiConversation} conversation The conversation.
     * @returns {ApiMessage[]} The branch, oldest first.
     */
    static currentBranch(conversation) {
      const messages = conversation.chat_messages ?? [];
      const messagesById = new Map(messages.map(message => [message.uuid, message]));
      const leafMessage = messagesById.get(conversation.current_leaf_message_uuid);
      return ConversationTree.#hasTreeFields(messages, leafMessage) ? ConversationTree.#pathToRoot(leafMessage, messagesById) : messages;
    }

    /**
     * Whether the messages carry enough information to walk the tree.
     * @param {ApiMessage[]} messages All messages.
     * @param {ApiMessage|undefined} leafMessage The current leaf, if found.
     * @returns {boolean} True when the leaf exists and every message has a parent field.
     */
    static #hasTreeFields(messages, leafMessage) {
      return Boolean(leafMessage) && messages.every(message => 'parent_message_uuid' in message);
    }

    /**
     * Follows parent links from a message to the root, stopping at a missing or repeated message.
     * @param {ApiMessage} leafMessage Starting message.
     * @param {Map<string, ApiMessage>} messagesById Every message by id.
     * @returns {ApiMessage[]} The path, root first.
     */
    static #pathToRoot(leafMessage, messagesById) {
      const path = [];
      const visitedIds = new Set();
      for (let message = leafMessage; message && !visitedIds.has(message.uuid); message = messagesById.get(message.parent_message_uuid)) {
        visitedIds.add(message.uuid);
        path.push(message);
      }
      return path.reverse();
    }

    /**
     * Every message sharing a message's parent, itself included, oldest first: the versions a
     * branch-switch control cycles through (the original and each edit or retry of it).
     * @param {ApiConversation} conversation The conversation.
     * @param {string} messageId A message in the group.
     * @returns {ApiMessage[]} The sibling group, oldest first; empty if messageId isn't found.
     */
    static siblingsOf(conversation, messageId) {
      const messages = conversation.chat_messages ?? [];
      const target = messages.find(message => message.uuid === messageId);
      if (!target) return [];
      return messages
        .filter(message => message.parent_message_uuid === target.parent_message_uuid)
        .sort((earlier, later) => (earlier.created_at ?? '').localeCompare(later.created_at ?? ''));
    }

    /**
     * The leaf reached by following each level's most recently created child from a message, so
     * switching to a sibling branch lands on its latest edit or retry rather than its first reply.
     * @param {ApiConversation} conversation The conversation.
     * @param {string} messageId Message to descend from.
     * @returns {string} The leaf message's id; messageId itself when it has no children.
     */
    static latestLeafFrom(conversation, messageId) {
      const messages = conversation.chat_messages ?? [];
      let current = messageId;
      for (
        let children = ConversationTree.#childrenOf(messages, current);
        children.length > 0;
        children = ConversationTree.#childrenOf(messages, current)
      ) {
        current = ConversationTree.#latestOf(children).uuid;
      }
      return current;
    }

    /**
     * A copy of a conversation with its current leaf switched to a different message.
     * @param {ApiConversation} conversation The conversation.
     * @param {string} leafId Message id of the new current leaf.
     * @returns {ApiConversation} The updated conversation.
     */
    static withCurrentLeaf(conversation, leafId) {
      return { ...conversation, current_leaf_message_uuid: leafId };
    }

    /**
     * Direct children of a message.
     * @param {ApiMessage[]} messages Every message of the conversation.
     * @param {string} parentId Parent message id.
     * @returns {ApiMessage[]} Its children, in no particular order.
     */
    static #childrenOf(messages, parentId) {
      return messages.filter(message => message.parent_message_uuid === parentId);
    }

    /**
     * The most recently created of a group of messages.
     * @param {ApiMessage[]} messages A non-empty group.
     * @returns {ApiMessage} The latest one.
     */
    static #latestOf(messages) {
      return messages.reduce((latest, message) => ((message.created_at ?? '') > (latest.created_at ?? '') ? message : latest));
    }
  }

  /**
   * Moves a chat session between sibling versions of a message (its edits or retried replies).
   */
  class ChatBranchSwitcher {
    /**
     * API client, persisting the chosen branch server-side.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * The session's state.
     * @type {ChatSessionState}
     */
    #state;

    /**
     * Creates the switcher.
     * @param {ClaudeApi} api API client, persisting the chosen branch server-side.
     * @param {ChatSessionState} state The session's state.
     */
    constructor(api, state) {
      this.#api = api;
      this.#state = state;
    }

    /**
     * Position of a message among its siblings, for a branch-switch control. Null when it has no
     * siblings besides itself, or before the conversation has loaded.
     * @param {string} messageId Message id.
     * @returns {?{index: number, count: number}} Its zero-based position and the sibling count, or null.
     */
    branchInfoFor(messageId) {
      const conversation = this.#state.conversation;
      if (!conversation) return null;
      const siblings = ConversationTree.siblingsOf(conversation, messageId);
      if (siblings.length <= 1) return null;
      return { index: siblings.findIndex(sibling => sibling.uuid === messageId), count: siblings.length };
    }

    /**
     * Switches to a sibling version of a message, landing on that version's latest leaf, and
     * persists the choice server-side. Ignored while sending, before the conversation has loaded,
     * or when there is no sibling in that direction.
     * @param {string} messageId Message id.
     * @param {number} step -1 for the previous version, +1 for the next.
     * @returns {Promise<void>} Resolves once switched.
     */
    async switchBranch(messageId, step) {
      const conversation = this.#state.conversation;
      if (this.#state.isSending || !conversation) return;
      const siblings = ConversationTree.siblingsOf(conversation, messageId);
      const target = siblings[siblings.findIndex(sibling => sibling.uuid === messageId) + step];
      if (!target) return;
      const leafId = ConversationTree.latestLeafFrom(conversation, target.uuid);
      await this.#api.setCurrentLeafMessage(this.#state.openConversationId, leafId);
      this.#state.showBranchOf(ConversationTree.withCurrentLeaf(this.#state.conversation, leafId));
    }
  }

  /**
   * Numbers navigations, so a response arriving for an older navigation can be recognized and dropped.
   */
  class NavigationCounter {
    /**
     * Number of the latest navigation.
     * @type {number}
     */
    #latestNavigation = 0;

    /**
     * Starts a new navigation, making every earlier one outdated.
     * @returns {number} Number identifying the new navigation.
     */
    begin() {
      this.#latestNavigation += 1;
      return this.#latestNavigation;
    }

    /**
     * Whether a navigation is still the latest one.
     * @param {number} navigation Number returned by begin().
     * @returns {boolean} True if no navigation began since.
     */
    isLatest(navigation) {
      return navigation === this.#latestNavigation;
    }
  }

  /**
   * Upload fields that may hold a display name, in order of preference.
   * @type {ReadonlyArray<string>}
   */
  const ATTACHMENT_NAME_FIELDS = Object.freeze(['file_name', 'name', 'filename', 'title']);

  var stylesheet$h = ".claude-plus-code-block {\r\n  background: var(--claude-plus-color-code-block);\r\n  padding: 8px;\r\n  border-radius: 6px;\r\n  overflow-x: auto;\r\n  font-size: 12px;\r\n}\r\n";

  StyleRegistry.register(stylesheet$h);

  /**
   * Minimal markdown renderer: fenced code blocks, inline code, bold, italic and http(s) links.
   * All other text is HTML-escaped.
   */
  class Markdown {
    /**
     * A fenced code block, with or without a language line; captures the code.
     * @type {RegExp}
     */
    static #CODE_FENCE = /```(?:[^\n`]*\n)?([\s\S]*?)```/;

    /**
     * Renders markdown text as HTML.
     * @param {?string} text Markdown text.
     * @returns {string} The HTML; empty for empty text.
     */
    static toHtml(text) {
      if (!text) return '';
      const segments = text.split(Markdown.#CODE_FENCE);
      return segments.map((segment, index) => Markdown.#segmentHtml(segment, index, segments.length)).join('');
    }

    /**
     * Renders one segment of the split text. Splitting with one capture group alternates plain text
     * (even indexes) and code (odd indexes).
     * @param {string} segment The text of the segment.
     * @param {number} index Position of the segment.
     * @param {number} segmentCount Total number of segments.
     * @returns {string} The HTML of the segment.
     */
    static #segmentHtml(segment, index, segmentCount) {
      if (index % 2) return `<pre class="claude-plus-code-block"><code>${escapeHtml(segment)}</code></pre>`;
      return Markdown.#inlineMarkupHtml(Markdown.#trimFenceLineBreaks(segment, index, segmentCount)).replace(/\n/g, '<br>');
    }

    /**
     * Removes the line breaks directly before and after a code fence, which belong to the fence.
     * @param {string} text Plain text segment.
     * @param {number} index Position of the segment.
     * @param {number} segmentCount Total number of segments.
     * @returns {string} The text without fence-adjacent line breaks.
     */
    static #trimFenceLineBreaks(text, index, segmentCount) {
      const withoutLeading = index > 0 ? text.replace(/^\n/, '') : text;
      return index < segmentCount - 1 ? withoutLeading.replace(/\n$/, '') : withoutLeading;
    }

    /**
     * Renders inline markup of escaped plain text.
     * @param {string} text Plain text.
     * @returns {string} The HTML.
     */
    static #inlineMarkupHtml(text) {
      return escapeHtml(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }
  }

  /**
   * Matches the fixed filename claude.ai gives the text file it attaches when a message quotes part
   * of an earlier one (the "Reply" button after selecting text): always
   * excerpt_from_previous_<sender>_message.txt, never a real upload worth listing as a file.
   * @type {RegExp}
   */
  const QUOTE_ATTACHMENT_NAME_PATTERN = /^excerpt_from_previous_\w+_message\.txt$/;

  var stylesheet$g = ".claude-plus-message-text {\r\n  white-space: normal;\r\n}\r\n\r\n.claude-plus-message-text a {\r\n  color: var(--claude-plus-color-accent);\r\n}\r\n\r\n.claude-plus-message-attachment {\r\n  color: var(--claude-plus-color-text-muted);\r\n  font-size: 12px;\r\n  margin-bottom: 4px;\r\n}\r\n\r\n.claude-plus-message-attachment--quote {\r\n  display: inline-block;\r\n  background: var(--claude-plus-color-button);\r\n  border-radius: 6px;\r\n  padding: 2px 8px;\r\n  cursor: default;\r\n}\r\n\r\n.claude-plus-message-images {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  gap: 6px;\r\n  margin-bottom: 6px;\r\n}\r\n\r\n.claude-plus-message--human .claude-plus-message-images {\r\n  justify-content: flex-end;\r\n}\r\n\r\n.claude-plus-message-image {\r\n  display: block;\r\n  max-height: 300px;\r\n  max-width: 100%;\r\n  border-radius: 8px;\r\n  cursor: zoom-in;\r\n}\r\n\r\n.claude-plus-artifact-frame {\r\n  display: block;\r\n  width: 100%;\r\n  min-height: 400px;\r\n  border: 1px solid var(--claude-plus-color-border);\r\n  border-radius: 8px;\r\n}\r\n\r\n";

  StyleRegistry.register(stylesheet$g);

  /**
   * Reads text, uploads and renderable HTML from API messages. Thinking and ordinary tool-call
   * blocks are deliberately not rendered here: they show in the message's "thinking and tool calls"
   * sub-pane instead (see MessageToolSteps), not inline in the chat log. A widget tool call (see
   * WIDGET_TOOL_NAMES) is different: it IS the reply, so it gets a placeholder slot here, filled in
   * later by WidgetExtractor once its real card has been extracted.
   */
  class MessageContent {
    /**
     * Shown for an API message with nothing to render.
     * @type {string}
     */
    static #NO_CONTENT_HTML = '<div class="claude-plus-message-text claude-plus-empty-state">(no content)</div>';

    /**
     * Uploaded attachments and files of a message.
     * @param {ApiMessage} apiMessage The message.
     * @returns {object[]} The uploads, without empty entries.
     */
    static uploads(apiMessage) {
      return [...(apiMessage.attachments ?? []), ...(apiMessage.files ?? [])].filter(Boolean);
    }

    /**
     * Display name of an upload.
     * @param {object} upload The upload.
     * @returns {string} The first name field present, or "(uploaded file)".
     */
    static uploadName(upload) {
      return ATTACHMENT_NAME_FIELDS.map(field => upload[field]).find(Boolean) ?? '(uploaded file)';
    }

    /**
     * Plain text of a message: its text field, or its text blocks joined by line breaks.
     * @param {ApiMessage} apiMessage The message.
     * @returns {string} The text; empty when there is none.
     */
    static plainText(apiMessage) {
      return apiMessage.text || MessageContent.#textBlocks(apiMessage).map(block => block.text).join('\n');
    }

    /**
     * HTML of a text passage rendered as markdown.
     * @param {?string} text The text.
     * @returns {string} The HTML, or an empty string for empty text.
     */
    static textHtml(text) {
      return text ? `<div class="claude-plus-message-text">${Markdown.toHtml(text)}</div>` : '';
    }

    /**
     * HTML of a whole API message, kept apart so uploads can be shown above the message rather than
     * inside it: its uploads (image gallery, then file chips), and separately its text, in original
     * order with a placeholder slot wherever a widget tool call belongs.
     * @param {ApiMessage} apiMessage The message.
     * @returns {{attachmentsHtml: string, bodyHtml: string, widgets: Array<{toolName: string, data: object, toolUseId: string}>}}
     * The uploads' HTML (empty if none), the text/slots' HTML (a "(no content)" placeholder if the
     * message has neither), and the widgets awaiting extraction, in the order their slots appear.
     */
    static contentParts(apiMessage) {
      const uploads = MessageContent.uploads(apiMessage);
      const attachmentsHtml = [
        MessageContent.#imageGalleryHtml(uploads.filter(upload => MessageContent.#isImageUpload(upload))),
        ...uploads.filter(upload => !MessageContent.#isImageUpload(upload)).map(upload => MessageContent.#fileAttachmentHtml(upload)),
      ].join('');
      const blocks = apiMessage.content ?? [];
      const resultByUseId = MessageContent.#resultsByUseId(blocks);
      const rendered = blocks.map(block => MessageContent.#bodyBlock(block, resultByUseId));
      const blocksHtml = rendered.map(item => item.html).join('');
      const bodyHtml = blocksHtml || MessageContent.textHtml(apiMessage.text);
      const widgets = rendered.map(item => item.widget).filter(Boolean);
      return { attachmentsHtml, bodyHtml: bodyHtml || (attachmentsHtml ? '' : MessageContent.#NO_CONTENT_HTML), widgets };
    }

    /**
     * Tool results by the id of the call they answer, to tell a widget call that actually rendered
     * a card from one that didn't (still pending, or a failed attempt superseded by a retry).
     * @param {ContentBlock[]} blocks The message's content blocks.
     * @returns {Map<string, ContentBlock>} The results, by tool_use_id.
     */
    static #resultsByUseId(blocks) {
      return new Map(blocks.filter(block => block.type === 'tool_result').map(block => [block.tool_use_id, block]));
    }

    /**
     * HTML (and, for a rendered widget, the extraction job) of one content block.
     * @param {ContentBlock} block The block.
     * @param {Map<string, ContentBlock>} resultByUseId Tool results by the id of the call they answer.
     * @returns {{html: string, widget: ?{toolName: string, data: object, toolUseId: string}}} The
     * block's HTML, and its widget job if it is one.
     */
    static #bodyBlock(block, resultByUseId) {
      if (block.type === 'text' && block.text) return { html: MessageContent.textHtml(block.text), widget: null };
      const resultBlock = resultByUseId.get(block.id);
      if (block.type === 'tool_use' && WidgetToolCall.isRendered(block, resultBlock)) return MessageContent.#renderedToolBlock(block, resultBlock);
      return { html: '', widget: null };
    }

    /**
     * HTML (and, for a widget, the extraction job) of a tool call already known to have a card:
     * an Artifact's real HTML, resolved at import time, or an ordinary widget awaiting extraction.
     * @param {ContentBlock} useBlock The tool_use block.
     * @param {ContentBlock} resultBlock Its tool_result block.
     * @returns {{html: string, widget: ?{toolName: string, data: object, toolUseId: string}}} The block's HTML and its widget job, if it has one.
     */
    static #renderedToolBlock(useBlock, resultBlock) {
      return useBlock.name === 'Artifact' ? MessageContent.#artifactBlock(useBlock, resultBlock) : MessageContent.#widgetBlock(useBlock);
    }

    /**
     * HTML of an Artifact whose real HTML was resolved at import time: a sandboxed iframe given the
     * document directly, with no extraction step, since the whole file is already known.
     * @param {ContentBlock} useBlock The tool_use block.
     * @param {ContentBlock} resultBlock Its tool_result block, carrying the resolved HTML.
     * @returns {{html: string, widget: null}} The iframe's HTML.
     */
    static #artifactBlock(useBlock, resultBlock) {
      const srcdoc = escapeHtml(resultBlock.structured_content.resolvedArtifactHtml);
      const title = escapeHtml(useBlock.input?.title || 'Artifact');
      return { html: `<iframe class="claude-plus-artifact-frame" srcdoc="${srcdoc}" sandbox="allow-scripts" title="${title}"></iframe>`, widget: null };
    }

    /**
     * HTML and extraction job of a widget tool call's placeholder slot. The job's data is the call's
     * own input, since every widget wrapper mirrors that back as a prop and it's what the extractor
     * matches against (a tool call id isn't consistently exposed across widget types).
     * @param {ContentBlock} useBlock The tool_use block.
     * @returns {{html: string, widget: {toolName: string, data: object, toolUseId: string}}} The slot's HTML and its job.
     */
    static #widgetBlock(useBlock) {
      const widget = { toolName: useBlock.name, data: useBlock.input || {}, toolUseId: useBlock.id };
      const key = escapeHtml(widget.toolUseId);
      return { html: `<div class="claude-plus-widget-slot" data-widget-key="${key}">Loading widget…</div>`, widget };
    }

    /**
     * HTML of a message's image uploads, laid out in a horizontal row rather than stacked.
     * @param {object[]} imageUploads The image uploads, if any.
     * @returns {string} The gallery, or an empty string when there are none.
     */
    static #imageGalleryHtml(imageUploads) {
      if (imageUploads.length === 0) return '';
      return `<div class="claude-plus-message-images">${imageUploads.map(upload => MessageContent.#imageUploadHtml(upload)).join('')}</div>`;
    }

    /**
     * Whether an upload is an image with a URL to display.
     * @param {object} upload The upload.
     * @returns {boolean} True for an image upload.
     */
    static #isImageUpload(upload) {
      return upload.file_kind === 'image' && Boolean(upload.preview_url);
    }

    /**
     * HTML of an inline image upload: capped at 300px tall, opening the full-size viewer on click.
     * @param {object} upload The image upload.
     * @returns {string} The HTML.
     */
    static #imageUploadHtml(upload) {
      const src = escapeHtml(upload.preview_url);
      const name = escapeHtml(MessageContent.uploadName(upload));
      return `<img class="claude-plus-message-image" src="${src}" data-action="openImage" data-full-src="${src}" alt="${name}" loading="lazy" />`;
    }

    /**
     * HTML of a non-image upload: a quoted passage's own chip, or a plain named chip for anything else.
     * @param {object} upload The upload.
     * @returns {string} The HTML.
     */
    static #fileAttachmentHtml(upload) {
      return QUOTE_ATTACHMENT_NAME_PATTERN.test(MessageContent.uploadName(upload))
        ? MessageContent.#quoteAttachmentHtml(upload) : `<div class="claude-plus-message-attachment">📎 ${escapeHtml(MessageContent.uploadName(upload))}</div>`;
    }

    /**
     * HTML of a quoted passage: a small chip naming its line count, the full text available as a
     * native tooltip rather than a raw filename.
     * @param {object} upload The quote attachment.
     * @returns {string} The HTML.
     */
    static #quoteAttachmentHtml(upload) {
      const text = upload.extracted_content || '';
      const lineCount = text ? text.split('\n').length : 0;
      return `<div class="claude-plus-message-attachment claude-plus-message-attachment--quote" title="${escapeHtml(text)}">💬 Quote, ${lineCount} line${lineCount === 1 ? '' : 's'}</div>`;
    }

    /**
     * Text blocks of a message that contain text.
     * @param {ApiMessage} apiMessage The message.
     * @returns {ContentBlock[]} The blocks.
     */
    static #textBlocks(apiMessage) {
      return (apiMessage.content ?? []).filter(block => block.type === 'text' && block.text);
    }

  }

  /**
   * One message as shown in the chat. Messages with isPersisted = false exist only locally (a
   * prompt the server never accepted, or an error notice) and are never used as a parent.
   */
  class ChatMessage {
    /**
     * Values of fields not given to the constructor.
     * @type {object}
     */
    static #DEFAULTS = Object.freeze({ parentId: null, text: '', apiMessage: null, isPersisted: true, isStreaming: false, errorText: null });

    /**
     * The quoted sender's name as claude.ai spells it in the attachment's filename.
     * @type {Readonly<Record<string, string>>}
     */
    static #QUOTE_SENDER_NAMES = Object.freeze({ human: 'human', assistant: 'claude' });

    /**
     * Cached body HTML (text and tool blocks); null when it must be re-rendered.
     * @type {?string}
     */
    #cachedBodyHtml = null;

    /**
     * Cached uploads HTML, shown above the message rather than inside it.
     * @type {string}
     */
    #cachedAttachmentsHtml = '';

    /**
     * Cached widget jobs awaiting extraction, in the order their placeholder slots appear in html.
     * @type {Array<{toolName: string, data: object, toolUseId: string}>}
     */
    #cachedWidgets = [];

    /**
     * Creates a message.
     * @param {object} fields Message fields; omitted ones take the defaults in parentheses.
     * @param {string} fields.id Message id.
     * @param {string} fields.sender 'human' or 'assistant'.
     * @param {?string} [fields.parentId] Parent message id (null).
     * @param {string} [fields.text] Plain text ('').
     * @param {?ApiMessage} [fields.apiMessage] API message to render instead of the text (null).
     * @param {boolean} [fields.isPersisted] Whether the server has the message (true).
     * @param {boolean} [fields.isStreaming] Whether text is still arriving (false).
     * @param {?string} [fields.errorText] Error shown under the message (null).
     */
    constructor(fields) {
      const values = { ...ChatMessage.#DEFAULTS, ...fields };
      this.id = values.id;
      this.sender = values.sender;
      this.parentId = values.parentId;
      this.text = values.text;
      this.apiMessage = values.apiMessage;
      this.isPersisted = values.isPersisted;
      this.isStreaming = values.isStreaming;
      this.errorText = values.errorText;
    }

    /**
     * Creates a message from its API representation.
     * @param {ApiMessage} apiMessage The API message.
     * @returns {ChatMessage} The persisted message.
     */
    static fromApi(apiMessage) {
      return new ChatMessage({
        id: apiMessage.uuid,
        parentId: apiMessage.parent_message_uuid ?? null,
        sender: apiMessage.sender,
        text: MessageContent.plainText(apiMessage),
        apiMessage,
      });
    }

    /**
     * The API message shape for a not-yet-sent prompt that has files and/or a quote attached, so it
     * renders its uploads the same way a persisted message would before the server has echoed it back.
     * @param {string} text Prompt text.
     * @param {UploadedFile[]} files Files uploaded beforehand.
     * @param {?{text: string, sender: string}} [quote] Text quoted from an earlier message, if any.
     * @returns {ApiMessage} The draft API message.
     */
    static draftApiMessage(text, files, quote = null) {
      return { text, attachments: quote ? [ChatMessage.quoteAttachment(quote)] : [], files, content: [] };
    }

    /**
     * Ids the server assigned to a set of uploaded files, for a completion request.
     * @param {UploadedFile[]} files The files.
     * @returns {string[]} Their ids, in the same order.
     */
    static fileUuidsOf(files) {
      return files.map(file => file.file_uuid);
    }

    /**
     * The attachment shape claude.ai gives a quoted passage: a small text file named after who said
     * it, carrying the quoted text itself rather than a real upload id.
     * @param {{text: string, sender: string}} quote Text quoted from an earlier message, and who sent it.
     * @returns {{file_name: string, file_size: number, file_type: string, extracted_content: string}}
     * The attachment.
     */
    static quoteAttachment({ text, sender }) {
      const senderName = ChatMessage.#QUOTE_SENDER_NAMES[sender] ?? 'human';
      return { file_name: `excerpt_from_previous_${senderName}_message.txt`, file_size: new TextEncoder().encode(text).length, file_type: 'txt', extracted_content: text };
    }

    /**
     * Rendered body, cached until the text changes.
     * @returns {string} HTML of the API message's text and tool blocks, or of the plain text for
     * local messages.
     */
    get html() {
      this.#renderIfNeeded();
      return this.#cachedBodyHtml;
    }

    /**
     * Rendered uploads, cached until the text changes; shown above the message rather than inside it.
     * @returns {string} HTML of the API message's uploads, or an empty string for local messages.
     */
    get attachmentsHtml() {
      this.#renderIfNeeded();
      return this.#cachedAttachmentsHtml;
    }

    /**
     * Widgets awaiting extraction, cached until the text changes; empty for local messages.
     * @returns {Array<{toolName: string, data: object, toolUseId: string}>} The widget jobs, in the
     * order their placeholder slots appear in html.
     */
    get widgets() {
      this.#renderIfNeeded();
      return this.#cachedWidgets;
    }

    /**
     * Appends streamed text.
     * @param {string} addedText Text to append.
     * @returns {void}
     */
    appendText(addedText) {
      this.text += addedText;
      this.#cachedBodyHtml = null;
    }

    /**
     * Renders the body, uploads and widget jobs if the cache was invalidated.
     * @returns {void}
     */
    #renderIfNeeded() {
      if (this.#cachedBodyHtml !== null) return;
      if (this.apiMessage) {
        const parts = MessageContent.contentParts(this.apiMessage);
        this.#cachedBodyHtml = parts.bodyHtml;
        this.#cachedAttachmentsHtml = parts.attachmentsHtml;
        this.#cachedWidgets = parts.widgets;
      } else {
        this.#cachedBodyHtml = MessageContent.textHtml(this.text);
      }
    }
  }

  /**
   * Creates an id for a message that exists only locally.
   * @returns {string} A unique id prefixed with "local-".
   */
  function createLocalMessageId() {
    return `local-${crypto.randomUUID()}`;
  }

  /**
   * Creates a local, unpersisted assistant message showing an error.
   * @param {string} errorText Error text.
   * @returns {ChatMessage} The notice.
   */
  function createErrorNotice(errorText) {
    return new ChatMessage({ id: createLocalMessageId(), sender: 'assistant', isPersisted: false, errorText });
  }

  /**
   * Switches a chat session between conversations: stops any reply, clears what was shown, then
   * loads the conversation (its imported copy if it has one, else fetched live). Responses arriving
   * after the user has navigated elsewhere are dropped.
   */
  class ChatConversationLoader {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Imported conversations, checked before the live API.
     * @type {ImportedConversationStore}
     */
    #importedConversations;

    /**
     * The session's state.
     * @type {ChatSessionState}
     */
    #state;

    /**
     * Stops the reply in progress.
     * @type {function(): void}
     */
    #stopReply;

    /**
     * Numbers navigations, so late responses for an old one are dropped.
     * @type {NavigationCounter}
     */
    #navigations = new NavigationCounter();

    /**
     * Creates the loader.
     * @param {object} parts Loader parts.
     * @param {ClaudeApi} parts.api API client.
     * @param {ImportedConversationStore} parts.importedConversations Imported conversations, checked before the live API.
     * @param {ChatSessionState} parts.state The session's state.
     * @param {function(): void} parts.stopReply Stops the reply in progress.
     */
    constructor({ api, importedConversations, state, stopReply }) {
      this.#api = api;
      this.#importedConversations = importedConversations;
      this.#state = state;
      this.#stopReply = stopReply;
    }

    /**
     * Opens a conversation. A load failure is shown as an error notice.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once the messages or the error notice are shown.
     */
    async open(conversationId) {
      const navigation = this.beginNavigation(conversationId);
      try {
        const { conversation, isImported } = await this.#load(conversationId);
        if (this.#navigations.isLatest(navigation)) this.#state.showConversation(conversation, isImported);
      } catch (error) {
        this.#showLoadError(navigation, error);
      }
    }

    /**
     * Stops any reply, clears the messages and makes a conversation (or a new chat) open.
     * @param {?string} conversationId Conversation to open, or null for a new chat.
     * @returns {number} Number identifying this navigation.
     */
    beginNavigation(conversationId) {
      this.#stopReply();
      const navigation = this.#navigations.begin();
      this.#state.reset(conversationId);
      return navigation;
    }

    /**
     * Loads a conversation: its imported copy if it has one, else fetched live.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<{conversation: ApiConversation, isImported: boolean}>} The conversation and
     * whether it came from the imported store.
     * @throws {ApiError} When it isn't imported and the live fetch fails.
     */
    async #load(conversationId) {
      const imported = await this.#importedConversations.get(conversationId);
      return { conversation: imported ?? await this.#api.getConversation(conversationId), isImported: Boolean(imported) };
    }

    /**
     * Shows a conversation load failure, unless the user has navigated away since.
     * @param {number} navigation Number of the failed navigation, from NavigationCounter.begin().
     * @param {Error} error The failure.
     * @returns {void}
     */
    #showLoadError(navigation, error) {
      if (!this.#navigations.isLatest(navigation)) return;
      console.warn(LOG_PREFIX, 'loading conversation failed', error);
      this.#state.setMessages([createErrorNotice(`Could not load this conversation (${error.message}).`)]);
    }
  }

  /**
   * Keeps the shared conversation list in step with what a chat session creates and sends: lists a
   * just-created conversation, and refreshes a conversation from the server after each send.
   */
  class ChatDirectorySync {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Shared conversation list.
     * @type {CombinedConversationDirectory}
     */
    #directory;

    /**
     * The session's state.
     * @type {ChatSessionState}
     */
    #state;

    /**
     * Publishes a session event with an optional payload.
     * @type {function(string, *=): void}
     */
    #publish;

    /**
     * Creates the sync.
     * @param {object} parts Sync parts.
     * @param {ClaudeApi} parts.api API client.
     * @param {CombinedConversationDirectory} parts.directory Shared conversation list.
     * @param {ChatSessionState} parts.state The session's state.
     * @param {function(string, *=): void} parts.publish Publishes a session event with an optional payload.
     */
    constructor({ api, directory, state, publish }) {
      this.#api = api;
      this.#directory = directory;
      this.#state = state;
      this.#publish = publish;
    }

    /**
     * Lists a just-created conversation and makes it the open one.
     * @param {string} conversationId Conversation id.
     * @param {string} prompt First prompt, used as a provisional title.
     * @returns {void}
     */
    registerNewConversation(conversationId, prompt) {
      this.#directory.registerNewConversation(conversationId, prompt);
      this.#state.setOpenConversation(conversationId);
    }

    /**
     * Fetches the conversation after a send to update the list and the stats, and replaces the
     * optimistic messages with the server's copy (real tool blocks and parent ids).
     * @param {string} conversationId Conversation id.
     * @param {boolean} replaceMessages False after a failure, so the error stays on screen.
     * @returns {Promise<void>} Resolves once done; failures are logged.
     */
    async reloadAfterSend(conversationId, replaceMessages) {
      try {
        const conversation = await this.#api.getConversation(conversationId);
        this.#directory.updateListing(conversation);
        this.#publish('conversationLoaded', { conversation, isImported: false });
        if (replaceMessages && this.#state.isOpenAndIdle(conversationId)) this.#state.showBranchOf(conversation);
      } catch (error) {
        console.warn(LOG_PREFIX, 'refreshing conversation failed', error);
      }
    }
  }

  /**
   * Parent of the first message in every claude.ai conversation tree. Used when a message's parent
   * is unknown locally.
   * @type {string}
   */
  const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000';

  /**
   * Type of the synthetic first event of a completion stream, carrying the client-generated ids.
   * @type {string}
   */
  const STREAM_START = 'claudeplus_stream_start';

  /**
   * Applies the events of a completion stream to a turn: the start adds the empty reply, text deltas
   * extend it, usage windows are published and the stop completes it. Unknown event types are ignored.
   */
  class StreamEventApplier {
    /**
     * Handler per stream event type.
     * @type {Map<string, function(Turn, object): void>}
     */
    #handlersByType = new Map([
      [STREAM_START, (turn, event) => this.#onStreamStart(turn, event)],
      ['content_block_delta', (turn, event) => this.#onContentDelta(turn, event)],
      ['message_limit', (turn, event) => this.#onMessageLimit(event)],
      ['message_stop', turn => this.#onMessageStop(turn)],
    ]);

    /**
     * Adds a message to the end of the session's message list.
     * @type {function(ChatMessage): void}
     */
    #appendMessage;

    /**
     * Lists a just-created conversation and makes it the open one.
     * @type {function(string, string): void}
     */
    #registerNewConversation;

    /**
     * Publishes a session event.
     * @type {function(string, *): void}
     */
    #publish;

    /**
     * Creates the applier.
     * @param {object} callbacks Effects on the session.
     * @param {function(ChatMessage): void} callbacks.appendMessage Adds a message to the end of the session's message list.
     * @param {function(string, string): void} callbacks.registerNewConversation Lists a just-created conversation by id and first prompt, and makes it the open one.
     * @param {function(string, *): void} callbacks.publish Publishes a session event with a payload.
     */
    constructor({ appendMessage, registerNewConversation, publish }) {
      this.#appendMessage = appendMessage;
      this.#registerNewConversation = registerNewConversation;
      this.#publish = publish;
    }

    /**
     * Applies one stream event.
     * @param {Turn} turn The turn the stream belongs to.
     * @param {StreamEvent} event The event.
     * @returns {void}
     */
    apply(turn, event) {
      const handleEvent = this.#handlersByType.get(event.type);
      if (handleEvent) handleEvent(turn, event);
    }

    /**
     * Marks the prompt as accepted and adds the empty reply; registers a new conversation.
     * @param {Turn} turn The turn.
     * @param {{humanMessageId: string, assistantMessageId: string}} event The STREAM_START event.
     * @returns {void}
     */
    #onStreamStart(turn, event) {
      turn.promptMessage.id = event.humanMessageId;
      turn.promptMessage.isPersisted = true;
      turn.replyMessage = new ChatMessage({ id: event.assistantMessageId, parentId: event.humanMessageId, sender: 'assistant', isStreaming: true });
      if (turn.isNewConversation) this.#registerNewConversation(turn.conversationId, turn.prompt);
      this.#appendMessage(turn.replyMessage);
    }

    /**
     * Appends streamed reply text.
     * @param {Turn} turn The turn.
     * @param {{delta: ?{type: string, text: string}}} event A content_block_delta event.
     * @returns {void}
     */
    #onContentDelta(turn, event) {
      if (!turn.replyMessage || !StreamEventApplier.#isTextDelta(event)) return;
      turn.replyMessage.appendText(event.delta.text);
      this.#publish('messageContent', turn.replyMessage);
    }

    /**
     * Whether a content_block_delta event carries text.
     * @param {{delta: ?{type: string}}} event The event.
     * @returns {boolean} True for text deltas.
     */
    static #isTextDelta(event) {
      return Boolean(event.delta) && event.delta.type === 'text_delta';
    }

    /**
     * Publishes the usage windows reported during the stream.
     * @param {{message_limit: ?{windows: ?Object<string, UsageWindow>}}} event A message_limit event.
     * @returns {void}
     */
    #onMessageLimit(event) {
      const windows = event.message_limit ? event.message_limit.windows : null;
      if (windows) this.#publish('rateLimits', { fiveHour: windows['5h'], sevenDay: windows['7d'] });
    }

    /**
     * Marks the reply as complete.
     * @param {Turn} turn The turn.
     * @returns {void}
     */
    #onMessageStop(turn) {
      if (!turn.replyMessage) return;
      turn.replyMessage.isStreaming = false;
      this.#publish('messageContent', turn.replyMessage);
    }
  }

  /**
   * State of one prompt/reply exchange while it is being sent.
   */
  class Turn {
    /**
     * Creates the turn.
     * @param {object} fields Turn fields.
     * @param {string} fields.conversationId Conversation the prompt belongs to.
     * @param {boolean} fields.isNewConversation Whether the prompt creates the conversation.
     * @param {string} fields.prompt Prompt text.
     * @param {ChatMessage} fields.promptMessage The prompt's message.
     * @param {UploadedFile[]} fields.files Files uploaded beforehand to attach.
     * @param {?{text: string, sender: string}} fields.quote Text quoted from an earlier message, if any.
     * @param {AbortController} fields.abortController Aborts the request.
     */
    constructor({ conversationId, isNewConversation, prompt, promptMessage, files, quote, abortController }) {
      this.conversationId = conversationId;
      this.isNewConversation = isNewConversation;
      this.prompt = prompt;
      this.promptMessage = promptMessage;
      this.files = files;
      this.quote = quote;
      this.abortController = abortController;
      this.replyMessage = null;
      this.hasFailed = false;
    }
  }

  /**
   * Sends a chat session's prompts: shows the prompt, streams the reply into the chat, reports a
   * failure and, once the server has the prompt, reloads the conversation from the server.
   */
  class ChatReplySender {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Model options for new prompts.
     * @type {ComposerSettings}
     */
    #settings;

    /**
     * The session's state.
     * @type {ChatSessionState}
     */
    #state;

    /**
     * Refreshes the conversation from the server once a send has ended.
     * @type {function(string, boolean): Promise<void>}
     */
    #reloadAfterSend;

    /**
     * Aborts the prompt being sent.
     * @type {?AbortController}
     */
    #abortController = null;

    /**
     * Applies completion stream events to the turn being sent.
     * @type {StreamEventApplier}
     */
    #streamEvents;

    /**
     * Creates the sender.
     * @param {object} parts Sender parts.
     * @param {ClaudeApi} parts.api API client.
     * @param {ComposerSettings} parts.settings Model options for new prompts.
     * @param {ChatSessionState} parts.state The session's state.
     * @param {function(string, string): void} parts.registerNewConversation Lists a just-created conversation and makes it the open one.
     * @param {function(string, boolean): Promise<void>} parts.reloadAfterSend Refreshes the conversation from the server once a send has ended.
     * @param {function(string, *=): void} parts.publish Publishes a session event with an optional payload.
     */
    constructor({ api, settings, state, registerNewConversation, reloadAfterSend, publish }) {
      this.#api = api;
      this.#settings = settings;
      this.#state = state;
      this.#reloadAfterSend = reloadAfterSend;
      this.#streamEvents = new StreamEventApplier({ appendMessage: message => state.setMessages([...state.messages, message]), registerNewConversation, publish });
    }

    /**
     * Aborts the reply in progress, keeping the text received so far.
     * @returns {void}
     */
    stop() {
      if (this.#abortController) this.#abortController.abort();
    }

    /**
     * Sends a prompt as a reply to a given message and streams the answer into the chat. Ignored for
     * a blank prompt, while sending, or in an imported conversation.
     * @param {string} prompt Prompt text.
     * @param {?string} parentMessageId Message to reply to; null for the conversation root.
     * @param {UploadedFile[]} files Files uploaded beforehand to attach.
     * @param {?{text: string, sender: string}} quote Text quoted from an earlier message, if any.
     * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
     */
    async sendAfter(prompt, parentMessageId, files, quote) {
      if (!prompt.trim() || this.#state.isSending || this.#state.isImported) return;
      const turn = this.#beginTurn(prompt, parentMessageId, files, quote);
      try {
        await this.#streamReply(turn);
      } catch (error) {
        this.#showSendFailure(turn, error);
      } finally {
        this.#finishTurn(turn);
      }
    }

    /**
     * Shows the prompt and marks the session as sending.
     * @param {string} prompt Prompt text.
     * @param {?string} parentMessageId Message to reply to.
     * @param {UploadedFile[]} files Files uploaded beforehand to attach.
     * @param {?{text: string, sender: string}} quote Text quoted from an earlier message, if any.
     * @returns {Turn} The new turn.
     */
    #beginTurn(prompt, parentMessageId, files, quote) {
      const promptMessage = new ChatMessage({
        id: createLocalMessageId(), parentId: parentMessageId, sender: 'human', text: prompt, isPersisted: false,
        apiMessage: files.length || quote ? ChatMessage.draftApiMessage(prompt, files, quote) : null,
      });
      const turn = new Turn({
        conversationId: this.#state.targetConversationId,
        isNewConversation: this.#state.openConversationId === null,
        prompt,
        promptMessage,
        files,
        quote,
        abortController: new AbortController(),
      });
      this.#abortController = turn.abortController;
      this.#state.setMessages([...this.#state.messages, promptMessage]);
      this.#state.setSending(true);
      return turn;
    }

    /**
     * Sends the turn's prompt and applies each stream event.
     * @param {Turn} turn The turn.
     * @returns {Promise<void>} Resolves when the stream ends.
     * @throws {ApiError|DOMException} When the request fails or is aborted.
     */
    async #streamReply(turn) {
      const events = this.#api.streamCompletion({
        conversationId: turn.conversationId,
        prompt: turn.prompt,
        parentMessageId: turn.promptMessage.parentId ?? ROOT_MESSAGE_UUID,
        isNew: turn.isNewConversation,
        settings: this.#settings.snapshot(),
        fileUuids: ChatMessage.fileUuidsOf(turn.files),
        attachments: turn.quote ? [ChatMessage.quoteAttachment(turn.quote)] : [],
        signal: turn.abortController.signal,
      });
      for await (const event of events) this.#streamEvents.apply(turn, event);
    }

    /**
     * Shows a send failure under the reply, or as a separate notice when no reply exists yet. A user
     * stop (AbortError) isn't a failure.
     * @param {Turn} turn The turn.
     * @param {Error} error The failure.
     * @returns {void}
     */
    #showSendFailure(turn, error) {
      if (error.name === 'AbortError') return;
      turn.hasFailed = true;
      console.warn(LOG_PREFIX, 'send failed', error);
      if (turn.replyMessage) turn.replyMessage.errorText = error.message;
      else this.#state.messages.push(createErrorNotice(error.message));
    }

    /**
     * Ends sending and, if the server accepted the prompt, reloads the conversation from the server.
     * @param {Turn} turn The turn.
     * @returns {void}
     */
    #finishTurn(turn) {
      if (turn.replyMessage) turn.replyMessage.isStreaming = false;
      if (this.#abortController === turn.abortController) this.#abortController = null;
      this.#state.setSending(false);
      this.#state.setMessages(this.#state.messages);
      if (turn.promptMessage.isPersisted) this.#reloadAfterSend(turn.conversationId, !turn.hasFailed);
    }
  }

  /**
   * Chat messages of a conversation's current branch.
   * @param {ApiConversation} conversation The conversation.
   * @returns {ChatMessage[]} The messages, oldest first.
   */
  function currentBranchMessages(conversation) {
    return ConversationTree.currentBranch(conversation).map(apiMessage => ChatMessage.fromApi(apiMessage));
  }

  /**
   * What one chat session shows: the open conversation, its messages and whether a prompt is being
   * sent. Every change is published through the owning session, so its panels can re-render.
   */
  class ChatSessionState {
    /**
     * Publishes a session event with an optional payload.
     * @type {function(string, *=): void}
     */
    #publish;

    /**
     * Open conversation id, or null for a new chat.
     * @type {?string}
     */
    #openConversationId = null;

    /**
     * Id generated for a new chat's conversation as soon as a file is uploaded to it, so the upload
     * and the first prompt land in the same conversation. Cleared once the open conversation changes.
     * @type {?string}
     */
    #draftConversationId = null;

    /**
     * Messages of the open conversation's current branch.
     * @type {ChatMessage[]}
     */
    #messages = [];

    /**
     * The full conversation last fetched, with every branch; null for a new chat or before the first
     * load. Used to find a message's sibling versions and switch between them.
     * @type {?ApiConversation}
     */
    #conversation = null;

    /**
     * Whether the open conversation is an imported one, with no model to reply to.
     * @type {boolean}
     */
    #isImported = false;

    /**
     * Whether a prompt is being sent.
     * @type {boolean}
     */
    #isSending = false;

    /**
     * Creates the state of an empty new chat.
     * @param {function(string, *=): void} publish Publishes a session event with an optional payload.
     */
    constructor(publish) {
      this.#publish = publish;
    }

    /**
     * Open conversation.
     * @returns {?string} Its id, or null for a new chat.
     */
    get openConversationId() {
      return this.#openConversationId;
    }

    /**
     * Messages of the open conversation.
     * @returns {ChatMessage[]} The current branch, oldest first.
     */
    get messages() {
      return this.#messages;
    }

    /**
     * The full conversation last fetched.
     * @returns {?ApiConversation} It, or null for a new chat or before the first load.
     */
    get conversation() {
      return this.#conversation;
    }

    /**
     * Whether the open conversation is an imported one.
     * @returns {boolean} True for an imported conversation.
     */
    get isImported() {
      return this.#isImported;
    }

    /**
     * Whether a prompt is being sent.
     * @returns {boolean} True while sending.
     */
    get isSending() {
      return this.#isSending;
    }

    /**
     * Id of the conversation a file uploaded right now would belong to: the open conversation, or a
     * stable id generated on first use so an upload and the prompt that follows it share one
     * conversation, even before that conversation exists on the server.
     * @returns {string} The conversation id.
     */
    get targetConversationId() {
      return this.#openConversationId ?? (this.#draftConversationId ??= crypto.randomUUID());
    }

    /**
     * Makes a conversation (or a new chat) open, with no messages until it is shown.
     * @param {?string} conversationId Conversation id, or null for a new chat.
     * @returns {void}
     */
    reset(conversationId) {
      this.setOpenConversation(conversationId);
      this.#conversation = null;
      this.#isImported = false;
      this.setMessages([]);
    }

    /**
     * Shows a fetched conversation's current branch and publishes it for the stats.
     * @param {ApiConversation} conversation The conversation.
     * @param {boolean} isImported Whether it came from the imported store rather than the live API.
     * @returns {void}
     */
    showConversation(conversation, isImported) {
      this.#isImported = isImported;
      this.showBranchOf(conversation);
      this.#publish('conversationLoaded', { conversation, isImported });
    }

    /**
     * Shows the current branch of a conversation, keeping it for later branch switches.
     * @param {ApiConversation} conversation The conversation.
     * @returns {void}
     */
    showBranchOf(conversation) {
      this.#conversation = conversation;
      this.setMessages(currentBranchMessages(conversation));
    }

    /**
     * Changes the open conversation.
     * @param {?string} conversationId Conversation id, or null for a new chat.
     * @returns {void}
     */
    setOpenConversation(conversationId) {
      if (this.#openConversationId === conversationId) return;
      this.#openConversationId = conversationId;
      this.#draftConversationId = null;
      this.#publish('openConversation');
    }

    /**
     * Replaces the message list.
     * @param {ChatMessage[]} messages New list.
     * @returns {void}
     */
    setMessages(messages) {
      this.#messages = messages;
      this.#publish('messages');
    }

    /**
     * Changes the sending state.
     * @param {boolean} isSending Whether a prompt is being sent.
     * @returns {void}
     */
    setSending(isSending) {
      this.#isSending = isSending;
      this.#publish('sending');
    }

    /**
     * Whether a conversation is open here and not sending.
     * @param {string} conversationId Conversation id.
     * @returns {boolean} True when its messages can be replaced safely.
     */
    isOpenAndIdle(conversationId) {
      return this.#openConversationId === conversationId && !this.#isSending;
    }

    /**
     * Id of the last persisted message before a position.
     * @param {number} index Position to search backwards from (exclusive).
     * @returns {?string} The id, or null when there is none.
     */
    lastPersistedMessageIdBefore(index) {
      const message = this.#messages.slice(0, index).findLast(candidate => candidate.isPersisted);
      return message ? message.id : null;
    }
  }

  /**
   * One chat: the conversation open in a chat pane, its messages and the prompt being sent. Every
   * chat pane has its own session, so several conversations can be open and streaming at once.
   * @fires ChatSession#openConversation The open conversation changed.
   * @fires ChatSession#messages The message list changed.
   * @fires ChatSession#messageContent One message's content changed; payload is the ChatMessage.
   * @fires ChatSession#sending Sending started or ended.
   * @fires ChatSession#conversationLoaded A conversation was fetched; payload is {conversation: ApiConversation, isImported: boolean}.
   * @fires ChatSession#rateLimits Usage windows arrived in a stream; payload is RateLimits.
   * @fires ChatSession#quoteRequested Text was selected and "Reply" clicked; payload is {text: string, sender: string}.
   */
  class ChatSession extends EventEmitter {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * The open conversation, its messages and the sending state.
     * @type {ChatSessionState}
     */
    #state = new ChatSessionState((eventName, payload) => this.publish(eventName, payload));

    /**
     * Sends prompts and streams their replies.
     * @type {ChatReplySender}
     */
    #sender;

    /**
     * Switches between conversations.
     * @type {ChatConversationLoader}
     */
    #loader;

    /**
     * Switches between sibling versions of a message.
     * @type {ChatBranchSwitcher}
     */
    #branches;

    /**
     * Creates an empty session showing a new chat.
     * @param {ClaudeApi} api API client.
     * @param {ComposerSettings} settings Model options for new prompts.
     * @param {CombinedConversationDirectory} directory Shared conversation list.
     * @param {ImportedConversationStore} importedConversations Imported conversations, checked before the live API when opening one.
     */
    constructor(api, settings, directory, importedConversations) {
      super();
      const state = this.#state;
      const publish = (eventName, payload) => this.publish(eventName, payload);
      const sync = new ChatDirectorySync({ api, directory, state, publish });
      this.#api = api;
      this.#sender = new ChatReplySender({
        api, settings, state, publish,
        registerNewConversation: (conversationId, prompt) => sync.registerNewConversation(conversationId, prompt),
        reloadAfterSend: (conversationId, replaceMessages) => sync.reloadAfterSend(conversationId, replaceMessages),
      });
      this.#loader = new ChatConversationLoader({ api, importedConversations, state, stopReply: () => this.stopReply() });
      this.#branches = new ChatBranchSwitcher(api, state);
    }

    /**
     * Open conversation.
     * @returns {?string} Its id, or null for a new chat.
     */
    get openConversationId() {
      return this.#state.openConversationId;
    }

    /**
     * Whether a conversation is the open one and its messages have been loaded.
     * @param {string} conversationId Conversation id.
     * @returns {boolean} True when it is open and shows saved messages, so opening it again would only reload the same ones.
     */
    isLoaded(conversationId) {
      return this.#state.openConversationId === conversationId && this.#state.messages.some(message => message.isPersisted);
    }

    /**
     * Messages of the open conversation.
     * @returns {ChatMessage[]} The current branch, oldest first.
     */
    get messages() {
      return this.#state.messages;
    }

    /**
     * Whether a prompt is being sent.
     * @returns {boolean} True while sending.
     */
    get isSending() {
      return this.#state.isSending;
    }

    /**
     * Whether the open conversation is read-only: an imported chat, with no model to reply to.
     * @returns {boolean} True for an imported conversation.
     */
    get isReadOnly() {
      return this.#state.isImported;
    }

    /**
     * Id of the conversation a file uploaded right now would belong to.
     * @returns {string} The conversation id.
     */
    get targetConversationId() {
      return this.#state.targetConversationId;
    }

    /**
     * Uploads a file to the conversation a prompt sent right now would use.
     * @param {File} file File to upload.
     * @returns {Promise<UploadedFile>} The server's record of the upload.
     * @throws {ApiError} When the request fails.
     */
    uploadFile(file) {
      return this.#api.uploadFile(this.targetConversationId, file);
    }

    /**
     * Position of a message among its siblings (its other edits or retries), for a branch-switch control.
     * @param {string} messageId Message id.
     * @returns {?{index: number, count: number}} Its zero-based position and the sibling count, or null.
     */
    branchInfoFor(messageId) {
      return this.#branches.branchInfoFor(messageId);
    }

    /**
     * Switches to a sibling version of a message (an edit or a retried reply).
     * @param {string} messageId Message id.
     * @param {number} step -1 for the previous version, +1 for the next.
     * @returns {Promise<void>} Resolves once switched.
     */
    switchBranch(messageId, step) {
      return this.#branches.switchBranch(messageId, step);
    }

    /**
     * Edits a persisted human message: sends the new text as a sibling reply to the same parent,
     * branching the conversation there instead of replacing what the server has. Ignored while
     * sending, for an assistant message, or for a message the server hasn't accepted yet.
     * @param {number} index Position of the message in the current branch.
     * @param {string} newText Edited text; ignored if blank.
     * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
     */
    editMessage(index, newText) {
      const message = this.#state.messages[index];
      if (this.#state.isSending || !newText.trim() || !ChatSession.#isEditableHumanMessage(message)) return Promise.resolve();
      this.#state.setMessages(this.#state.messages.slice(0, index));
      return this.#sender.sendAfter(newText, message.parentId, []);
    }

    /**
     * Whether a message can be edited: a persisted prompt from the human.
     * @param {?ChatMessage} message The message.
     * @returns {boolean} True when it can be edited.
     */
    static #isEditableHumanMessage(message) {
      return Boolean(message) && message.sender === 'human' && message.isPersisted;
    }

    /**
     * Opens a conversation, stopping any reply in progress. A load failure is shown as an error notice.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once the messages or the error notice are shown.
     */
    openConversation(conversationId) {
      return this.#loader.open(conversationId);
    }

    /**
     * Switches to an empty new chat, stopping any reply in progress.
     * @returns {void}
     */
    startNewConversation() {
      this.#loader.beginNavigation(null);
    }

    /**
     * Aborts the reply in progress, keeping the text received so far.
     * @returns {void}
     */
    stopReply() {
      this.#sender.stop();
    }

    /**
     * Sends a prompt as a reply to the last persisted message. Ignored while sending or for blank prompts.
     * @param {string} prompt Prompt text.
     * @param {UploadedFile[]} [files] Files uploaded beforehand to attach.
     * @param {?{text: string, sender: string}} [quote] Text quoted from an earlier message, if any.
     * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
     */
    sendPrompt(prompt, files = [], quote = null) {
      return this.#sender.sendAfter(prompt, this.#state.lastPersistedMessageIdBefore(this.#state.messages.length), files, quote);
    }

    /**
     * Publishes a quote request, so the active composer can offer it as an attachment to the next
     * prompt.
     * @param {string} text Text selected in a message.
     * @param {string} sender Sender of the message it was selected in.
     * @returns {void}
     */
    requestQuote(text, sender) {
      this.publish('quoteRequested', { text, sender });
    }

    /**
     * Asks the last prompt again as a new branch from the same parent, replacing the answer shown.
     * Ignored while sending.
     * @returns {void}
     */
    retryLastPrompt() {
      const messages = this.#state.messages;
      const promptIndex = messages.findLastIndex(message => message.sender === 'human');
      if (this.#state.isSending || promptIndex === -1) return;
      const promptMessage = messages[promptIndex];
      this.#state.setMessages(messages.slice(0, promptIndex));
      this.#sender.sendAfter(promptMessage.text, promptMessage.parentId ?? this.#state.lastPersistedMessageIdBefore(promptIndex), []);
    }
  }

  /**
   * Builds a chat pane: its session, its panel, and the forwarding of the session's events.
   */
  class ChatPaneFactory {
    /**
     * Shared services the sessions and panels need.
     * @type {{api: ClaudeApi, settings: ComposerSettings, directory: CombinedConversationDirectory, preferences: Preferences, stats: StatsIndex, widgetExtractor: WidgetExtractor, importedConversations: ImportedConversationStore}}
     */
    #services;

    /**
     * The pane manager, handed to every panel.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Called with a pane id when that pane opens another conversation.
     * @type {function(string): void}
     */
    #onPaneConversationChanged;

    /**
     * Creates the factory.
     * @param {object} services Shared services the sessions and panels need.
     * @param {ChatPaneManager} paneManager The pane manager, handed to every panel.
     * @param {function(string): void} onPaneConversationChanged Called with a pane id when that pane opens another conversation.
     */
    constructor(services, paneManager, onPaneConversationChanged) {
      this.#services = services;
      this.#paneManager = paneManager;
      this.#onPaneConversationChanged = onPaneConversationChanged;
    }

    /**
     * Creates a pane's session and panel and forwards the session's fetched conversations and usage
     * windows through the pane manager.
     * @param {string} paneId Pane id.
     * @returns {{session: ChatSession, panel: ChatPanel}} The pane.
     */
    create(paneId) {
      const { api, settings, directory, preferences, stats, widgetExtractor, importedConversations } = this.#services;
      const session = new ChatSession(api, settings, directory, importedConversations);
      const panel = new ChatPanel({ paneId, session, directory, paneManager: this.#paneManager, stats, preferences, widgetExtractor });
      session.subscribe('openConversation', () => this.#onPaneConversationChanged(paneId));
      session.subscribe('conversationLoaded', payload => this.#paneManager.publish('conversationLoaded', payload));
      session.subscribe('rateLimits', limits => this.#paneManager.publish('rateLimits', limits));
      return { session, panel };
    }
  }

  /**
   * Creates a unique chat pane id.
   * @returns {string} An id starting with "chat-".
   */
  function createChatPaneId() {
    return `chat-${crypto.randomUUID()}`;
  }

  /**
   * Recreates the chat panes stored by the last visit, then reopens their conversations once the
   * data they need has loaded.
   */
  class ChatPaneRestorer {
    /**
     * Stored panes.
     * @type {ChatPaneStore}
     */
    #store;

    /**
     * Creates an undocked pane with a given id.
     * @type {function(string): {session: ChatSession, panel: ChatPanel}}
     */
    #createPane;

    /**
     * Conversations to reopen in restored panes, by pane id.
     * @type {Map<string, {session: ChatSession, conversationId: string}>}
     */
    #conversationsToRestore = new Map();

    /**
     * Creates the restorer.
     * @param {ChatPaneStore} store Stored panes.
     * @param {function(string): {session: ChatSession, panel: ChatPanel}} createPane Creates an undocked pane with a given id.
     */
    constructor(store, createPane) {
      this.#store = store;
      this.#createPane = createPane;
    }

    /**
     * Recreates the stored panes, or one empty pane, remembering their conversations for
     * openRemaining.
     * @param {?string} preferredConversationId Conversation in the URL, or null.
     * @returns {string} Id of the pane to focus: the one that showed the preferred conversation, otherwise the first one.
     */
    restore(preferredConversationId) {
      const storedPanes = this.#store.read();
      const panes = storedPanes.length ? storedPanes : [{ paneId: createChatPaneId(), conversationId: null }];
      panes.forEach(pane => this.#restorePane(pane));
      const preferredPane = panes.find(pane => pane.conversationId !== null && pane.conversationId === preferredConversationId);
      return (preferredPane || panes[0]).paneId;
    }

    /**
     * Reopens the remembered conversations of every restored pane except the focused one, whose
     * conversation comes from the URL.
     * @param {string} focusedPaneId Id of the focused pane.
     * @returns {void}
     */
    openRemaining(focusedPaneId) {
      this.#conversationsToRestore.delete(focusedPaneId);
      this.#conversationsToRestore.forEach(({ session, conversationId }) => session.openConversation(conversationId));
      this.#conversationsToRestore.clear();
    }

    /**
     * Creates a pane from its stored state, remembering its conversation for later.
     * @param {{paneId: string, conversationId: ?string}} storedPane Stored pane.
     * @returns {void}
     */
    #restorePane({ paneId, conversationId }) {
      const { session } = this.#createPane(paneId);
      if (conversationId) this.#conversationsToRestore.set(paneId, { session, conversationId });
    }
  }

  /**
   * Stores which chat panes are open and which conversation each one shows, across visits.
   */
  class ChatPaneStore {
    /**
     * Storage for the open panes.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Creates the store.
     * @param {Preferences} preferences Storage for the open panes.
     */
    constructor(preferences) {
      this.#preferences = preferences;
    }

    /**
     * The well-formed panes stored by the last visit.
     * @returns {Array<{paneId: string, conversationId: ?string}>} The panes; empty when nothing valid is stored.
     */
    read() {
      const storedPanes = this.#preferences.readJson(STORAGE_KEYS.chatPanes);
      return Array.isArray(storedPanes) ? storedPanes.filter(ChatPaneStore.#isValidStoredPane) : [];
    }

    /**
     * Stores the panes.
     * @param {Array<{paneId: string, conversationId: ?string}>} storedPanes Every pane with its conversation.
     * @returns {void}
     */
    write(storedPanes) {
      this.#preferences.writeJson(STORAGE_KEYS.chatPanes, storedPanes);
    }

    /**
     * Whether a stored pane entry is well formed.
     * @param {*} storedPane Stored entry.
     * @returns {boolean} True for an object with a "chat-" pane id and a string or null conversation id.
     */
    static #isValidStoredPane(storedPane) {
      return Boolean(storedPane) && isChatPaneId(storedPane.paneId) && (storedPane.conversationId === null || typeof storedPane.conversationId === 'string');
    }
  }

  /**
   * Owns the chat panes: creates, docks, focuses and closes them, and remembers which conversation
   * each one shows. The focused pane is the one the sidebar, the URL and the export act on.
   * @fires ChatPaneManager#focus The focused pane changed.
   * @fires ChatPaneManager#paneConversations A pane opened another conversation; payload is the pane id.
   * @fires ChatPaneManager#conversationLoaded A pane fetched a conversation; payload is {conversation: ApiConversation, isImported: boolean}.
   * @fires ChatPaneManager#rateLimits A pane received usage windows; payload is RateLimits.
   * @fires ChatPaneManager#visiblePanes Whether more than one chat pane is visible changed.
   */
  class ChatPaneManager extends EventEmitter {
    /**
     * Session and panel of every pane, by pane id, in creation order.
     * @type {Map<string, {session: ChatSession, panel: ChatPanel}>}
     */
    #panes = new Map();

    /**
     * Id of the focused pane.
     * @type {?string}
     */
    #focusedPaneId = null;

    /**
     * Workspace the panes are docked in; set by attachWorkspace.
     * @type {?DockWorkspace}
     */
    #workspace = null;

    /**
     * Builds each pane's session and panel.
     * @type {ChatPaneFactory}
     */
    #factory;

    /**
     * Stores the open panes across visits.
     * @type {ChatPaneStore}
     */
    #store;

    /**
     * Recreates the stored panes.
     * @type {ChatPaneRestorer}
     */
    #restorer;

    /**
     * Decides each pane's border.
     * @type {ChatPaneBorders}
     */
    #borders = new ChatPaneBorders();

    /**
     * Creates the manager without any pane.
     * @param {object} services Shared services.
     * @param {ClaudeApi} services.api API client.
     * @param {ComposerSettings} services.settings Shared model options.
     * @param {CombinedConversationDirectory} services.directory Shared conversation list.
     * @param {Preferences} services.preferences Storage for the open panes and table settings.
     * @param {StatsIndex} services.stats Conversation statistics, for the panes' sub-panes.
     * @param {WidgetExtractor} services.widgetExtractor Fills a widget's placeholder slot with its real, extracted card.
     * @param {ImportedConversationStore} services.importedConversations Imported conversations, checked before the live API when opening one.
     */
    constructor(services) {
      super();
      this.#factory = new ChatPaneFactory(services, this, paneId => this.#onPaneConversationChanged(paneId));
      this.#store = new ChatPaneStore(services.preferences);
      this.#restorer = new ChatPaneRestorer(this.#store, paneId => this.#createPane(paneId));
      services.directory.subscribe('conversationDeleted', conversationId => this.#closeDeletedConversation(conversationId));
    }

    /**
     * Ids of all panes.
     * @returns {string[]} The ids, in creation order.
     */
    get paneIds() {
      return [...this.#panes.keys()];
    }

    /**
     * Number of open panes.
     * @returns {number} The count.
     */
    get paneCount() {
      return this.#panes.size;
    }

    /**
     * The focused pane.
     * @returns {string} Its id.
     */
    get focusedPaneId() {
      return this.#focusedPaneId;
    }

    /**
     * Session of the focused pane.
     * @returns {ChatSession} The session.
     */
    get focusedSession() {
      return this.#panes.get(this.#focusedPaneId).session;
    }

    /**
     * Panel of the focused pane.
     * @returns {ChatPanel} The panel.
     */
    get focusedPanel() {
      return this.#panes.get(this.#focusedPaneId).panel;
    }

    /**
     * Makes the focused pane the visible tab of its zone, so a chat that shares a zone with another
     * panel (the Files panel, say) is seen when something jumps into it.
     * @returns {void}
     */
    revealFocusedPane() {
      this.#workspace.revealPanel(this.#focusedPaneId);
    }

    /**
     * Whether an id belongs to a chat pane.
     * @param {string} panelId Panel id.
     * @returns {boolean} True for ids starting with "chat-".
     */
    static isPaneId(panelId) {
      return isChatPaneId(panelId);
    }

    /**
     * Which border a chat pane's tab and content should show; see ChatPaneBorders.kindOf.
     * @param {string} panelId Panel id.
     * @returns {?('active'|'inactive')} The border kind, or null for none.
     */
    borderKindOf(panelId) {
      return this.#borders.kindOf(panelId, this.#focusedPaneId);
    }

    /**
     * Records which panels are visible after a layout and announces when the "several chat panes
     * visible" state changes.
     * @param {Set<string>} visiblePanelIds Ids of the visible panels.
     * @returns {void}
     */
    updateVisiblePanels(visiblePanelIds) {
      if (this.#borders.update(visiblePanelIds, this.paneIds)) this.publish('visiblePanes');
    }

    /**
     * Connects the workspace that new panes are docked in.
     * @param {DockWorkspace} workspace The workspace.
     * @returns {void}
     */
    attachWorkspace(workspace) {
      this.#workspace = workspace;
    }

    /**
     * Recreates the panes stored by the last visit, or one empty pane, and focuses the pane that
     * showed the preferred conversation, otherwise the first one. Their conversations are reopened
     * later by openRestoredConversations.
     * @param {?string} preferredConversationId Conversation in the URL, or null.
     * @returns {void}
     */
    restorePanes(preferredConversationId) {
      this.#focusedPaneId = this.#restorer.restore(preferredConversationId);
    }

    /**
     * Reopens the stored conversations of every restored pane except the focused one, whose
     * conversation comes from the URL.
     * @returns {void}
     */
    openRestoredConversations() {
      this.#restorer.openRemaining(this.#focusedPaneId);
    }

    /**
     * Creates a pane with a given id for a saved layout, without docking it, and opens its conversation.
     * @param {string} paneId Pane id from the layout.
     * @param {?string} conversationId Conversation to show, or null for a new chat.
     * @returns {ChatPanel} The pane's panel.
     */
    createPaneForLayout(paneId, conversationId) {
      const pane = this.#createPane(paneId);
      if (conversationId) pane.session.openConversation(conversationId);
      this.#savePanes();
      return pane.panel;
    }

    /**
     * Every pane with its conversation, as stored.
     * @returns {Array<{paneId: string, conversationId: ?string}>} The panes in creation order.
     */
    storedPanes() {
      return [...this.#panes].map(([paneId, pane]) => ({ paneId, conversationId: pane.session.openConversationId }));
    }

    /**
     * The panel of every pane, for docking.
     * @returns {Array<[string, ChatPanel]>} [pane id, panel] pairs.
     */
    panelEntries() {
      return [...this.#panes].map(([paneId, pane]) => [paneId, pane.panel]);
    }

    /**
     * Opens a new, empty chat as a tab of a zone and focuses it.
     * @param {string} leafId Zone id.
     * @returns {void}
     */
    openPaneInZone(leafId) {
      this.#openNewPane((paneId, panel) => this.#workspace.addPanelToZone(paneId, panel, leafId), null);
    }

    /**
     * Opens a new pane next to the focused one and focuses it.
     * @param {?string} conversationId Conversation to show, or null for a new chat.
     * @returns {void}
     */
    openPane(conversationId) {
      this.#openNewPane((paneId, panel) => this.#workspace.addPanel(paneId, panel, this.#focusedPaneId), conversationId);
    }

    /**
     * Starts dragging a conversation out of the sidebar; releasing over a valid drop target opens it
     * as a new pane docked exactly there, so several chats can be composed side by side.
     * @param {MouseEvent} startEvent The mousedown that starts the drag.
     * @param {string} conversationId Conversation to open on drop.
     * @param {string} label Text shown in the floating drag label.
     * @returns {void}
     */
    beginDragToOpenPane(startEvent, conversationId, label) {
      const openAt = dropTarget => this.#openNewPane((paneId, panel) => this.#workspace.addPanelAt(paneId, panel, dropTarget), conversationId);
      this.#workspace.beginExternalDrag(startEvent, label, openAt);
    }

    /**
     * Closes a pane, stopping its reply. The last remaining pane can't be closed.
     * @param {string} paneId Pane id.
     * @returns {void}
     */
    closePane(paneId) {
      if (this.#panes.size <= 1 || !this.#panes.has(paneId)) return;
      if (this.#focusedPaneId === paneId) this.focusPane(this.paneIds.find(id => id !== paneId));
      this.#panes.get(paneId).session.stopReply();
      this.#panes.delete(paneId);
      this.#workspace.removePanel(paneId);
      this.#savePanes();
    }

    /**
     * Makes a pane the focused one.
     * @param {string} paneId Pane id; unknown ids are ignored.
     * @returns {void}
     */
    focusPane(paneId) {
      if (this.#focusedPaneId === paneId || !this.#panes.has(paneId)) return;
      this.#focusedPaneId = paneId;
      this.publish('focus');
    }

    /**
     * Opens a conversation in the focused pane.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once it is shown.
     */
    openInFocusedPane(conversationId) {
      const session = this.focusedSession;
      return session.isLoaded(conversationId) ? Promise.resolve() : session.openConversation(conversationId);
    }

    /**
     * Starts a new chat in the focused pane.
     * @returns {void}
     */
    startNewInFocusedPane() {
      this.focusedSession.startNewConversation();
    }

    /**
     * Conversations shown in any pane.
     * @returns {Set<string>} Their ids.
     */
    openConversationIds() {
      return new Set([...this.#panes.values()].map(pane => pane.session.openConversationId).filter(Boolean));
    }

    /**
     * Creates a pane, docks it, focuses it, opens its conversation and saves the panes.
     * @param {function(string, ChatPanel): void} dock Docks the new pane's panel in the workspace.
     * @param {?string} conversationId Conversation to show, or null for a new chat.
     * @returns {void}
     */
    #openNewPane(dock, conversationId) {
      const paneId = createChatPaneId();
      const pane = this.#createPane(paneId);
      dock(paneId, pane.panel);
      this.focusPane(paneId);
      if (conversationId) pane.session.openConversation(conversationId);
      this.#savePanes();
    }

    /**
     * Creates a pane and registers it.
     * @param {string} paneId Pane id.
     * @returns {{session: ChatSession, panel: ChatPanel}} The pane.
     */
    #createPane(paneId) {
      const pane = this.#factory.create(paneId);
      this.#panes.set(paneId, pane);
      return pane;
    }

    /**
     * Saves the panes and announces that a pane shows another conversation.
     * @param {string} paneId Pane id.
     * @returns {void}
     */
    #onPaneConversationChanged(paneId) {
      this.#savePanes();
      this.publish('paneConversations', paneId);
    }

    /**
     * Switches every pane showing a deleted conversation to a new chat.
     * @param {string} conversationId The deleted conversation.
     * @returns {void}
     */
    #closeDeletedConversation(conversationId) {
      [...this.#panes.values()]
        .filter(pane => pane.session.openConversationId === conversationId)
        .forEach(pane => pane.session.startNewConversation());
    }

    /**
     * Stores every pane and its conversation.
     * @returns {void}
     */
    #savePanes() {
      this.#store.write(this.storedPanes());
    }
  }

  /**
   * A non-success HTTP response from the claude.ai API.
   */
  class ApiError extends Error {
    /**
     * Creates the error.
     * @param {number} status HTTP status code.
     * @param {string} responseBody Response body; its first 200 characters become part of the message.
     */
    constructor(status, responseBody) {
      super(`${status} ${responseBody.slice(0, 200)}`.trim());
      this.name = 'ApiError';
      this.status = status;
    }

    /**
     * Creates an error from a failed response, including its body when readable.
     * @param {Response} response The failed response.
     * @returns {Promise<ApiError>} The error.
     */
    static async fromResponse(response) {
      return new ApiError(response.status, await response.text().catch(() => ''));
    }
  }

  /**
   * Incrementally splits a server-sent event stream into parsed JSON events.
   */
  class ServerSentEventDecoder {
    /**
     * Blank line separating two events.
     * @type {RegExp}
     */
    static #EVENT_SEPARATOR = /\r?\n\r?\n/;

    /**
     * Text received but not yet part of a complete event.
     * @type {string}
     */
    #pendingText = '';

    /**
     * Reads a byte stream to the end, yielding each event's parsed JSON data.
     * @param {ReadableStream<Uint8Array>} byteStream The response body.
     * @yields {object} Each event's data. Events without data or with invalid JSON are skipped.
     * @returns {AsyncGenerator<object, void, void>} The events in arrival order.
     * @throws {DOMException} An AbortError when the request is aborted mid-stream.
     */
    static async *decodeStream(byteStream) {
      const reader = byteStream.pipeThrough(new TextDecoderStream()).getReader();
      const decoder = new ServerSentEventDecoder();
      try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          yield* decoder.appendText(chunk.value);
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
    }

    /**
     * Adds received text and returns every event it completes.
     * @param {string} text Newly received text.
     * @returns {object[]} Parsed data of the completed events, in order.
     */
    appendText(text) {
      this.#pendingText += text;
      const events = [];
      for (let separator = this.#findSeparator(); separator; separator = this.#findSeparator()) {
        events.push(...ServerSentEventDecoder.#parseEvent(this.#pendingText.slice(0, separator.index)));
        this.#pendingText = this.#pendingText.slice(separator.index + separator[0].length);
      }
      return events;
    }

    /**
     * Finds the first event separator in the pending text.
     * @returns {?RegExpExecArray} The match, or null when no event is complete.
     */
    #findSeparator() {
      return ServerSentEventDecoder.#EVENT_SEPARATOR.exec(this.#pendingText);
    }

    /**
     * Parses one raw event, joining multiple data lines as the SSE format specifies.
     * @param {string} rawEvent Raw event text.
     * @returns {object[]} The parsed data as a single-element array, or an empty array when the event has no data or invalid JSON.
     */
    static #parseEvent(rawEvent) {
      const data = rawEvent.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n');
      try {
        return data ? [JSON.parse(data)] : [];
      } catch {
        return [];
      }
    }
  }

  /**
   * The browser's IANA time zone.
   * @returns {string} The time zone name, or "UTC" when unavailable.
   */
  function currentTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  /**
   * Serializes a value as gzip-compressed JSON, the body format the completion endpoint requires.
   * @param {*} value JSON-serializable value.
   * @returns {Promise<Uint8Array>} The compressed bytes.
   */
  async function gzipJson(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const compressedStream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(compressedStream).arrayBuffer());
  }

  /**
   * Reads a cookie of the current page.
   * @param {string} name Cookie name.
   * @returns {?string} The decoded value, or null when the cookie isn't set.
   */
  function readCookie(name) {
    const cookie = document.cookie.split('; ').find(entry => entry.startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
  }

  /**
   * Locale tags the completion endpoint accepts. navigator.language (e.g. "en-GB", "de") is
   * usually not one of them, and sending it gets the request rejected with a 400.
   * @type {ReadonlyArray<string>}
   */
  const ALLOWED_LOCALES = Object.freeze(['en-US', 'de-DE', 'fr-FR', 'ko-KR', 'ja-JP', 'es-419', 'es-ES', 'it-IT', 'hi-IN', 'pt-BR', 'id-ID']);

  /**
   * Locale used when the browser language has no accepted equivalent.
   * @type {string}
   */
  const DEFAULT_LOCALE = 'en-US';

  /**
   * The browser language mapped to a locale the completion endpoint accepts: an exact match, else
   * the first accepted locale of the same language, else DEFAULT_LOCALE.
   * @returns {string} An entry of ALLOWED_LOCALES.
   */
  function resolveLocale() {
    const language = navigator.language || DEFAULT_LOCALE;
    if (ALLOWED_LOCALES.includes(language)) return language;
    const baseLanguage = language.split('-')[0];
    return ALLOWED_LOCALES.find(locale => locale.startsWith(`${baseLanguage}-`)) ?? DEFAULT_LOCALE;
  }

  /**
   * Client for claude.ai's internal API, the only source of data and actions for the whole UI.
   */
  class ClaudeApi {
    /**
     * The organization id, resolved once; null before first use or after a failure.
     * @type {?Promise<string>}
     */
    #organizationIdPromise = null;

    /**
     * Lists conversations, most recently updated first.
     * @param {number} offset Number of conversations to skip.
     * @param {number} limit Maximum number to return.
     * @returns {Promise<ConversationListing[]>} The page of conversations.
     * @throws {ApiError} When the request fails.
     */
    listConversations(offset, limit) {
      return this.#getJson('/chat_conversations', { limit, offset });
    }

    /**
     * Fetches a conversation with every message of every branch.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<ApiConversation>} The conversation.
     * @throws {ApiError} When the request fails.
     */
    getConversation(conversationId) {
      return this.#getJson(`/chat_conversations/${conversationId}`, { tree: 'True', rendering_mode: 'messages', render_all_tools: 'true' });
    }

    /**
     * Permanently deletes a conversation.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once deleted.
     * @throws {ApiError} When the request fails.
     */
    async deleteConversation(conversationId) {
      await this.#fetchSuccessful(await this.#organizationUrl(`/chat_conversations/${conversationId}`, {}), { method: 'DELETE' });
    }

    /**
     * Fetches the current usage windows.
     * @returns {Promise<RateLimits>} The five-hour and weekly windows.
     * @throws {ApiError} When the request fails.
     */
    async getUsage() {
      const usage = await this.#getJson('/usage', {});
      return { fiveHour: usage.five_hour, sevenDay: usage.seven_day };
    }

    /**
     * Uploads a file for attaching to a prompt. The conversation id must be the one the prompt itself
     * will use: for a chat that hasn't sent its first message yet, that's the id the caller intends
     * to reuse as the new conversation's id, not one generated fresh at send time.
     * @param {string} conversationId Conversation the file will be attached in.
     * @param {File} file File to upload.
     * @returns {Promise<UploadedFile>} The server's record of the upload.
     * @throws {ApiError} When the request fails.
     */
    async uploadFile(conversationId, file) {
      const body = new FormData();
      body.append('file', file);
      const url = await this.#organizationUrl(`/conversations/${conversationId}/wiggle/upload-file`, {});
      const response = await this.#fetchSuccessful(url, { method: 'POST', body });
      return response.json();
    }

    /**
     * Sets which leaf message a conversation's branch navigation shows, persisting a branch switch
     * server-side so it survives a reload.
     * @param {string} conversationId Conversation id.
     * @param {string} leafMessageId Id of the message to show as the current leaf.
     * @returns {Promise<void>} Resolves once set.
     * @throws {ApiError} When the request fails.
     */
    async setCurrentLeafMessage(conversationId, leafMessageId) {
      const url = await this.#organizationUrl(`/chat_conversations/${conversationId}/current_leaf_message_uuid`, {});
      await this.#fetchSuccessful(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_leaf_message_uuid: leafMessageId }),
      });
    }

    /**
     * Sends a prompt and streams the reply. The first event has type STREAM_START and carries the
     * client-generated humanMessageId and assistantMessageId; every following event is a parsed
     * server-sent event.
     * @param {object} request The prompt to send.
     * @param {string} request.conversationId Conversation id; a new random id when isNew.
     * @param {string} request.prompt Prompt text.
     * @param {string} request.parentMessageId Message to reply to; ignored when isNew.
     * @param {boolean} request.isNew Whether this creates the conversation.
     * @param {ComposerSnapshot} request.settings Model options.
     * @param {string[]} [request.fileUuids] Ids of files uploaded beforehand to attach.
     * @param {object[]} [request.attachments] Inline attachments that aren't uploads, such as a quoted passage.
     * @param {AbortSignal} request.signal Aborts the request and the stream.
     * @yields {StreamEvent} The start event, then each server-sent event.
     * @returns {AsyncGenerator<StreamEvent, void, void>} The events in order.
     * @throws {ApiError} When the server rejects the request.
     * @throws {DOMException} An AbortError when aborted.
     */
    async *streamCompletion({ conversationId, prompt, parentMessageId, isNew, settings, fileUuids, attachments, signal }) {
      const body = ClaudeApi.#buildCompletionBody({ prompt, parentMessageId, isNew, settings, fileUuids, attachments });
      const response = await this.#fetchSuccessful(await this.#organizationUrl(`/chat_conversations/${conversationId}/completion`, {}), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'text/event-stream', 'Content-Encoding': 'gzip' },
        body: await gzipJson(body),
        signal,
      });
      const messageIds = body.turn_message_uuids;
      yield { type: STREAM_START, humanMessageId: messageIds.human_message_uuid, assistantMessageId: messageIds.assistant_message_uuid };
      yield* ServerSentEventDecoder.decodeStream(response.body);
    }

    /**
     * Builds a completion request body.
     * @param {object} request The prompt to send.
     * @param {string} request.prompt Prompt text.
     * @param {string} request.parentMessageId Message to reply to; ignored when isNew.
     * @param {boolean} request.isNew Whether to create the conversation.
     * @param {ComposerSnapshot} request.settings Model options.
     * @param {string[]} [request.fileUuids] Ids of files uploaded beforehand to attach.
     * @param {object[]} [request.attachments] Inline attachments that aren't uploads, such as a quoted passage.
     * @returns {object} The body, with conversation-creation parameters or a parent message id.
     */
    static #buildCompletionBody({ prompt, parentMessageId, isNew, settings, fileUuids, attachments }) {
      const body = {
        prompt,
        timezone: currentTimezone(),
        locale: resolveLocale(),
        model: settings.model,
        effort: settings.effort,
        thinking_mode: settings.thinkingMode,
        tools: [],
        turn_message_uuids: { human_message_uuid: crypto.randomUUID(), assistant_message_uuid: crypto.randomUUID() },
        attachments: attachments ?? [],
        files: fileUuids ?? [],
        sync_sources: [],
        completion_request_id: crypto.randomUUID(),
        rendering_mode: 'messages',
      };
      return isNew
        ? { ...body, create_conversation_params: ClaudeApi.#newConversationParameters(settings.model) }
        : { ...body, parent_message_uuid: parentMessageId };
    }

    /**
     * Parameters for creating a conversation with the first completion.
     * @param {string} model Model id of the new conversation.
     * @returns {object} The create_conversation_params object.
     */
    static #newConversationParameters(model) {
      return {
        name: '', model, include_conversation_preferences: true,
        paprika_mode: null, compass_mode: null, tool_search_mode: 'auto',
        is_temporary: false, chat_memory_mode: 'enabled', enabled_imagine: false,
      };
    }

    /**
     * GETs an organization-scoped endpoint and parses the JSON response.
     * @param {string} path Path below the organization.
     * @param {Object<string, string|number>} queryParameters Query parameters.
     * @returns {Promise<*>} The parsed body.
     * @throws {ApiError} When the request fails.
     */
    async #getJson(path, queryParameters) {
      const response = await this.#fetchSuccessful(await this.#organizationUrl(path, queryParameters), {});
      return response.json();
    }

    /**
     * Fetches a URL and rejects non-success responses.
     * @param {string} url Request URL.
     * @param {RequestInit} requestOptions Fetch options.
     * @returns {Promise<Response>} The successful response.
     * @throws {ApiError} When the response status isn't 2xx.
     */
    async #fetchSuccessful(url, requestOptions) {
      const response = await fetch(url, requestOptions);
      if (!response.ok) throw await ApiError.fromResponse(response);
      return response;
    }

    /**
     * URL of an organization-scoped endpoint.
     * @param {string} path Path below the organization.
     * @param {Object<string, string|number>} queryParameters Query parameters; may be empty.
     * @returns {Promise<string>} The URL.
     * @throws {ApiError} When the organization can't be resolved.
     */
    async #organizationUrl(path, queryParameters) {
      const query = new URLSearchParams(queryParameters).toString();
      const baseUrl = `/api/organizations/${await this.#resolveOrganizationId()}${path}`;
      return query ? `${baseUrl}?${query}` : baseUrl;
    }

    /**
     * The organization id, resolved once and cached. A failed lookup is retried on the next call.
     * @returns {Promise<string>} The organization id.
     * @throws {ApiError|Error} When the organizations can't be listed or none exist.
     */
    #resolveOrganizationId() {
      this.#organizationIdPromise ??= this.#fetchOrganizationId().catch((error) => {
        this.#organizationIdPromise = null;
        throw error;
      });
      return this.#organizationIdPromise;
    }

    /**
     * Lists the user's organizations and chooses one.
     * @returns {Promise<string>} The chosen organization id.
     * @throws {ApiError|Error} When the request fails or returns no organizations.
     */
    async #fetchOrganizationId() {
      const response = await this.#fetchSuccessful('/api/organizations', {});
      return ClaudeApi.#chooseOrganization(await response.json()).uuid;
    }

    /**
     * Chooses the organization claude.ai itself last used (its lastActiveOrg cookie), so accounts in
     * several organizations see the same data as the native app; otherwise the first one.
     * @param {Array<{uuid: string}>} organizations Organizations returned by the API.
     * @returns {{uuid: string}} The chosen organization.
     * @throws {Error} When the list is empty or not an array.
     */
    static #chooseOrganization(organizations) {
      if (!Array.isArray(organizations) || organizations.length === 0) throw new Error('no organizations returned');
      const lastActiveId = readCookie('lastActiveOrg');
      return organizations.find(organization => organization.uuid === lastActiveId) ?? organizations[0];
    }
  }

  /**
   * The only thinking modes the completion endpoint accepts; 'off' is the default.
   * @type {Readonly<{off: string, extended: string}>}
   */
  const THINKING_MODES = Object.freeze({ off: 'off', extended: 'extended' });

  /**
   * HTML for the options of a select element.
   * @param {ReadonlyArray<ChoiceOption>} options The options.
   * @param {string} selectedId Value of the option to preselect.
   * @returns {string} The option elements.
   */
  function optionsHtml(options, selectedId) {
    return options.map(option => `<option value="${escapeHtml(option.id)}"${option.id === selectedId ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
  }

  /**
   * The composer's model, effort and extended thinking controls, kept in sync with the shared
   * composer settings in both directions.
   */
  class ComposerOptionsView {
    /**
     * Shared model options.
     * @type {ComposerSettings}
     */
    #settings;

    /**
     * Model select.
     * @type {HTMLSelectElement}
     */
    #modelSelect;

    /**
     * Effort select.
     * @type {HTMLSelectElement}
     */
    #effortSelect;

    /**
     * Extended thinking checkbox.
     * @type {HTMLInputElement}
     */
    #thinkingCheckbox;

    /**
     * Wires the controls to the settings and shows the current settings.
     * @param {object} controls The option controls.
     * @param {HTMLSelectElement} controls.modelSelect Model select.
     * @param {HTMLSelectElement} controls.effortSelect Effort select.
     * @param {HTMLInputElement} controls.thinkingCheckbox Extended thinking checkbox.
     * @param {ComposerSettings} settings Shared model options.
     */
    constructor({ modelSelect, effortSelect, thinkingCheckbox }, settings) {
      this.#settings = settings;
      this.#modelSelect = modelSelect;
      this.#effortSelect = effortSelect;
      this.#thinkingCheckbox = thinkingCheckbox;
      modelSelect.addEventListener('change', () => { settings.model = modelSelect.value; });
      effortSelect.addEventListener('change', () => { settings.effort = effortSelect.value; });
      thinkingCheckbox.addEventListener('change', () => { settings.thinkingMode = thinkingCheckbox.checked ? THINKING_MODES.extended : THINKING_MODES.off; });
      this.showSettings();
    }

    /**
     * Rebuilds the model and effort options from a freshly extracted catalog, then reapplies the
     * current settings (falling back to the new default when the previously selected id disappeared).
     * @param {ModelCatalog} modelCatalog The selectable models and effort levels.
     * @returns {void}
     */
    refreshChoices(modelCatalog) {
      this.#modelSelect.innerHTML = optionsHtml(modelCatalog.models, this.#settings.model);
      this.#effortSelect.innerHTML = optionsHtml(modelCatalog.efforts, this.#settings.effort);
      this.showSettings();
    }

    /**
     * Shows the current shared options in the controls.
     * @returns {void}
     */
    showSettings() {
      this.#modelSelect.value = this.#settings.model;
      this.#effortSelect.value = this.#settings.effort;
      this.#thinkingCheckbox.checked = this.#settings.thinkingMode === THINKING_MODES.extended;
    }

    /**
     * Disables or re-enables every control, for a read-only chat with no model to reply to.
     * @param {boolean} isDisabled Whether to disable them.
     * @returns {void}
     */
    setDisabled(isDisabled) {
      this.#modelSelect.disabled = isDisabled;
      this.#effortSelect.disabled = isDisabled;
      this.#thinkingCheckbox.disabled = isDisabled;
    }
  }

  var stylesheet$f = ".claude-plus-dialog-overlay {\r\n  position: fixed;\r\n  inset: 0;\r\n  z-index: var(--claude-plus-layer-drag-label);\r\n  background: rgba(0, 0, 0, 0.5);\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n}\r\n\r\n.claude-plus-dialog {\r\n  background: var(--claude-plus-color-raised);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 8px;\r\n  padding: 16px;\r\n  max-width: 360px;\r\n  font-size: 13px;\r\n}\r\n\r\n.claude-plus-dialog__message {\r\n  margin: 0 0 14px;\r\n  line-height: 1.4;\r\n}\r\n\r\n.claude-plus-dialog__input {\r\n  width: 100%;\r\n  box-sizing: border-box;\r\n  margin: 0 0 14px;\r\n  padding: 6px 8px;\r\n  background: var(--claude-plus-color-bar);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  color: var(--claude-plus-color-text);\r\n  font: inherit;\r\n}\r\n\r\n.claude-plus-dialog__actions {\r\n  display: flex;\r\n  justify-content: flex-end;\r\n  gap: 8px;\r\n}\r\n";

  StyleRegistry.register(stylesheet$f);

  /**
   * A small themed dialog box with a message, an optional body and a row of action buttons. It
   * replaces the native alert(), confirm() and prompt(), which Chrome silently disables ("prevent
   * this page from creating additional dialogs") after repeated use, making buttons appear to do
   * nothing. Subclasses supply the action buttons and optionally a body.
   * @abstract
   */
  class ActionDialog extends Dialog {
    /**
     * Message shown on top.
     * @type {string}
     */
    #message;

    /**
     * Creates the dialog without showing it.
     * @param {string} message Message shown on top.
     */
    constructor(message) {
      super();
      this.#message = message;
    }

    /**
     * CSS class of the dimmed overlay centering the box.
     * @returns {string} The class name.
     */
    get overlayClassName() {
      return 'claude-plus-dialog-overlay';
    }

    /**
     * Builds the box with the message, the body and the actions.
     * @returns {HTMLElement[]} The dialog box.
     */
    createContent() {
      const message = createElement('p', { className: 'claude-plus-dialog__message', textContent: this.#message });
      const actions = createElement('div', { className: 'claude-plus-dialog__actions' });
      actions.append(...this.createActions());
      const box = createElement('div', { className: 'claude-plus-dialog' });
      box.append(message, ...this.createBody(), actions);
      return [box];
    }

    /**
     * Builds the elements between the message and the actions.
     * @returns {HTMLElement[]} The body elements; none unless overridden.
     */
    createBody() {
      return [];
    }

    /**
     * Builds the action buttons.
     * @abstract
     * @returns {HTMLButtonElement[]} The buttons, left to right.
     * @throws {Error} When a subclass does not override it.
     */
    createActions() {
      throw new Error(`${this.constructor.name} must override createActions`);
    }

    /**
     * Creates a button that closes the dialog with a result.
     * @param {string} label Button text.
     * @param {boolean} isPrimary Whether it is the highlighted main action.
     * @param {function(): *} resultOnClick Returns the dialog result when the button is clicked.
     * @returns {HTMLButtonElement} The button.
     */
    createClosingButton(label, isPrimary, resultOnClick) {
      const className = isPrimary ? 'claude-plus-primary-button' : 'claude-plus-toolbar__button';
      const button = createElement('button', { className, textContent: label });
      button.addEventListener('click', () => this.close(resultOnClick()));
      return button;
    }
  }

  /**
   * Shows a message with a single OK button; the themed replacement of alert().
   */
  class AlertDialog extends ActionDialog {
    /**
     * Shows a message and waits until it is dismissed.
     * @param {string} message Message to show.
     * @returns {Promise<void>} Resolves once dismissed.
     */
    static inform(message) {
      return new AlertDialog(message).show();
    }

    /**
     * Builds the OK button.
     * @returns {HTMLButtonElement[]} The button.
     */
    createActions() {
      return [this.createClosingButton('OK', true, () => undefined)];
    }
  }

  /**
   * Display title of a conversation without a title.
   * @type {string}
   */
  const UNTITLED = '(untitled)';

  /**
   * Converts an API conversation into the format-neutral ExportedConversation.
   */
  class ConversationExportBuilder {
    /**
     * Converter per API content block type; other types are kept whole as 'other' blocks.
     * @type {Map<string, function(ContentBlock): ExportedBlock>}
     */
    static #BLOCK_CONVERTERS = new Map([
      ['text', block => ({ type: 'text', text: block.text || '' })],
      ['tool_use', block => ({ type: 'toolCall', name: block.name || null, input: block.input ?? null })],
      ['tool_result', block => ({ type: 'toolResult', name: block.name || null, content: block.content ?? null })],
    ]);

    /**
     * Converts the branch of a conversation that claude.ai shows.
     * @param {ApiConversation} conversation The conversation, with every message.
     * @returns {ExportedConversation} The exportable conversation.
     */
    static build(conversation) {
      return {
        id: conversation.uuid,
        title: conversation.name || UNTITLED,
        createdAt: conversation.created_at ?? null,
        updatedAt: conversation.updated_at,
        exportedAt: new Date().toISOString(),
        messages: ConversationTree.currentBranch(conversation).map(message => ConversationExportBuilder.#convertMessage(message)),
      };
    }

    /**
     * Converts one message.
     * @param {ApiMessage} message The message.
     * @returns {ExportedMessage} The exportable message.
     */
    static #convertMessage(message) {
      return {
        id: message.uuid,
        parentId: message.parent_message_uuid ?? null,
        sender: message.sender,
        createdAt: message.created_at ?? null,
        attachments: MessageContent.uploads(message).map(upload => MessageContent.uploadName(upload)),
        blocks: ConversationExportBuilder.#convertBlocks(message),
      };
    }

    /**
     * Converts a message's content blocks; a plain text field becomes a leading text block when the
     * content has no text of its own.
     * @param {ApiMessage} message The message.
     * @returns {ExportedBlock[]} The blocks, in order.
     */
    static #convertBlocks(message) {
      const blocks = (message.content ?? []).map(block => ConversationExportBuilder.#convertBlock(block));
      const hasTextBlock = blocks.some(block => block.type === 'text');
      return message.text && !hasTextBlock ? [{ type: 'text', text: message.text }, ...blocks] : blocks;
    }

    /**
     * Converts one content block.
     * @param {ContentBlock} block The block.
     * @returns {ExportedBlock} The exportable block.
     */
    static #convertBlock(block) {
      const convert = ConversationExportBuilder.#BLOCK_CONVERTERS.get(block.type);
      return convert ? convert(block) : { type: 'other', originalType: block.type, content: block };
    }
  }

  /**
   * Exports a conversation as JSON: the ExportedConversation, pretty-printed.
   */
  class JsonConversationFormat {
    /**
     * Name shown in the export menu.
     * @type {string}
     */
    static label = 'JSON';

    /**
     * File extension.
     * @type {string}
     */
    static extension = 'json';

    /**
     * MIME type.
     * @type {string}
     */
    static mimeType = 'application/json';

    /**
     * Converts a conversation to JSON.
     * @param {ExportedConversation} conversation The conversation.
     * @returns {string} The JSON document.
     */
    static serialize(conversation) {
      return `${JSON.stringify(conversation, null, 2)}\n`;
    }
  }

  /**
   * Wraps content in a markdown code fence longer than any backtick run inside it, so the content
   * can't close the fence early.
   * @param {string} content Code to wrap.
   * @param {string} language Language tag after the opening fence; may be empty.
   * @returns {string} The fenced block.
   */
  function markdownCodeFence(content, language) {
    const longestBacktickRun = Math.max(2, ...(content.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longestBacktickRun + 1);
    return `${fence}${language}\n${content}\n${fence}`;
  }

  /**
   * Exports a conversation as a readable Markdown document. Message text is kept as written; tool
   * calls, tool results and unrecognised blocks become collapsible sections with their JSON.
   */
  class MarkdownConversationFormat {
    /**
     * Name shown in the export menu.
     * @type {string}
     */
    static label = 'Markdown';

    /**
     * File extension.
     * @type {string}
     */
    static extension = 'md';

    /**
     * MIME type.
     * @type {string}
     */
    static mimeType = 'text/markdown';

    /**
     * Heading name per sender.
     * @type {Readonly<Record<string, string>>}
     */
    static #SENDER_NAMES = Object.freeze({ human: 'You', assistant: 'Claude' });

    /**
     * Writer per exported block type.
     * @type {Map<string, function(ExportedBlock): string>}
     */
    static #BLOCK_WRITERS = new Map([
      ['text', block => block.text],
      ['toolCall', block => MarkdownConversationFormat.#collapsibleJson(`Tool call: ${block.name || 'tool'}`, block.input)],
      ['toolResult', block => MarkdownConversationFormat.#collapsibleJson(block.name ? `Tool result: ${block.name}` : 'Tool result', block.content)],
      ['other', block => MarkdownConversationFormat.#collapsibleJson(`Content block: ${block.originalType}`, block.content)],
    ]);

    /**
     * Converts a conversation to Markdown.
     * @param {ExportedConversation} conversation The conversation.
     * @returns {string} The document: a header with the conversation details, then one section per message.
     */
    static serialize(conversation) {
      const sections = [MarkdownConversationFormat.#headerMarkdown(conversation), ...conversation.messages.map(message => MarkdownConversationFormat.#messageMarkdown(message))];
      return `${sections.join('\n\n---\n\n')}\n`;
    }

    /**
     * Title and details of the conversation.
     * @param {ExportedConversation} conversation The conversation.
     * @returns {string} The header.
     */
    static #headerMarkdown(conversation) {
      return [
        `# ${conversation.title}`,
        '',
        `- Conversation: ${conversation.id}`,
        `- Created: ${conversation.createdAt ?? 'unknown'}`,
        `- Last updated: ${conversation.updatedAt}`,
        `- Exported: ${conversation.exportedAt}`,
      ].join('\n');
    }

    /**
     * One message: a heading with sender and time, its attachments and its blocks.
     * @param {ExportedMessage} message The message.
     * @returns {string} The section.
     */
    static #messageMarkdown(message) {
      const heading = `## ${MarkdownConversationFormat.#SENDER_NAMES[message.sender] ?? message.sender} · ${message.createdAt ?? 'unknown time'}`;
      const attachments = message.attachments.length ? `Attachments: ${message.attachments.join(', ')}` : '';
      const blocks = message.blocks.map(block => MarkdownConversationFormat.#BLOCK_WRITERS.get(block.type)(block));
      return [heading, attachments, ...blocks].filter(Boolean).join('\n\n');
    }

    /**
     * A collapsible section holding a value as pretty-printed JSON.
     * @param {string} summary Always-visible summary text.
     * @param {*} value Value to show.
     * @returns {string} The section as HTML details wrapping a JSON code block.
     */
    static #collapsibleJson(summary, value) {
      return `<details>\n<summary>${escapeHtml(summary)}</summary>\n\n${markdownCodeFence(JSON.stringify(value, null, 2), 'json')}\n\n</details>`;
    }
  }

  /**
   * Characters XML 1.0 doesn't allow in documents, even escaped.
   * @type {RegExp}
   */
  const XML_FORBIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

  /**
   * Escapes a value for XML text or attribute values and drops characters XML can't contain.
   * @param {*} value Value to escape; null and undefined become an empty string.
   * @returns {string} The escaped string.
   */
  function escapeXml(value) {
    return escapeHtml(String(value ?? '').replace(XML_FORBIDDEN_CHARACTERS, ''));
  }

  /**
   * Exports a conversation as an XML document. Tool inputs, tool results and unrecognised blocks are
   * stored as escaped JSON text; text content is escaped, never wrapped in CDATA.
   */
  class XmlConversationFormat {
    /**
     * Name shown in the export menu.
     * @type {string}
     */
    static label = 'XML';

    /**
     * File extension.
     * @type {string}
     */
    static extension = 'xml';

    /**
     * MIME type.
     * @type {string}
     */
    static mimeType = 'application/xml';

    /**
     * Writer per exported block type.
     * @type {Map<string, function(ExportedBlock): string>}
     */
    static #BLOCK_WRITERS = new Map([
      ['text', block => XmlConversationFormat.#element('text', {}, block.text)],
      ['toolCall', block => XmlConversationFormat.#element('toolCall', { name: block.name }, JSON.stringify(block.input, null, 2))],
      ['toolResult', block => XmlConversationFormat.#element('toolResult', { name: block.name }, JSON.stringify(block.content, null, 2))],
      ['other', block => XmlConversationFormat.#element('contentBlock', { type: block.originalType }, JSON.stringify(block.content, null, 2))],
    ]);

    /**
     * Converts a conversation to XML.
     * @param {ExportedConversation} conversation The conversation.
     * @returns {string} The XML document with a conversation root element holding one message element per message.
     */
    static serialize(conversation) {
      const { id, title, createdAt, updatedAt, exportedAt } = conversation;
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<conversation${XmlConversationFormat.#attributes({ id, title, createdAt, updatedAt, exportedAt })}>`,
        ...conversation.messages.map(message => XmlConversationFormat.#messageXml(message)),
        '</conversation>',
        '',
      ].join('\n');
    }

    /**
     * One message element with its attachments and blocks.
     * @param {ExportedMessage} message The message.
     * @returns {string} The element.
     */
    static #messageXml(message) {
      const { id, parentId, sender, createdAt } = message;
      const children = [
        ...message.attachments.map(name => `<attachment${XmlConversationFormat.#attributes({ name })}/>`),
        ...message.blocks.map(block => XmlConversationFormat.#BLOCK_WRITERS.get(block.type)(block)),
      ];
      return [`  <message${XmlConversationFormat.#attributes({ id, parentId, sender, createdAt })}>`, ...children.map(child => `    ${child}`), '  </message>'].join('\n');
    }

    /**
     * An element with attributes and escaped text content.
     * @param {string} name Element name.
     * @param {Object<string, ?string>} attributes Attributes; null and undefined values are left out.
     * @param {?string} text Text content.
     * @returns {string} The element.
     */
    static #element(name, attributes, text) {
      return `<${name}${XmlConversationFormat.#attributes(attributes)}>${escapeXml(text)}</${name}>`;
    }

    /**
     * Attribute list of an element.
     * @param {Object<string, ?string>} attributes Attributes; null and undefined values are left out.
     * @returns {string} The attributes, each preceded by a space.
     */
    static #attributes(attributes) {
      return Object.entries(attributes)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
        .join('');
    }
  }

  /**
   * Lets the browser save text as a file.
   * @param {string} fileName Suggested file name.
   * @param {string} content File content.
   * @param {string} mimeType MIME type of the content.
   * @returns {void}
   */
  function downloadTextFile(fileName, content, mimeType) {
    const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
    const link = createElement('a', { href: url, download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), TIMING.downloadUrlLifetimeMs);
  }

  /**
   * Characters not allowed in file names on common operating systems.
   * @type {RegExp}
   */
  const FILE_NAME_FORBIDDEN_CHARACTERS = /[\\/:*?"<>|\u0000-\u001F]+/g;

  /**
   * Makes a conversation title usable in a file name.
   * @param {string} title Conversation title.
   * @returns {string} The title without forbidden characters and shortened, or "conversation" if nothing remains.
   */
  function fileNameFromTitle(title) {
    const cleaned = title.replace(FILE_NAME_FORBIDDEN_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.slice(0, LIMITS.exportFileNameLength).trim() || 'conversation';
  }

  /**
   * Exports the focused pane's conversation to a file, fetching it fresh so the export is complete.
   */
  class ConversationExporter {
    /**
     * Available formats by id, in menu order.
     * @type {Map<string, ExportFormat>}
     */
    static FORMATS = new Map([
      ['markdown', MarkdownConversationFormat],
      ['json', JsonConversationFormat],
      ['xml', XmlConversationFormat],
    ]);

    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Chat panes, for the focused pane's conversation.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Creates the exporter.
     * @param {ClaudeApi} api API client.
     * @param {ChatPaneManager} paneManager Chat panes, for the focused pane's conversation.
     */
    constructor(api, paneManager) {
      this.#api = api;
      this.#paneManager = paneManager;
    }

    /**
     * Downloads the focused pane's conversation in a format. Does nothing in an unsaved new chat; a
     * failure is logged and shown in an alert.
     * @param {string} formatId Key of ConversationExporter.FORMATS.
     * @returns {Promise<void>} Resolves once the download has started or failed.
     */
    async exportOpenConversation(formatId) {
      const conversationId = this.#paneManager.focusedSession.openConversationId;
      if (!conversationId) return;
      try {
        const conversation = ConversationExportBuilder.build(await this.#api.getConversation(conversationId));
        ConversationExporter.#download(conversation, ConversationExporter.FORMATS.get(formatId));
      } catch (error) {
        console.warn(LOG_PREFIX, 'export failed', error);
        await AlertDialog.inform(`Export failed: ${error.message}`);
      }
    }

    /**
     * Serializes a conversation and lets the browser save it as "<title> <date>.<extension>".
     * @param {ExportedConversation} conversation The conversation.
     * @param {ExportFormat} format Target format.
     * @returns {void}
     */
    static #download(conversation, format) {
      const fileName = `${fileNameFromTitle(conversation.title)} ${conversation.updatedAt.slice(0, 10)}.${format.extension}`;
      downloadTextFile(fileName, format.serialize(conversation), format.mimeType);
    }
  }

  var stylesheet$e = ".claude-plus-popup-menu {\r\n  position: fixed;\r\n  z-index: var(--claude-plus-layer-popup-menu);\r\n  background: var(--claude-plus-color-raised);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  padding: 4px;\r\n  min-width: 140px;\r\n  font-size: 12px;\r\n}\r\n\r\n.claude-plus-popup-menu__entry {\r\n  padding: 6px 10px;\r\n  cursor: pointer;\r\n  border-radius: 4px;\r\n}\r\n\r\n.claude-plus-popup-menu__entry:hover {\r\n  background: var(--claude-plus-color-raised-hover);\r\n}\r\n";

  StyleRegistry.register(stylesheet$e);

  /**
   * A small menu at the pointer that closes on selection or on a press outside it.
   */
  class PopupMenu {
    /**
     * The open menu, or null.
     * @type {?HTMLElement}
     */
    #menuElement = null;

    /**
     * Called with the selected entry's id.
     * @type {?function(string): void}
     */
    #onSelect = null;

    /**
     * Opens the menu, replacing one already open.
     * @param {object} options Menu contents.
     * @param {number} options.left Left edge in viewport pixels.
     * @param {number} options.top Top edge in viewport pixels.
     * @param {ChoiceOption[]} options.entries Entries.
     * @param {function(string): void} options.onSelect Called with the id of the chosen entry.
     * @returns {void}
     */
    open({ left, top, entries, onSelect }) {
      this.close();
      this.#onSelect = onSelect;
      this.#menuElement = createElement('div', {
        className: 'claude-plus-themed claude-plus-popup-menu',
        innerHTML: entries.map(entry => `<div class="claude-plus-popup-menu__entry" data-entry-id="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</div>`).join(''),
      });
      Object.assign(this.#menuElement.style, { left: `${left}px`, top: `${top}px` });
      this.#menuElement.addEventListener('click', this.#handleEntryClick);
      document.body.append(this.#menuElement);
      document.addEventListener('mousedown', this.#handleOutsidePress, true);
    }

    /**
     * Closes the menu if open.
     * @returns {void}
     */
    close() {
      if (!this.#menuElement) return;
      this.#menuElement.remove();
      this.#menuElement = null;
      document.removeEventListener('mousedown', this.#handleOutsidePress, true);
    }

    /**
     * Selects the clicked entry and closes the menu.
     * @param {MouseEvent} event Click inside the menu.
     * @returns {void}
     */
    #handleEntryClick = (event) => {
      const entry = event.target.closest('.claude-plus-popup-menu__entry');
      if (!entry) return;
      const onSelect = this.#onSelect;
      this.close();
      onSelect(entry.dataset.entryId);
    };

    /**
     * Closes the menu when the pointer is pressed outside it.
     * @param {MouseEvent} event Mouse press anywhere.
     * @returns {void}
     */
    #handleOutsidePress = (event) => {
      if (!this.#menuElement.contains(event.target)) this.close();
    };
  }

  /**
   * A button opening a menu of the export formats below it; choosing one exports the active chat.
   */
  class ExportMenuButton {
    /**
     * Distance in pixels between the button and the menu.
     * @type {number}
     */
    static #MENU_GAP = 4;

    /**
     * The button.
     * @type {HTMLButtonElement}
     */
    #button;

    /**
     * Exports the active chat.
     * @type {ConversationExporter}
     */
    #exporter;

    /**
     * Menu listing the export formats.
     * @type {PopupMenu}
     */
    #formatMenu = new PopupMenu();

    /**
     * Wires the button.
     * @param {HTMLButtonElement} button The button.
     * @param {ConversationExporter} exporter Exports the active chat.
     */
    constructor(button, exporter) {
      this.#button = button;
      this.#exporter = exporter;
      button.addEventListener('click', () => this.#openFormatMenu());
    }

    /**
     * Enables or disables the button; only a saved conversation can be exported.
     * @param {boolean} isEnabled Whether exporting is possible.
     * @returns {void}
     */
    setEnabled(isEnabled) {
      this.#button.disabled = !isEnabled;
    }

    /**
     * Closes the menu if open.
     * @returns {void}
     */
    close() {
      this.#formatMenu.close();
    }

    /**
     * Opens the format menu below the button.
     * @returns {void}
     */
    #openFormatMenu() {
      const bounds = this.#button.getBoundingClientRect();
      this.#formatMenu.open({
        left: bounds.left,
        top: bounds.bottom + ExportMenuButton.#MENU_GAP,
        entries: [...ConversationExporter.FORMATS].map(([formatId, format]) => ({ id: formatId, label: format.label })),
        onSelect: formatId => this.#exporter.exportOpenConversation(formatId),
      });
    }
  }

  var stylesheet$d = ".claude-plus-pending-quote {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  background: var(--claude-plus-color-button);\n  border-radius: 6px;\n  padding: 4px 8px;\n  font-size: 12px;\n  max-width: 100%;\n}\n\n.claude-plus-pending-quote__label {\n  color: var(--claude-plus-color-text-muted);\n  flex-shrink: 0;\n}\n\n.claude-plus-pending-quote__preview {\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.claude-plus-pending-quote__remove {\n  background: none;\n  border: none;\n  color: var(--claude-plus-color-text-muted);\n  cursor: pointer;\n  font-size: 14px;\n  line-height: 1;\n  padding: 0 2px;\n  margin-left: auto;\n}\n\n.claude-plus-pending-quote__remove:hover {\n  color: var(--claude-plus-color-text);\n}\n";

  StyleRegistry.register(stylesheet$d);

  /**
   * The single quote (if any) attached to the next prompt, shown as a removable chip - claude.ai's
   * "Reply" flow: select text, quote it, send it as a small attachment alongside the prompt.
   */
  class PendingQuoteView {
    /**
     * Characters of the quoted text shown in the chip before truncating.
     * @type {number}
     */
    static #PREVIEW_LENGTH = 40;

    /**
     * Element showing the chip; hidden while there's no pending quote.
     * @type {HTMLElement}
     */
    #container;

    /**
     * The pending quote, or null.
     * @type {?{text: string, sender: string}}
     */
    #quote = null;

    /**
     * Creates the view and handles clicks on the chip's remove button.
     * @param {HTMLElement} container Element showing the chip.
     */
    constructor(container) {
      this.#container = container;
      container.addEventListener('click', event => this.#onRemoveClick(event));
    }

    /**
     * Whether a quote is pending.
     * @returns {boolean} True while one is attached.
     */
    get hasQuote() {
      return Boolean(this.#quote);
    }

    /**
     * Attaches a quote, replacing one already pending.
     * @param {string} text Quoted text.
     * @param {string} sender Sender of the message it was quoted from.
     * @returns {void}
     */
    set(text, sender) {
      this.#quote = { text, sender };
      this.#render();
    }

    /**
     * Returns the pending quote and clears it.
     * @returns {?{text: string, sender: string}} The quote, or null when there wasn't one.
     */
    take() {
      const quote = this.#quote;
      this.clear();
      return quote;
    }

    /**
     * Discards the pending quote, if any.
     * @returns {void}
     */
    clear() {
      if (!this.#quote) return;
      this.#quote = null;
      this.#render();
    }

    /**
     * Clears the pending quote when its remove button is clicked.
     * @param {MouseEvent} event Click inside the container.
     * @returns {void}
     */
    #onRemoveClick(event) {
      if (event.target.closest('[data-action="removeQuote"]')) this.clear();
    }

    /**
     * Shows or hides the chip for the current quote.
     * @returns {void}
     */
    #render() {
      this.#container.hidden = !this.#quote;
      this.#container.innerHTML = this.#quote ? PendingQuoteView.#chipHtml(this.#quote) : '';
    }

    /**
     * HTML of the chip: an icon, a line count, a truncated preview and a remove button.
     * @param {{text: string, sender: string}} quote The pending quote.
     * @returns {string} The chip.
     */
    static #chipHtml(quote) {
      const lineCount = quote.text.split('\n').length;
      const preview = quote.text.length > PendingQuoteView.#PREVIEW_LENGTH ? `${quote.text.slice(0, PendingQuoteView.#PREVIEW_LENGTH)}…` : quote.text;
      return `
      <span class="claude-plus-pending-quote">
        <span class="claude-plus-pending-quote__label">💬 Quote, ${lineCount} line${lineCount === 1 ? '' : 's'}</span>
        <span class="claude-plus-pending-quote__preview">${escapeHtml(preview)}</span>
        <button class="claude-plus-pending-quote__remove" data-action="removeQuote" title="Remove quote">×</button>
      </span>`;
    }
  }

  var stylesheet$c = ".claude-plus-staged-files {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  gap: 6px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-staged-file {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  gap: 4px;\r\n  background: var(--claude-plus-color-bar);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  padding: 3px 4px 3px 3px;\r\n  font-size: 12px;\r\n  max-width: 200px;\r\n}\r\n\r\n.claude-plus-staged-file--uploading {\r\n  opacity: 0.6;\r\n}\r\n\r\n.claude-plus-staged-file__thumb {\r\n  width: 20px;\r\n  height: 20px;\r\n  border-radius: 4px;\r\n  object-fit: cover;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-staged-file__icon {\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-staged-file__name {\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.claude-plus-staged-file__remove {\r\n  background: none;\r\n  border: none;\r\n  color: var(--claude-plus-color-text-faint);\r\n  cursor: pointer;\r\n  padding: 0 2px;\r\n  border-radius: 4px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-staged-file__remove:hover {\r\n  background: var(--claude-plus-color-hover);\r\n  color: var(--claude-plus-color-text);\r\n}\r\n";

  StyleRegistry.register(stylesheet$c);

  /**
   * The files attached to the next prompt, shown as removable chips. Each file is uploaded as soon
   * as it is attached; a failed upload is dropped and reported rather than kept as a chip.
   */
  class StagedFileList {
    /**
     * Element showing the chips; hidden while the list is empty.
     * @type {HTMLElement}
     */
    #container;

    /**
     * Uploads a file to the conversation of the next prompt.
     * @type {function(File): Promise<UploadedFile>}
     */
    #uploadFile;

    /**
     * Staged files, in attachment order.
     * @type {StagedFile[]}
     */
    #stagedFiles = [];

    /**
     * Creates the list and handles clicks on the chips' remove buttons.
     * @param {HTMLElement} container Element showing the chips.
     * @param {function(File): Promise<UploadedFile>} uploadFile Uploads a file to the conversation of the next prompt.
     */
    constructor(container, uploadFile) {
      this.#container = container;
      this.#uploadFile = uploadFile;
      container.addEventListener('click', event => this.#onRemoveClick(event));
    }

    /**
     * Whether any upload is still in flight.
     * @returns {boolean} True while uploading.
     */
    get isUploading() {
      return this.#stagedFiles.some(stagedFile => stagedFile.isUploading);
    }

    /**
     * Uploads a file and shows it as a chip, updated once the upload settles.
     * @param {File} file File to attach.
     * @returns {Promise<void>} Resolves once uploaded, or once a failure has been reported.
     */
    async attach(file) {
      const key = crypto.randomUUID();
      this.#setStagedFiles([...this.#stagedFiles, { key, name: file.name, isUploading: true, upload: null }]);
      try {
        const upload = await this.#uploadFile(file);
        this.#update(key, { isUploading: false, upload });
      } catch (error) {
        this.#remove(key);
        await AlertDialog.inform(`Uploading "${file.name}" failed: ${error.message}`);
      }
    }

    /**
     * Returns the finished uploads and empties the list.
     * @returns {UploadedFile[]} The uploads, in attachment order.
     */
    takeUploads() {
      const uploads = this.#stagedFiles.map(stagedFile => stagedFile.upload);
      this.#setStagedFiles([]);
      return uploads;
    }

    /**
     * Discards every staged file, without cancelling uploads in flight; a late upload result is
     * ignored once its entry is gone.
     * @returns {void}
     */
    clear() {
      if (this.#stagedFiles.length) this.#setStagedFiles([]);
    }

    /**
     * Merges changes into a staged file, unless it was removed while its upload was in flight.
     * @param {string} key Entry key.
     * @param {Partial<StagedFile>} changes Fields to merge in.
     * @returns {void}
     */
    #update(key, changes) {
      if (!this.#stagedFiles.some(stagedFile => stagedFile.key === key)) return;
      this.#setStagedFiles(this.#stagedFiles.map(stagedFile => (stagedFile.key === key ? { ...stagedFile, ...changes } : stagedFile)));
    }

    /**
     * Removes a staged file.
     * @param {string} key Entry key.
     * @returns {void}
     */
    #remove(key) {
      this.#setStagedFiles(this.#stagedFiles.filter(stagedFile => stagedFile.key !== key));
    }

    /**
     * Removes the staged file whose remove button was clicked.
     * @param {MouseEvent} event Click inside the chip row.
     * @returns {void}
     */
    #onRemoveClick(event) {
      const button = event.target.closest('[data-key]');
      if (button) this.#remove(button.dataset.key);
    }

    /**
     * Replaces the staged files and redraws the chips, hiding the row when there are none.
     * @param {StagedFile[]} stagedFiles New list.
     * @returns {void}
     */
    #setStagedFiles(stagedFiles) {
      this.#stagedFiles = stagedFiles;
      this.#container.hidden = stagedFiles.length === 0;
      this.#container.innerHTML = stagedFiles.map(stagedFile => StagedFileList.#chipHtml(stagedFile)).join('');
    }

    /**
     * HTML of one chip: a thumbnail for an uploaded image, else a generic file icon.
     * @param {StagedFile} stagedFile The staged file.
     * @returns {string} The chip.
     */
    static #chipHtml(stagedFile) {
      const thumbnailHtml = stagedFile.upload?.thumbnail_url
        ? `<img class="claude-plus-staged-file__thumb" src="${escapeHtml(stagedFile.upload.thumbnail_url)}" alt="" />`
        : '<span class="claude-plus-staged-file__icon">📎</span>';
      const stateClass = stagedFile.isUploading ? ' claude-plus-staged-file--uploading' : '';
      return `
      <span class="claude-plus-staged-file${stateClass}">
        ${thumbnailHtml}
        <span class="claude-plus-staged-file__name">${escapeHtml(stagedFile.name)}</span>
        <button class="claude-plus-staged-file__remove" data-key="${escapeHtml(stagedFile.key)}" title="Remove">×</button>
      </span>`;
    }
  }

  var stylesheet$b = ".claude-plus-composer__options {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  gap: 8px;\r\n  align-items: center;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-composer__options select {\r\n  padding: 4px 6px;\r\n}\r\n\r\n.claude-plus-composer__thinking-toggle {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 4px;\r\n  font-size: 12px;\r\n  color: var(--claude-plus-color-text-muted);\r\n  cursor: pointer;\r\n}\r\n\r\n.claude-plus-panel .claude-plus-composer__input {\r\n  flex: 1;\r\n  resize: none;\r\n  min-height: 40px;\r\n  border-radius: 8px;\r\n  padding: 8px;\r\n  font-size: 14px;\r\n}\r\n\r\n.claude-plus-primary-button.claude-plus-composer__stop-button {\r\n  flex-shrink: 0;\r\n  background: var(--claude-plus-color-button-hover);\r\n}\r\n\r\n.claude-plus-composer__readonly-notice {\r\n  padding: 8px;\r\n  font-size: 13px;\r\n  color: var(--claude-plus-color-text-muted);\r\n  font-style: italic;\r\n}\r\n";

  StyleRegistry.register(stylesheet$b);

  /**
   * The single message composer. It always targets the active chat (the focused chat pane) and can
   * be docked anywhere. Enter sends and Shift+Enter inserts a line break; there is no send button,
   * only a Stop button while a reply streams. Files pasted or dropped in are uploaded and attached
   * to the next prompt; selecting text in a message and clicking its Reply button attaches a quote
   * of it instead. Its toolbar holds the model options, buttons opening the active chat's files and
   * sources sub-panes, and the chat export.
   */
  class ComposerPanel extends Panel {
    /**
     * Chat panes; the focused one is the active chat.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Shared model options.
     * @type {ComposerSettings}
     */
    #settings;

    /**
     * Conversation statistics, to hide the files/sources buttons when the active chat has none.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Exports the active chat.
     * @type {ConversationExporter}
     */
    #exporter;

    /**
     * The selectable models and effort levels.
     * @type {ModelCatalog}
     */
    #modelCatalog;

    /**
     * The model option controls; created once the body is built.
     * @type {?ComposerOptionsView}
     */
    #optionsView = null;

    /**
     * The export button; created once the body is built.
     * @type {?ExportMenuButton}
     */
    #exportButton = null;

    /**
     * Files attached to the next prompt; created once the body is built.
     * @type {?StagedFileList}
     */
    #stagedFiles = null;

    /**
     * The quote (if any) attached to the next prompt; created once the body is built.
     * @type {?PendingQuoteView}
     */
    #pendingQuote = null;

    /**
     * Undoes the subscriptions to the active chat's session.
     * @type {Array<function(): void>}
     */
    #sessionUnsubscribers = [];

    /**
     * Creates the panel.
     * @param {object} services Panel dependencies.
     * @param {ChatPaneManager} services.paneManager Chat panes; the focused one is the active chat.
     * @param {ComposerSettings} services.settings Shared model options.
     * @param {StatsIndex} services.stats Conversation statistics, to hide the files/sources buttons when empty.
     * @param {ConversationExporter} services.exporter Exports the active chat.
     * @param {ModelCatalog} services.modelCatalog The selectable models and effort levels.
     */
    constructor({ paneManager, settings, stats, exporter, modelCatalog }) {
      super('Message');
      this.#paneManager = paneManager;
      this.#settings = settings;
      this.#stats = stats;
      this.#exporter = exporter;
      this.#modelCatalog = modelCatalog;
    }

    /**
     * HTML of the panel body.
     * @returns {string} Toolbar, prompt input and Stop button.
     */
    createBodyHtml() {
      return `
      <div class="claude-plus-composer__options" data-name="optionsRow">
        <select data-name="modelSelect">${optionsHtml(this.#modelCatalog.models, '')}</select>
        <select data-name="effortSelect">${optionsHtml(this.#modelCatalog.efforts, '')}</select>
        <label class="claude-plus-composer__thinking-toggle"><input type="checkbox" data-name="thinkingCheckbox" /> Extended thinking</label>
        <div class="claude-plus-fill-remaining"></div>
        <button class="claude-plus-toolbar__button" data-name="filesButton" title="Files in the active chat">📁</button>
        <button class="claude-plus-toolbar__button" data-name="sourcesButton" title="Web sources of the active chat">🌐</button>
        <button class="claude-plus-toolbar__button" data-name="statsButton" title="Stats for the active chat">📈</button>
        <button class="claude-plus-toolbar__button" data-name="exportButton" title="Export the active chat">Export ▾</button>
      </div>
      <div class="claude-plus-staged-files" data-name="stagedFiles" hidden></div>
      <div data-name="pendingQuote" hidden></div>
      <div class="claude-plus-composer__readonly-notice" data-name="readonlyNotice" hidden>This is an imported chat — read-only, there's no model to reply to.</div>
      <textarea class="claude-plus-composer__input" data-name="promptInput" placeholder="Message Claude… (Enter sends, Shift+Enter adds a line — paste or drop files to attach them)" rows="3"></textarea>
      <button class="claude-plus-primary-button claude-plus-composer__stop-button" data-name="stopButton" hidden>Stop</button>`;
    }

    /**
     * Creates the controls' views, wires the prompt input and follows the settings and the active chat.
     * @returns {void}
     */
    bindEvents() {
      const { promptInput, stopButton, filesButton, sourcesButton, statsButton, exportButton, stagedFiles, pendingQuote } = this.elements;
      this.#optionsView = new ComposerOptionsView(this.elements, this.#settings);
      this.#exportButton = new ExportMenuButton(exportButton, this.#exporter);
      this.#stagedFiles = new StagedFileList(stagedFiles, file => this.#paneManager.focusedSession.uploadFile(file));
      this.#pendingQuote = new PendingQuoteView(pendingQuote);
      promptInput.addEventListener('keydown', event => this.#onPromptKeydown(event));
      promptInput.addEventListener('paste', event => this.#onPaste(event));
      this.element.addEventListener('dragover', event => event.preventDefault());
      this.element.addEventListener('drop', event => this.#onDrop(event));
      stopButton.addEventListener('click', () => this.#paneManager.focusedSession.stopReply());
      filesButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('files'));
      sourcesButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('sources'));
      statsButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('stats'));
      this.listenTo(this.#settings, 'settings', () => this.#optionsView.showSettings());
      this.listenTo(this.#modelCatalog, 'catalog', () => this.#optionsView.refreshChoices(this.#modelCatalog));
      this.listenTo(this.#paneManager, 'focus', () => this.#followActiveChat());
      this.listenTo(this.#paneManager, 'paneConversations', () => this.render());
      this.listenTo(this.#paneManager, 'conversationLoaded', () => this.render());
      this.listenTo(this.#stats, 'aggregate', () => this.render());
      this.#followActiveChat();
    }

    /**
     * Shows Stop only while the active chat streams a reply, enables export only for a saved
     * conversation, shows the files/sources buttons only when the active chat has any, and replaces
     * just the send box (not the whole toolbar) with a read-only notice for an imported chat, whose
     * model/effort/thinking choosers are disabled rather than hidden since there's nothing to send.
     * @returns {void}
     */
    render() {
      const session = this.#paneManager.focusedSession;
      const { promptInput, stopButton, readonlyNotice, filesButton, sourcesButton } = this.elements;
      promptInput.hidden = session.isReadOnly;
      readonlyNotice.hidden = !session.isReadOnly;
      stopButton.hidden = session.isReadOnly || !session.isSending;
      this.#optionsView.setDisabled(session.isReadOnly);
      this.#exportButton.setEnabled(Boolean(session.openConversationId));
      filesButton.hidden = !this.#activeChatHas('folders');
      sourcesButton.hidden = !this.#activeChatHas('sources');
    }

    /**
     * Whether the active chat has any entries in an aggregate list.
     * @param {'folders'|'sources'} listName The aggregate list to check.
     * @returns {boolean} True while a conversation is open and it has a matching entry.
     */
    #activeChatHas(listName) {
      const conversationId = this.#paneManager.focusedSession.openConversationId;
      return Boolean(conversationId) && this.#stats.aggregate[listName].some(entry => entry.conversationId === conversationId);
    }

    /**
     * Ends the subscriptions, including those to the active chat, and closes the export menu.
     * @returns {void}
     */
    dispose() {
      this.#unsubscribeFromSession();
      this.#exportButton?.close();
      super.dispose();
    }

    /**
     * Subscribes to the newly active chat's sending state and quote requests, and drops the files and
     * quote staged for the previous one.
     * @returns {void}
     */
    #followActiveChat() {
      this.#unsubscribeFromSession();
      const session = this.#paneManager.focusedSession;
      this.#sessionUnsubscribers = [
        session.subscribe('sending', () => this.render()),
        session.subscribe('quoteRequested', ({ text, sender }) => this.#pendingQuote.set(text, sender)),
      ];
      this.#stagedFiles.clear();
      this.#pendingQuote.clear();
      this.render();
    }

    /**
     * Ends the subscriptions to the previously active chat.
     * @returns {void}
     */
    #unsubscribeFromSession() {
      this.#sessionUnsubscribers.forEach(unsubscribe => unsubscribe());
      this.#sessionUnsubscribers = [];
    }

    /**
     * Sends on Enter; Shift+Enter inserts a line break and IME composition is left alone.
     * @param {KeyboardEvent} event Key press in the text area.
     * @returns {void}
     */
    #onPromptKeydown(event) {
      if (!ComposerPanel.#isSendShortcut(event)) return;
      event.preventDefault();
      this.#sendTypedPrompt();
    }

    /**
     * Whether a key press sends the prompt.
     * @param {KeyboardEvent} event The key press.
     * @returns {boolean} True for Enter without Shift outside IME composition.
     */
    static #isSendShortcut(event) {
      return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
    }

    /**
     * Sends the typed prompt, the staged files and any pending quote to the active chat, then clears
     * all three; ignored for blank input, while the active chat is sending, or while a file is still
     * uploading.
     * @returns {void}
     */
    #sendTypedPrompt() {
      const { promptInput } = this.elements;
      const session = this.#paneManager.focusedSession;
      if (!promptInput.value.trim() || session.isSending || this.#stagedFiles.isUploading) return;
      const prompt = promptInput.value;
      promptInput.value = '';
      session.sendPrompt(prompt, this.#stagedFiles.takeUploads(), this.#pendingQuote.take());
    }

    /**
     * Attaches the files of a paste that carries any, leaving pasted text to paste normally. A paste
     * without files is left alone.
     * @param {ClipboardEvent} event The paste.
     * @returns {void}
     */
    #onPaste(event) {
      const files = [...(event.clipboardData?.items ?? [])]
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter(Boolean);
      if (!files.length) return;
      event.preventDefault();
      files.forEach(file => this.#stagedFiles.attach(file));
    }

    /**
     * Attaches every file dropped onto the composer.
     * @param {DragEvent} event The drop.
     * @returns {void}
     */
    #onDrop(event) {
      event.preventDefault();
      [...(event.dataTransfer?.files ?? [])].forEach(file => this.#stagedFiles.attach(file));
    }
  }

  /**
   * The conversation list shown everywhere in the app: live conversations from the vendor directory,
   * plus imported ones merged in, tagged isImported so the UI can tell them apart. Presents the same
   * shape a live-only directory already does, so every existing consumer (the Chats list, search,
   * pane manager) needs no changes beyond receiving this instead of the vendor directory directly.
   * @fires CombinedConversationDirectory#conversations The list changed.
   * @fires CombinedConversationDirectory#conversationDeleted A conversation was deleted; payload is its id.
   */
  class CombinedConversationDirectory extends EventEmitter {
    /**
     * Live conversations.
     * @type {ConversationDirectory}
     */
    #liveDirectory;

    /**
     * Imported conversations.
     * @type {ImportedConversationStore}
     */
    #importedConversations;

    /**
     * Imported listings, refreshed independently of the live directory.
     * @type {ConversationListing[]}
     */
    #importedListings = [];

    /**
     * Wraps a live directory and an imported store into one combined list.
     * @param {ConversationDirectory} liveDirectory Live conversations.
     * @param {ImportedConversationStore} importedConversations Imported conversations.
     */
    constructor(liveDirectory, importedConversations) {
      super();
      this.#liveDirectory = liveDirectory;
      this.#importedConversations = importedConversations;
      liveDirectory.subscribe('conversations', () => this.publish('conversations'));
      liveDirectory.subscribe('conversationDeleted', conversationId => this.publish('conversationDeleted', conversationId));
    }

    /**
     * The combined listings.
     * @returns {ConversationListing[]} Live conversations, then imported ones.
     */
    get conversations() {
      return [...this.#liveDirectory.conversations, ...this.#importedListings];
    }

    /**
     * Reloads the live list.
     * @returns {Promise<void>} Resolves once reloaded or failed.
     */
    refresh() {
      return this.#liveDirectory.refresh();
    }

    /**
     * Reloads the imported listings from local storage.
     * @returns {Promise<void>} Resolves once reloaded.
     */
    async refreshImported() {
      this.#importedListings = await this.#importedConversations.listings();
      this.publish('conversations');
    }

    /**
     * Display title of a listed conversation, live or imported.
     * @param {string} conversationId Conversation id.
     * @returns {string} Its title, or UNTITLED when it has none or isn't listed.
     */
    titleOf(conversationId) {
      const imported = this.#importedListings.find(listing => listing.uuid === conversationId);
      return imported ? imported.name : this.#liveDirectory.titleOf(conversationId);
    }

    /**
     * Adds a just-created live conversation to the top of the list.
     * @param {string} conversationId Conversation id.
     * @param {string} prompt First prompt, used as a provisional title.
     * @returns {void}
     */
    registerNewConversation(conversationId, prompt) {
      this.#liveDirectory.registerNewConversation(conversationId, prompt);
    }

    /**
     * Updates a live listing's title and time from the server.
     * @param {ApiConversation} conversation The fetched conversation.
     * @returns {void}
     */
    updateListing(conversation) {
      this.#liveDirectory.updateListing(conversation);
    }

    /**
     * Deletes a conversation: permanently through the live API for a live one, or from the local
     * store alone for an imported one.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once deleted.
     * @throws {ApiError} When a live delete is refused; nothing changes locally.
     */
    async deleteConversation(conversationId) {
      if (this.#importedListings.some(listing => listing.uuid === conversationId)) {
        await this.#deleteImported(conversationId);
      } else {
        await this.#liveDirectory.deleteConversation(conversationId);
      }
    }

    /**
     * Removes an imported conversation from the local store and its listing, then announces it the
     * same way a live delete does.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once removed.
     */
    async #deleteImported(conversationId) {
      await this.#importedConversations.remove(conversationId);
      this.#importedListings = this.#importedListings.filter(listing => listing.uuid !== conversationId);
      this.publish('conversations');
      this.publish('conversationDeleted', conversationId);
    }
  }

  /**
   * Composer options persisted in localStorage, shared by all chat panes. Values outside the allowed
   * list read as the default.
   * @fires ComposerSettings#settings An option changed.
   */
  class ComposerSettings extends EventEmitter {
    /**
     * Backing storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * The selectable models and effort levels.
     * @type {ModelCatalog}
     */
    #modelCatalog;

    /**
     * Creates the settings on top of a preference store.
     * @param {Preferences} preferences Backing storage.
     * @param {ModelCatalog} modelCatalog The selectable models and effort levels.
     */
    constructor(preferences, modelCatalog) {
      super();
      this.#preferences = preferences;
      this.#modelCatalog = modelCatalog;
    }

    /**
     * Selected model id.
     * @returns {string} An id from the model catalog.
     */
    get model() {
      return this.#readAllowed(STORAGE_KEYS.model, this.#modelCatalog.models.map(option => option.id));
    }

    /**
     * Selects a model; ids not in the model catalog are ignored.
     * @param {string} modelId Model id.
     */
    set model(modelId) {
      this.#writeIfAllowed(STORAGE_KEYS.model, modelId, this.#modelCatalog.models.map(option => option.id));
    }

    /**
     * Selected effort level.
     * @returns {string} An id from the model catalog.
     */
    get effort() {
      return this.#readAllowed(STORAGE_KEYS.effort, this.#modelCatalog.efforts.map(option => option.id));
    }

    /**
     * Selects an effort level; ids not in the model catalog are ignored.
     * @param {string} effortId Effort id.
     */
    set effort(effortId) {
      this.#writeIfAllowed(STORAGE_KEYS.effort, effortId, this.#modelCatalog.efforts.map(option => option.id));
    }

    /**
     * Selected thinking mode.
     * @returns {string} A value of THINKING_MODES.
     */
    get thinkingMode() {
      return this.#readAllowed(STORAGE_KEYS.thinkingMode, Object.values(THINKING_MODES));
    }

    /**
     * Selects a thinking mode; values not in THINKING_MODES are ignored.
     * @param {string} thinkingMode Thinking mode.
     */
    set thinkingMode(thinkingMode) {
      this.#writeIfAllowed(STORAGE_KEYS.thinkingMode, thinkingMode, Object.values(THINKING_MODES));
    }

    /**
     * Current values for a completion request.
     * @returns {ComposerSnapshot} The options.
     */
    snapshot() {
      return { model: this.model, effort: this.effort, thinkingMode: this.thinkingMode };
    }

    /**
     * Reads a stored option.
     * @param {string} key Storage key.
     * @param {string[]} allowedValues Allowed values; the first is the default.
     * @returns {string} The stored value if allowed, otherwise the default.
     */
    #readAllowed(key, allowedValues) {
      const storedValue = this.#preferences.read(key);
      return allowedValues.includes(storedValue) ? storedValue : allowedValues[0];
    }

    /**
     * Stores an option if it is allowed and announces the change.
     * @param {string} key Storage key.
     * @param {string} value Value to store.
     * @param {string[]} allowedValues Allowed values.
     * @returns {void}
     */
    #writeIfAllowed(key, value, allowedValues) {
      if (!allowedValues.includes(value)) return;
      this.#preferences.write(key, value);
      this.publish('settings');
    }
  }

  /**
   * The shared list of the user's conversations, as shown in the sidebar.
   * @fires ConversationDirectory#conversations The list changed.
   * @fires ConversationDirectory#conversationDeleted A conversation was deleted; payload is its id.
   */
  class ConversationDirectory extends EventEmitter {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Conversations, newest first.
     * @type {ConversationListing[]}
     */
    #conversations = [];

    /**
     * Creates the directory.
     * @param {ClaudeApi} api API client.
     */
    constructor(api) {
      super();
      this.#api = api;
    }

    /**
     * The listed conversations.
     * @returns {ConversationListing[]} Conversations, newest first.
     */
    get conversations() {
      return this.#conversations;
    }

    /**
     * Reloads the list. Failures are logged and leave the current list in place.
     * @returns {Promise<void>} Resolves once reloaded or failed.
     */
    async refresh() {
      try {
        this.#conversations = await this.#api.listConversations(0, LIMITS.sidebarPageSize);
      } catch (error) {
        console.warn(LOG_PREFIX, 'loading conversations failed', error);
      }
      this.publish('conversations');
    }

    /**
     * Display title of a listed conversation.
     * @param {string} conversationId Conversation id.
     * @returns {string} Its title, or UNTITLED when it has none or isn't listed.
     */
    titleOf(conversationId) {
      const conversation = this.#conversations.find(listing => listing.uuid === conversationId);
      return (conversation && conversation.name) || UNTITLED;
    }

    /**
     * Adds a just-created conversation to the top of the list.
     * @param {string} conversationId Conversation id.
     * @param {string} prompt First prompt, used as a provisional title.
     * @returns {void}
     */
    registerNewConversation(conversationId, prompt) {
      const listing = { uuid: conversationId, name: prompt.slice(0, LIMITS.provisionalTitleLength), updated_at: new Date().toISOString() };
      this.#conversations = [listing, ...this.#conversations];
      this.publish('conversations');
    }

    /**
     * Updates a listed conversation's title and time from the server and moves it to the top.
     * @param {ApiConversation} conversation The fetched conversation.
     * @returns {void}
     */
    updateListing(conversation) {
      const existing = this.#conversations.find(listing => listing.uuid === conversation.uuid);
      if (!existing) return;
      const updated = { ...existing, name: conversation.name || existing.name, updated_at: conversation.updated_at || existing.updated_at };
      this.#conversations = [updated, ...this.#conversations.filter(listing => listing !== existing)];
      this.publish('conversations');
    }

    /**
     * Permanently deletes a conversation.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once deleted.
     * @throws {ApiError} When the server refuses; nothing changes locally.
     */
    async deleteConversation(conversationId) {
      await this.#api.deleteConversation(conversationId);
      this.#conversations = this.#conversations.filter(conversation => conversation.uuid !== conversationId);
      this.publish('conversations');
      this.publish('conversationDeleted', conversationId);
    }
  }

  /**
   * Field access for a ConversationListing, so callers never read its raw API field names directly.
   */
  class ConversationListingFields {
    /**
     * A listing's id.
     * @param {ConversationListing} listing The listing.
     * @returns {string} Its conversation id.
     */
    static id(listing) {
      return listing.uuid;
    }

    /**
     * A listing's title.
     * @param {ConversationListing} listing The listing.
     * @returns {string} Its title; may be empty.
     */
    static title(listing) {
      return listing.name;
    }

    /**
     * When a listing last changed.
     * @param {ConversationListing} listing The listing.
     * @returns {string} ISO timestamp of the last change.
     */
    static updatedAt(listing) {
      return listing.updated_at;
    }

    /**
     * Whether a listing came from an imported data export rather than the live API.
     * @param {ConversationListing} listing The listing.
     * @returns {boolean} True for an imported conversation.
     */
    static isImported(listing) {
      return Boolean(listing.isImported);
    }
  }

  /**
   * Workspace geometry. Pixel values are CSS pixels; fractions are of the containing area.
   * toolbarHeight / tabStripHeight: fixed bar heights. minimumSplitFraction: smallest share a split
   * child can be resized to. edgeDockFraction: share of a panel docked at an outer edge.
   * edgeDropMargin: distance from the workspace edge that counts as an edge drop. sideDropFraction:
   * share of a zone near each side that counts as a side drop. dragThreshold: movement before a
   * press becomes a drag. dividerThickness: grab width of a divider. dragLabelOffset: distance of
   * the drag label from the pointer. edgeHighlightMaxWidth / edgeHighlightMaxHeight: size cap of
   * the edge drop highlight.
   * @type {Readonly<Record<string, number>>}
   */
  const LAYOUT = Object.freeze({
    toolbarHeight: 36,
    tabStripHeight: 26,
    minimumSplitFraction: 0.08,
    edgeDockFraction: 0.25,
    edgeDropMargin: 32,
    sideDropFraction: 0.25,
    dragThreshold: 4,
    dividerThickness: 6,
    dragLabelOffset: 12,
    edgeHighlightMaxWidth: 280,
    edgeHighlightMaxHeight: 220,
  });

  /**
   * The dock layout as pure data: splits with fractional sizes whose leaves hold tabbed panels.
   */
  class DockTree {
    /**
     * Creates a tree around a root node.
     * @param {DockNode} root The root.
     */
    constructor(root) {
      this.root = root;
    }

    /**
     * The default layout: the conversation list on the left, the chat panes tabbed in the middle
     * above the composer, stats, web sources, files and search tabbed on the right.
     * @param {string[]} chatPaneIds Panel ids of the chat panes, at least one.
     * @returns {DockTree} A new tree.
     */
    static createDefault(chatPaneIds) {
      return new DockTree({
        type: 'split', direction: 'row', sizes: [0.18, 0.62, 0.2],
        children: [
          DockTree.#createLeaf(['conversations'], 'leaf-conversations'),
          {
            type: 'split', direction: 'column', sizes: [0.8, 0.2],
            children: [DockTree.#createLeaf(chatPaneIds, 'leaf-chat'), DockTree.#createLeaf(['composer'], 'leaf-composer')],
          },
          DockTree.#createLeaf(['stats', 'webSources', 'files', 'search'], 'leaf-extras'),
        ],
      });
    }

    /**
     * Every panel id a stored layout mentions, without validating it.
     * @param {*} storedNode Parsed stored layout or node.
     * @returns {Set<string>} The ids; empty for anything that isn't a layout.
     */
    static collectPanelIds(storedNode) {
      const panelIds = new Set();
      DockTree.#collectPanelIdsInto(storedNode, panelIds);
      return panelIds;
    }

    /**
     * Adds the panel ids of a stored node and its descendants to a set.
     * @param {*} storedNode Stored node.
     * @param {Set<string>} panelIds Collected ids; modified in place.
     * @returns {void}
     */
    static #collectPanelIdsInto(storedNode, panelIds) {
      if (!storedNode || typeof storedNode !== 'object') return;
      (Array.isArray(storedNode.tabs) ? storedNode.tabs : []).filter(tab => typeof tab === 'string').forEach(tab => panelIds.add(tab));
      (Array.isArray(storedNode.children) ? storedNode.children : []).forEach(child => DockTree.#collectPanelIdsInto(child, panelIds));
    }

    /**
     * Rebuilds a stored layout, dropping anything malformed, unknown or duplicated.
     * @param {*} storedLayout Parsed stored layout.
     * @param {Iterable<string>} knownPanelIds Ids of the existing panels.
     * @returns {?DockTree} The restored tree, or null when nothing valid remains.
     */
    static fromStored(storedLayout, knownPanelIds) {
      const root = DockTree.#sanitizeNode(storedLayout, new Set(knownPanelIds), new Set());
      return root ? new DockTree(root) : null;
    }

    /**
     * Serializable form.
     * @returns {DockNode} The root node.
     */
    toJSON() {
      return this.root;
    }

    /**
     * Finds a zone by id.
     * @param {string} leafId Zone id.
     * @returns {?LeafNode} The zone, or null.
     */
    findLeaf(leafId) {
      return this.#findNode(node => node.type === 'leaf' && node.id === leafId);
    }

    /**
     * Finds the zone containing a panel.
     * @param {string} panelId Panel id.
     * @returns {?LeafNode} The zone, or null when the panel isn't docked.
     */
    findLeafContaining(panelId) {
      return this.#findNode(node => node.type === 'leaf' && node.tabs.includes(panelId));
    }

    /**
     * The first zone in tree order.
     * @returns {LeafNode} The zone.
     */
    firstLeaf() {
      return this.#findNode(node => node.type === 'leaf');
    }

    /**
     * Makes a panel the visible tab of its zone; ignored if the zone doesn't hold it.
     * @param {string} leafId Zone id.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    activateTab(leafId, panelId) {
      const leaf = this.findLeaf(leafId);
      if (leaf && leaf.tabs.includes(panelId)) leaf.activeTab = panelId;
    }

    /**
     * Removes a panel from its zone; an emptied zone is removed unless it is the root.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    removePanel(panelId) {
      const leaf = this.findLeafContaining(panelId);
      if (!leaf) return;
      DockTree.#removeTab(leaf, panelId);
      if (leaf.tabs.length === 0 && leaf !== this.root) this.#removeNode(leaf);
    }

    /**
     * Moves a panel into a zone: 'center' adds it as a tab, a side splits the zone and puts the panel
     * on that side. Dropping a panel onto its own zone only activates it. A missing target falls
     * back to adding a tab to the first zone.
     * @param {string} panelId Panel id.
     * @param {string} targetLeafId Target zone id.
     * @param {string} region 'center', 'left', 'right', 'top' or 'bottom'.
     * @returns {void}
     */
    dockPanel(panelId, targetLeafId, region) {
      if (this.#isDropOntoOwnZone(panelId, targetLeafId, region)) {
        this.activateTab(targetLeafId, panelId);
        return;
      }
      this.removePanel(panelId);
      const targetLeaf = this.findLeaf(targetLeafId);
      if (targetLeaf && region !== 'center') this.#splitLeaf(targetLeaf, panelId, region);
      else DockTree.#addTab(targetLeaf || this.firstLeaf(), panelId);
    }

    /**
     * Docks a panel along an outer edge of the whole workspace. Ignored when the panel is the only one.
     * @param {string} panelId Panel id.
     * @param {string} edge 'left', 'right', 'top' or 'bottom'.
     * @returns {void}
     */
    dockPanelAtEdge(panelId, edge) {
      if (this.#isOnlyPanel(panelId)) return;
      this.removePanel(panelId);
      const edgeShare = LAYOUT.edgeDockFraction;
      this.root = {
        type: 'split',
        direction: DockTree.#directionForSide(edge),
        sizes: DockTree.#isLeadingSide(edge) ? [edgeShare, 1 - edgeShare] : [1 - edgeShare, edgeShare],
        children: DockTree.#orderForSide(edge, this.root, DockTree.#createLeafWithNewId([panelId])),
      };
    }

    /**
     * Moves the boundary after a split child, keeping both neighbours at least LAYOUT.minimumSplitFraction.
     * @param {SplitNode} split The split.
     * @param {number} index Index of the child before the boundary.
     * @param {number[]} startSizes Sizes when the drag started.
     * @param {number} movedFraction Movement as a fraction of the split's extent.
     * @returns {void}
     */
    resizeSplit(split, index, startSizes, movedFraction) {
      const pairSize = startSizes[index] + startSizes[index + 1];
      const firstSize = clamp(startSizes[index] + movedFraction, LAYOUT.minimumSplitFraction, pairSize - LAYOUT.minimumSplitFraction);
      split.sizes[index] = firstSize;
      split.sizes[index + 1] = pairSize - firstSize;
    }

    /**
     * Computes every zone's area and every divider's position.
     * @param {Rect} bounds Area of the whole workspace.
     * @returns {DockLayout} The placements.
     */
    computeLayout(bounds) {
      const layout = { leaves: [], dividers: [] };
      DockTree.#placeNode(this.root, bounds, layout);
      return layout;
    }

    /**
     * Places a node and its descendants.
     * @param {DockNode} node The node.
     * @param {Rect} rect Its area.
     * @param {DockLayout} layout Collected placements; modified in place.
     * @returns {void}
     */
    static #placeNode(node, rect, layout) {
      if (node.type === 'leaf') layout.leaves.push({ leaf: node, rect });
      else DockTree.#placeSplitChildren(node, rect, layout);
    }

    /**
     * Places a split's children one after another along its axis, with a divider between neighbours.
     * @param {SplitNode} split The split.
     * @param {Rect} rect Its area.
     * @param {DockLayout} layout Collected placements; modified in place.
     * @returns {void}
     */
    static #placeSplitChildren(split, rect, layout) {
      const isSideBySide = split.direction === 'row';
      const extent = isSideBySide ? rect.width : rect.height;
      let offset = isSideBySide ? rect.left : rect.top;
      split.children.forEach((child, index) => {
        const childExtent = extent * split.sizes[index];
        DockTree.#placeNode(child, DockTree.#sliceAlongAxis(rect, isSideBySide, offset, childExtent), layout);
        offset += childExtent;
        if (index < split.children.length - 1) layout.dividers.push({ split, index, rect, position: offset });
      });
    }

    /**
     * A slice of a rectangle along one axis.
     * @param {Rect} rect The rectangle.
     * @param {boolean} isSideBySide True to slice horizontally (along x), false vertically (along y).
     * @param {number} offset Start of the slice on that axis.
     * @param {number} extent Length of the slice.
     * @returns {Rect} The slice.
     */
    static #sliceAlongAxis(rect, isSideBySide, offset, extent) {
      return isSideBySide
        ? { left: offset, top: rect.top, width: extent, height: rect.height }
        : { left: rect.left, top: offset, width: rect.width, height: extent };
    }

    /**
     * Whether a drop would leave the layout unchanged: onto the panel's own zone, either as a tab or
     * as a split of a zone holding only that panel.
     * @param {string} panelId Panel id.
     * @param {string} targetLeafId Target zone id.
     * @param {string} region Drop region.
     * @returns {boolean} True for a no-op drop.
     */
    #isDropOntoOwnZone(panelId, targetLeafId, region) {
      const sourceLeaf = this.findLeafContaining(panelId);
      return Boolean(sourceLeaf) && sourceLeaf.id === targetLeafId && (region === 'center' || sourceLeaf.tabs.length === 1);
    }

    /**
     * Whether a panel is the single panel of the whole layout.
     * @param {string} panelId Panel id.
     * @returns {boolean} True when the root is a zone holding only that panel.
     */
    #isOnlyPanel(panelId) {
      return this.root.type === 'leaf' && this.root.tabs.length === 1 && this.root.tabs[0] === panelId;
    }

    /**
     * Replaces a zone with a split of the zone and a new zone holding a panel.
     * @param {LeafNode} targetLeaf Zone to split.
     * @param {string} panelId Panel for the new zone.
     * @param {string} side Side of the new zone: 'left', 'right', 'top' or 'bottom'.
     * @returns {void}
     */
    #splitLeaf(targetLeaf, panelId, side) {
      this.#replaceNode(targetLeaf, {
        type: 'split',
        direction: DockTree.#directionForSide(side),
        sizes: [0.5, 0.5],
        children: DockTree.#orderForSide(side, targetLeaf, DockTree.#createLeafWithNewId([panelId])),
      });
    }

    /**
     * Every node with its parent, depth first.
     * @param {DockNode} node Starting node.
     * @param {?SplitNode} parent Its parent, or null for the root.
     * @yields {{node: DockNode, parent: ?SplitNode}} Each node and its parent.
     * @returns {Generator<{node: DockNode, parent: ?SplitNode}, void, void>} The nodes in tree order.
     */
    static *#walkWithParents(node, parent) {
      yield { node, parent };
      for (const child of node.children ?? []) yield* DockTree.#walkWithParents(child, node);
    }

    /**
     * The first node matching a predicate, with its parent.
     * @param {function(DockNode): boolean} predicate Test for each node.
     * @returns {?{node: DockNode, parent: ?SplitNode}} The match, or null.
     */
    #findWithParent(predicate) {
      for (const entry of DockTree.#walkWithParents(this.root, null)) {
        if (predicate(entry.node)) return entry;
      }
      return null;
    }

    /**
     * The first node matching a predicate.
     * @param {function(DockNode): boolean} predicate Test for each node.
     * @returns {?DockNode} The node, or null.
     */
    #findNode(predicate) {
      const entry = this.#findWithParent(predicate);
      return entry ? entry.node : null;
    }

    /**
     * Puts a replacement where a node is in the tree.
     * @param {DockNode} node Node to replace.
     * @param {DockNode} replacement Its replacement.
     * @returns {void}
     */
    #replaceNode(node, replacement) {
      const { parent } = this.#findWithParent(candidate => candidate === node);
      if (parent) parent.children[parent.children.indexOf(node)] = replacement;
      else this.root = replacement;
    }

    /**
     * Removes a node from its split and rescales the siblings; a split left with one child is
     * replaced by that child.
     * @param {DockNode} node Node to remove; must not be the root.
     * @returns {void}
     */
    #removeNode(node) {
      const { parent } = this.#findWithParent(candidate => candidate === node);
      const index = parent.children.indexOf(node);
      parent.children.splice(index, 1);
      parent.sizes.splice(index, 1);
      parent.sizes = DockTree.#normalizeSizes(parent.sizes);
      if (parent.children.length === 1) this.#replaceNode(parent, parent.children[0]);
    }

    /**
     * Removes a tab from a zone, activating the first remaining tab if it was active.
     * @param {LeafNode} leaf The zone.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    static #removeTab(leaf, panelId) {
      leaf.tabs = leaf.tabs.filter(tab => tab !== panelId);
      if (leaf.activeTab === panelId) leaf.activeTab = leaf.tabs.length ? leaf.tabs[0] : null;
    }

    /**
     * Adds a panel as the active tab of a zone.
     * @param {LeafNode} leaf The zone.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    static #addTab(leaf, panelId) {
      leaf.tabs.push(panelId);
      leaf.activeTab = panelId;
    }

    /**
     * Creates a zone with a given id; the first tab is active.
     * @param {string[]} tabs Panel ids, at least one.
     * @param {string} leafId Zone id.
     * @returns {LeafNode} The zone.
     */
    static #createLeaf(tabs, leafId) {
      return { type: 'leaf', id: leafId, tabs: [...tabs], activeTab: tabs[0] };
    }

    /**
     * Creates a zone with a new unique id.
     * @param {string[]} tabs Panel ids, at least one.
     * @returns {LeafNode} The zone.
     */
    static #createLeafWithNewId(tabs) {
      return DockTree.#createLeaf(tabs, `leaf-${crypto.randomUUID()}`);
    }

    /**
     * Whether a side comes first in its split.
     * @param {string} side 'left', 'right', 'top' or 'bottom'.
     * @returns {boolean} True for left and top.
     */
    static #isLeadingSide(side) {
      return side === 'left' || side === 'top';
    }

    /**
     * Split direction for a side.
     * @param {string} side 'left', 'right', 'top' or 'bottom'.
     * @returns {'row'|'column'} 'row' for left and right, 'column' for top and bottom.
     */
    static #directionForSide(side) {
      return side === 'left' || side === 'right' ? 'row' : 'column';
    }

    /**
     * Orders an existing node and an added one for a split.
     * @param {string} side Side the added node goes on.
     * @param {DockNode} existingNode Node already there.
     * @param {DockNode} addedNode Node being added.
     * @returns {DockNode[]} Both nodes in split order.
     */
    static #orderForSide(side, existingNode, addedNode) {
      return DockTree.#isLeadingSide(side) ? [addedNode, existingNode] : [existingNode, addedNode];
    }

    /**
     * Scales sizes to sum to 1.
     * @param {number[]} sizes Positive sizes.
     * @returns {number[]} The scaled sizes; equal shares if the sum is 0.
     */
    static #normalizeSizes(sizes) {
      const total = sizes.reduce((sum, size) => sum + size, 0);
      return total > 0 ? sizes.map(size => size / total) : sizes.map(() => 1 / sizes.length);
    }

    /**
     * Validates a stored node.
     * @param {*} node Stored node.
     * @param {Set<string>} knownPanelIds Ids of the existing panels.
     * @param {Set<string>} placedPanelIds Panel ids already placed; modified in place.
     * @returns {?DockNode} The cleaned node, or null when nothing valid remains.
     */
    static #sanitizeNode(node, knownPanelIds, placedPanelIds) {
      if (DockTree.#isStoredLeaf(node)) return DockTree.#sanitizeLeaf(node, knownPanelIds, placedPanelIds);
      if (DockTree.#isStoredSplit(node)) return DockTree.#sanitizeSplit(node, knownPanelIds, placedPanelIds);
      return null;
    }

    /**
     * Whether a stored value looks like a zone.
     * @param {*} node Stored value.
     * @returns {boolean} True for an object with type 'leaf' and a tabs array.
     */
    static #isStoredLeaf(node) {
      return Boolean(node) && node.type === 'leaf' && Array.isArray(node.tabs);
    }

    /**
     * Whether a stored value looks like a split.
     * @param {*} node Stored value.
     * @returns {boolean} True for an object with type 'split' and a children array.
     */
    static #isStoredSplit(node) {
      return Boolean(node) && node.type === 'split' && Array.isArray(node.children);
    }

    /**
     * Keeps a stored zone's known, not yet placed tabs.
     * @param {{id: *, tabs: Array<*>, activeTab: *}} node Stored zone.
     * @param {Set<string>} knownPanelIds Ids of the existing panels.
     * @param {Set<string>} placedPanelIds Panel ids already placed; modified in place.
     * @returns {?LeafNode} The zone, or null when no tab remains.
     */
    static #sanitizeLeaf(node, knownPanelIds, placedPanelIds) {
      const tabs = node.tabs.filter(panelId => knownPanelIds.has(panelId) && !placedPanelIds.has(panelId));
      if (tabs.length === 0) return null;
      tabs.forEach(panelId => placedPanelIds.add(panelId));
      const leaf = typeof node.id === 'string' ? DockTree.#createLeaf(tabs, node.id) : DockTree.#createLeafWithNewId(tabs);
      if (tabs.includes(node.activeTab)) leaf.activeTab = node.activeTab;
      return leaf;
    }

    /**
     * Keeps a stored split's valid children and rescales their sizes; a split with one child is
     * replaced by the child.
     * @param {{direction: *, sizes: *, children: Array<*>}} node Stored split.
     * @param {Set<string>} knownPanelIds Ids of the existing panels.
     * @param {Set<string>} placedPanelIds Panel ids already placed; modified in place.
     * @returns {?DockNode} The cleaned node, or null when no child remains.
     */
    static #sanitizeSplit(node, knownPanelIds, placedPanelIds) {
      const keptChildren = node.children
        .map((child, index) => ({ node: DockTree.#sanitizeNode(child, knownPanelIds, placedPanelIds), size: DockTree.#storedSize(node.sizes, index) }))
        .filter(entry => entry.node);
      if (keptChildren.length < 2) return keptChildren.length ? keptChildren[0].node : null;
      return {
        type: 'split',
        direction: node.direction === 'column' ? 'column' : 'row',
        sizes: DockTree.#normalizeSizes(keptChildren.map(entry => entry.size)),
        children: keptChildren.map(entry => entry.node),
      };
    }

    /**
     * A stored child size, if valid.
     * @param {*} sizes Stored sizes.
     * @param {number} index Child index.
     * @returns {number} The size if it is a positive finite number, otherwise 1.
     */
    static #storedSize(sizes, index) {
      const size = Array.isArray(sizes) ? sizes[index] : NaN;
      return Number.isFinite(size) && size > 0 ? size : 1;
    }
  }

  /**
   * The menu behind a zone's "+" button, offering a new chat or a new instance of a view panel as a
   * tab of that zone.
   */
  class AddPanelMenu {
    /**
     * The popup showing the entries.
     * @type {PopupMenu}
     */
    #popupMenu = new PopupMenu();

    /**
     * Provides the current entries.
     * @type {function(): ChoiceOption[]}
     */
    #entries;

    /**
     * Called with the chosen entry id and the zone id.
     * @type {function(string, string): void}
     */
    #onSelect;

    /**
     * Creates the menu.
     * @param {object} options Menu options.
     * @param {function(): ChoiceOption[]} options.entries Provides the current entries.
     * @param {function(string, string): void} options.onSelect Called with the chosen entry id and the zone id.
     */
    constructor({ entries, onSelect }) {
      this.#entries = entries;
      this.#onSelect = onSelect;
    }

    /**
     * Opens the menu at the pointer for a zone.
     * @param {MouseEvent} event Click on the zone's "+" button.
     * @param {string} leafId Zone id.
     * @returns {void}
     */
    open(event, leafId) {
      this.#popupMenu.open({
        left: event.clientX,
        top: event.clientY,
        entries: this.#entries(),
        onSelect: entryId => this.#onSelect(entryId, leafId),
      });
    }
  }

  /**
   * Positions a fixed-position element over a rectangle.
   * @param {HTMLElement} element The element.
   * @param {Rect} rect Target rectangle.
   * @returns {void}
   */
  function placeElement(element, rect) {
    Object.assign(element.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  var stylesheet$a = "html.claude-plus-resizing-horizontally,\r\nhtml.claude-plus-resizing-horizontally * {\r\n  cursor: col-resize !important;\r\n  user-select: none;\r\n}\r\n\r\nhtml.claude-plus-resizing-vertically,\r\nhtml.claude-plus-resizing-vertically * {\r\n  cursor: row-resize !important;\r\n  user-select: none;\r\n}\r\n\r\n.claude-plus-divider-layer {\r\n  position: fixed;\r\n  inset: 0;\r\n  pointer-events: none;\r\n  z-index: var(--claude-plus-layer-divider);\r\n}\r\n\r\n.claude-plus-divider {\r\n  position: fixed;\r\n  pointer-events: auto;\r\n  background: transparent;\r\n}\r\n\r\n.claude-plus-divider--vertical {\r\n  cursor: col-resize;\r\n}\r\n\r\n.claude-plus-divider--horizontal {\r\n  cursor: row-resize;\r\n}\r\n\r\n.claude-plus-divider:hover {\r\n  background: var(--claude-plus-color-accent);\r\n}\r\n";

  StyleRegistry.register(stylesheet$a);

  /**
   * Draws the dividers between split children on a layer above the panels, so they can be grabbed
   * along their full length, and reports how far a dragged divider moved.
   */
  class DividerRenderer {
    /**
     * Layer holding every divider.
     * @type {HTMLElement}
     */
    #layer = createElement('div', { className: 'claude-plus-divider-layer' });

    /**
     * Called on every move with the split, the divider index, the sizes at the start and the moved fraction.
     * @type {function(SplitNode, number, number[], number): void}
     */
    #onResize;

    /**
     * Called once a divider is released.
     * @type {function(): void}
     */
    #onResizeEnd;

    /**
     * Creates the renderer.
     * @param {object} callbacks Resize callbacks.
     * @param {function(SplitNode, number, number[], number): void} callbacks.onResize Called on every move with the split, the divider index, the sizes at the start and the moved fraction of the split's extent.
     * @param {function(): void} callbacks.onResizeEnd Called once a divider is released.
     */
    constructor({ onResize, onResizeEnd }) {
      this.#onResize = onResize;
      this.#onResizeEnd = onResizeEnd;
    }

    /**
     * The layer element, to add to the page.
     * @returns {HTMLElement} The layer.
     */
    get layer() {
      return this.#layer;
    }

    /**
     * Removes every drawn divider.
     * @returns {void}
     */
    clear() {
      this.#layer.replaceChildren();
    }

    /**
     * Draws a divider that resizes its split when dragged.
     * @param {DividerPlacement} placement The divider.
     * @returns {void}
     */
    render(placement) {
      const isSideBySide = placement.split.direction === 'row';
      const className = isSideBySide ? 'claude-plus-divider claude-plus-divider--vertical' : 'claude-plus-divider claude-plus-divider--horizontal';
      const divider = createElement('div', { className });
      placeElement(divider, DividerRenderer.#grabArea(placement, isSideBySide));
      divider.addEventListener('mousedown', event => this.#startDrag(event, placement, isSideBySide));
      this.#layer.append(divider);
    }

    /**
     * Grab area of a divider, centred on the boundary.
     * @param {DividerPlacement} placement The divider.
     * @param {boolean} isSideBySide Whether the split places children side by side.
     * @returns {Rect} The area.
     */
    static #grabArea({ rect, position }, isSideBySide) {
      const start = position - LAYOUT.dividerThickness / 2;
      return isSideBySide
        ? { left: start, top: rect.top, width: LAYOUT.dividerThickness, height: rect.height }
        : { left: rect.left, top: start, width: rect.width, height: LAYOUT.dividerThickness };
    }

    /**
     * Pointer coordinate along a split axis.
     * @param {MouseEvent} event Pointer event.
     * @param {boolean} isSideBySide True for the x coordinate, false for y.
     * @returns {number} The coordinate.
     */
    static #pointerPositionAlongAxis(event, isSideBySide) {
      return isSideBySide ? event.clientX : event.clientY;
    }

    /**
     * Reports the moved fraction while a divider is dragged, with the resize cursor forced on the
     * whole page, and reports the release.
     * @param {MouseEvent} startEvent The mousedown on the divider.
     * @param {DividerPlacement} placement The divider.
     * @param {boolean} isSideBySide Whether the split places children side by side.
     * @returns {void}
     */
    #startDrag(startEvent, { split, index, rect }, isSideBySide) {
      startEvent.preventDefault();
      const startSizes = [...split.sizes];
      const startPosition = DividerRenderer.#pointerPositionAlongAxis(startEvent, isSideBySide);
      const extent = isSideBySide ? rect.width : rect.height;
      const resizingClass = isSideBySide ? 'claude-plus-resizing-horizontally' : 'claude-plus-resizing-vertically';
      document.documentElement.classList.add(resizingClass);
      new DragGesture(startEvent, {
        threshold: 0,
        onMove: event => this.#onResize(split, index, startSizes, (DividerRenderer.#pointerPositionAlongAxis(event, isSideBySide) - startPosition) / extent),
        onEnd: () => {
          document.documentElement.classList.remove(resizingClass);
          this.#onResizeEnd();
        },
      });
    }
  }

  /**
   * Finds where a dragged panel would dock for a pointer position: an outer workspace edge when the
   * pointer is near one, otherwise the centre or a side of the zone under the pointer.
   */
  class DropTargetResolver {
    /**
     * Highlight area for each outer edge drop, given the workspace bounds and the capped width and height.
     * @type {Readonly<Record<string, function(Rect, number, number): Rect>>}
     */
    static #EDGE_HIGHLIGHTS = Object.freeze({
      left: (bounds, width) => ({ ...bounds, width }),
      right: (bounds, width) => ({ ...bounds, left: bounds.left + bounds.width - width, width }),
      top: (bounds, width, height) => ({ ...bounds, height }),
      bottom: (bounds, width, height) => ({ ...bounds, top: bounds.top + bounds.height - height, height }),
    });

    /**
     * Highlight area for each zone drop region, given the zone's area.
     * @type {Readonly<Record<string, function(Rect): Rect>>}
     */
    static #REGION_HIGHLIGHTS = Object.freeze({
      center: rect => rect,
      top: rect => ({ ...rect, height: rect.height / 2 }),
      bottom: rect => ({ ...rect, top: rect.top + rect.height / 2, height: rect.height / 2 }),
      left: rect => ({ ...rect, width: rect.width / 2 }),
      right: rect => ({ ...rect, left: rect.left + rect.width / 2, width: rect.width / 2 }),
    });

    /**
     * The drop target under the pointer.
     * @param {number} pointerX Pointer x.
     * @param {number} pointerY Pointer y.
     * @param {Rect} bounds Workspace area.
     * @param {LeafPlacement[]} leafPlacements Zone areas of the current layout.
     * @returns {?DropTarget} The target, or null outside every zone.
     */
    static resolve(pointerX, pointerY, bounds, leafPlacements) {
      const edge = DropTargetResolver.#outerEdgeNear(pointerX, pointerY, bounds);
      if (edge) return { edge, leafId: null, region: null, rect: DropTargetResolver.#edgeHighlight(edge, bounds) };
      const hoveredZone = leafPlacements.find(({ rect }) => DropTargetResolver.#containsPoint(rect, pointerX, pointerY));
      return hoveredZone ? DropTargetResolver.#zoneDropTarget(hoveredZone, pointerX, pointerY) : null;
    }

    /**
     * Drop target within a zone.
     * @param {LeafPlacement} placement The zone under the pointer.
     * @param {number} pointerX Pointer x.
     * @param {number} pointerY Pointer y.
     * @returns {DropTarget} The target.
     */
    static #zoneDropTarget({ leaf, rect }, pointerX, pointerY) {
      const region = DropTargetResolver.#regionAt((pointerX - rect.left) / rect.width, (pointerY - rect.top) / rect.height);
      return { edge: null, leafId: leaf.id, region, rect: DropTargetResolver.#REGION_HIGHLIGHTS[region](rect) };
    }

    /**
     * Whether a point lies inside a rectangle, edges included.
     * @param {Rect} rect The rectangle.
     * @param {number} pointX Point x.
     * @param {number} pointY Point y.
     * @returns {boolean} True when inside.
     */
    static #containsPoint(rect, pointX, pointY) {
      return pointX >= rect.left && pointX <= rect.left + rect.width && pointY >= rect.top && pointY <= rect.top + rect.height;
    }

    /**
     * The outer workspace edge within LAYOUT.edgeDropMargin of a point, checked left, right, top, bottom.
     * @param {number} pointX Point x.
     * @param {number} pointY Point y.
     * @param {Rect} bounds Workspace area.
     * @returns {?string} 'left', 'right', 'top' or 'bottom', or null when no edge is near.
     */
    static #outerEdgeNear(pointX, pointY, bounds) {
      const distanceByEdge = {
        left: pointX - bounds.left,
        right: bounds.left + bounds.width - pointX,
        top: pointY - bounds.top,
        bottom: bounds.top + bounds.height - pointY,
      };
      return Object.keys(distanceByEdge).find(edge => distanceByEdge[edge] < LAYOUT.edgeDropMargin) ?? null;
    }

    /**
     * Highlight area for an outer edge drop, capped in size.
     * @param {string} edge 'left', 'right', 'top' or 'bottom'.
     * @param {Rect} bounds Workspace area.
     * @returns {Rect} The area.
     */
    static #edgeHighlight(edge, bounds) {
      const width = Math.min(bounds.width * LAYOUT.edgeDockFraction, LAYOUT.edgeHighlightMaxWidth);
      const height = Math.min(bounds.height * LAYOUT.edgeDockFraction, LAYOUT.edgeHighlightMaxHeight);
      return DropTargetResolver.#EDGE_HIGHLIGHTS[edge](bounds, width, height);
    }

    /**
     * Drop region for a position within a zone: a side when within LAYOUT.sideDropFraction of it
     * (top and bottom first), otherwise the centre.
     * @param {number} fractionAcross Position across the zone, 0 to 1.
     * @param {number} fractionDown Position down the zone, 0 to 1.
     * @returns {string} 'top', 'bottom', 'left', 'right' or 'center'.
     */
    static #regionAt(fractionAcross, fractionDown) {
      const sideShare = LAYOUT.sideDropFraction;
      const candidates = [
        ['top', fractionDown < sideShare],
        ['bottom', fractionDown > 1 - sideShare],
        ['left', fractionAcross < sideShare],
        ['right', fractionAcross > 1 - sideShare],
      ];
      const match = candidates.find(([, isHit]) => isHit);
      return match ? match[0] : 'center';
    }
  }

  var stylesheet$9 = ".claude-plus-drop-highlight[hidden] {\r\n  display: none !important;\r\n}\r\n\r\n.claude-plus-drag-label {\r\n  position: fixed;\r\n  z-index: var(--claude-plus-layer-drag-label);\r\n  background: var(--claude-plus-color-accent);\r\n  color: #fff;\r\n  padding: 4px 10px;\r\n  border-radius: 6px;\r\n  font-size: 12px;\r\n  pointer-events: none;\r\n}\r\n\r\n.claude-plus-drop-highlight {\r\n  position: fixed;\r\n  z-index: var(--claude-plus-layer-drop-highlight);\r\n  background: var(--claude-plus-color-accent-overlay);\r\n  border: 2px solid var(--claude-plus-color-accent);\r\n  pointer-events: none;\r\n  box-sizing: border-box;\r\n}\r\n";

  StyleRegistry.register(stylesheet$9);

  /**
   * One drag of something to dock, a tab or a not yet existing panel: a floating label follows the
   * pointer, the drop target under it is highlighted, and on release the chosen target is reported.
   */
  class PanelDropDrag {
    /**
     * Floating label following the pointer.
     * @type {HTMLElement}
     */
    #dragLabel;

    /**
     * Highlight of the drop target under the pointer.
     * @type {HTMLElement}
     */
    #dropHighlight;

    /**
     * Finds the drop target for a pointer position.
     * @type {function(number, number): ?DropTarget}
     */
    #findDropTarget;

    /**
     * Called with the chosen target when released over one.
     * @type {function(DropTarget): void}
     */
    #onDrop;

    /**
     * Target under the pointer at the last move, or null.
     * @type {?DropTarget}
     */
    #dropTarget = null;

    /**
     * Starts the drag from a mousedown.
     * @param {MouseEvent} startEvent The mousedown that starts the drag.
     * @param {object} options Drag options.
     * @param {string} options.label Text of the floating label.
     * @param {function(number, number): ?DropTarget} options.findDropTarget Finds the drop target for a pointer position.
     * @param {function(DropTarget): void} options.onDrop Called with the chosen target when released over one.
     */
    constructor(startEvent, { label, findDropTarget, onDrop }) {
      startEvent.preventDefault();
      this.#findDropTarget = findDropTarget;
      this.#onDrop = onDrop;
      this.#dragLabel = createElement('div', { className: 'claude-plus-themed claude-plus-drag-label', textContent: label, hidden: true });
      this.#dropHighlight = createElement('div', { className: 'claude-plus-drop-highlight', hidden: true });
      document.body.append(this.#dragLabel, this.#dropHighlight);
      new DragGesture(startEvent, {
        threshold: LAYOUT.dragThreshold,
        onMove: event => this.#followPointer(event),
        onEnd: (event, wasDragged) => this.#finish(wasDragged),
      });
    }

    /**
     * Moves the label to the pointer and highlights the drop target under it.
     * @param {MouseEvent} event Current pointer event.
     * @returns {void}
     */
    #followPointer(event) {
      this.#dropTarget = this.#findDropTarget(event.clientX, event.clientY);
      this.#dragLabel.hidden = false;
      Object.assign(this.#dragLabel.style, { left: `${event.clientX + LAYOUT.dragLabelOffset}px`, top: `${event.clientY + LAYOUT.dragLabelOffset}px` });
      this.#dropHighlight.hidden = !this.#dropTarget;
      if (this.#dropTarget) placeElement(this.#dropHighlight, this.#dropTarget.rect);
    }

    /**
     * Removes the label and highlight and reports the target when a drag ended over one.
     * @param {boolean} wasDragged Whether the pointer moved past the drag threshold.
     * @returns {void}
     */
    #finish(wasDragged) {
      this.#dragLabel.remove();
      this.#dropHighlight.remove();
      if (wasDragged && this.#dropTarget) this.#onDrop(this.#dropTarget);
    }
  }

  /**
   * The panels known to the workspace, by id, docked or not. Adds a panel's element to the page on
   * first show, positions it, and hides the ones not visible in the current layout.
   */
  class PanelHost {
    /**
     * Panels by id.
     * @type {Map<string, Panel>}
     */
    #panelsById;

    /**
     * Creates the host.
     * @param {Map<string, Panel>} panelsById Initial panels by id; the map is taken over, not copied.
     */
    constructor(panelsById) {
      this.#panelsById = panelsById;
    }

    /**
     * Ids of all known panels.
     * @returns {string[]} The ids.
     */
    get panelIds() {
      return [...this.#panelsById.keys()];
    }

    /**
     * All known panels with their ids.
     * @returns {Array<[string, Panel]>} Id and panel pairs.
     */
    get entries() {
      return [...this.#panelsById];
    }

    /**
     * Makes a panel known, replacing one with the same id.
     * @param {string} panelId Panel id.
     * @param {Panel} panel The panel.
     * @returns {void}
     */
    add(panelId, panel) {
      this.#panelsById.set(panelId, panel);
    }

    /**
     * Whether a panel is known.
     * @param {string} panelId Panel id.
     * @returns {boolean} True when it is known.
     */
    has(panelId) {
      return this.#panelsById.has(panelId);
    }

    /**
     * Forgets a panel and disposes it.
     * @param {string} panelId Panel id.
     * @returns {boolean} True when the panel was known.
     */
    remove(panelId) {
      const panel = this.#panelsById.get(panelId);
      if (!panel) return false;
      this.#panelsById.delete(panelId);
      panel.dispose();
      return true;
    }

    /**
     * Title of a panel.
     * @param {string} panelId Panel id.
     * @returns {string} Its title, or the id for an unknown panel.
     */
    titleOf(panelId) {
      const panel = this.#panelsById.get(panelId);
      return panel ? panel.title : panelId;
    }

    /**
     * Whether a panel may be closed by the user.
     * @param {string} panelId Panel id.
     * @returns {boolean} True when the panel is known and allows closing.
     */
    canClose(panelId) {
      const panel = this.#panelsById.get(panelId);
      return Boolean(panel) && panel.canClose();
    }

    /**
     * Asks a panel to close itself.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    close(panelId) {
      this.#panelsById.get(panelId)?.close();
    }

    /**
     * Positions and shows a panel, adding it to the page on first use. Unknown ids are ignored.
     * @param {string} panelId Panel id.
     * @param {Rect} contentRect Area the panel fills.
     * @returns {void}
     */
    show(panelId, contentRect) {
      const panel = this.#panelsById.get(panelId);
      if (!panel) return;
      const { element } = panel;
      if (!element.isConnected) document.body.append(element);
      placeElement(element, contentRect);
      element.style.visibility = 'visible';
    }

    /**
     * Hides every built panel that isn't visible.
     * @param {Set<string>} visiblePanelIds Ids of the visible panels.
     * @returns {void}
     */
    hideAllExcept(visiblePanelIds) {
      for (const [panelId, panel] of this.#panelsById) {
        if (!visiblePanelIds.has(panelId) && panel.isBuilt) panel.element.style.visibility = 'hidden';
      }
    }
  }

  var stylesheet$8 = ".claude-plus-zone-chrome-layer {\r\n  position: fixed;\r\n  inset: 0;\r\n  pointer-events: none;\r\n  z-index: var(--claude-plus-layer-zone-chrome);\r\n}\r\n\r\n.claude-plus-zone-frame {\r\n  position: fixed;\r\n  background: var(--claude-plus-color-background);\r\n  border: 1px solid var(--claude-plus-color-border);\r\n  box-sizing: border-box;\r\n}\r\n\r\n.claude-plus-tab-strip {\r\n  position: fixed;\r\n  display: flex;\r\n  align-items: center;\r\n  background: var(--claude-plus-color-bar);\r\n  overflow-x: auto;\r\n  overflow-y: hidden;\r\n  box-sizing: border-box;\r\n  pointer-events: auto;\r\n}\r\n\r\n/*\r\n * The strip itself carries no border-bottom: a child can never paint over a pixel that belongs to\r\n * its parent's own border (borders live outside the content-box children are confined to), so a\r\n * gap in the strip's own border could never actually open under a child. Instead, every element\r\n * in the strip - each tab, the \"+\" button, the trailing filler - draws this same 1px line itself,\r\n * all sized to the identical height below so their lines stay pixel-aligned with each other. Only\r\n * the active tab of a bordered zone omits its own line, which is a real gap since nothing else\r\n * occupies that stretch, rather than something painted over.\r\n */\r\n.claude-plus-tab {\r\n  height: var(--claude-plus-tab-strip-height);\r\n  padding: 5px 12px;\r\n  font-size: 12px;\r\n  color: var(--claude-plus-color-text-muted);\r\n  cursor: pointer;\r\n  white-space: nowrap;\r\n  border-right: 1px solid var(--claude-plus-color-border-faint);\r\n  box-sizing: border-box;\r\n  user-select: none;\r\n}\r\n\r\n.claude-plus-tab-strip__border--neutral {\r\n  border-bottom: 1px solid var(--claude-plus-color-border);\r\n}\r\n\r\n.claude-plus-tab-strip__border--active {\r\n  border-bottom: 1px solid var(--claude-plus-color-active-chat);\r\n}\r\n\r\n.claude-plus-tab-strip__border--inactive {\r\n  border-bottom: 1px solid var(--claude-plus-color-inactive-border, rgba(255, 255, 255, 0.16));\r\n}\r\n\r\n.claude-plus-tab--active {\r\n  color: var(--claude-plus-color-text);\r\n  border-bottom: 2px solid var(--claude-plus-color-accent);\r\n}\r\n\r\n.claude-plus-tab--active.claude-plus-tab--border-active {\r\n  border-left: 1px solid var(--claude-plus-color-active-chat);\r\n  border-top: 1px solid var(--claude-plus-color-active-chat);\r\n  border-right: 1px solid var(--claude-plus-color-active-chat);\r\n  border-bottom: none;\r\n  border-top-left-radius: 6px;\r\n  border-top-right-radius: 6px;\r\n}\r\n\r\n.claude-plus-tab--active.claude-plus-tab--border-inactive {\r\n  border-left: 1px solid var(--claude-plus-color-inactive-border, rgba(255, 255, 255, 0.16));\r\n  border-top: 1px solid var(--claude-plus-color-inactive-border, rgba(255, 255, 255, 0.16));\r\n  border-right: 1px solid var(--claude-plus-color-inactive-border, rgba(255, 255, 255, 0.16));\r\n  border-bottom: none;\r\n  border-top-left-radius: 6px;\r\n  border-top-right-radius: 6px;\r\n}\r\n\r\n.claude-plus-tab {\r\n  display: flex;\r\n  align-items: center;\r\n  min-width: 0;\r\n  max-width: 220px;\r\n}\r\n\r\n.claude-plus-tab__label {\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.claude-plus-tab--chat .claude-plus-tab__label {\r\n  font-weight: 600;\r\n}\r\n\r\n.claude-plus-tab__close-button {\r\n  flex-shrink: 0;\r\n  margin-left: 8px;\r\n  padding: 0 3px;\r\n  border-radius: 3px;\r\n  color: var(--claude-plus-color-text-faint);\r\n}\r\n\r\n.claude-plus-tab__close-button:hover {\r\n  background: var(--claude-plus-color-hover);\r\n  color: var(--claude-plus-color-text);\r\n}\r\n\r\n.claude-plus-tab-strip__add-button {\r\n  height: var(--claude-plus-tab-strip-height);\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  padding: 5px 10px;\r\n  cursor: pointer;\r\n  color: var(--claude-plus-color-text-faint);\r\n  box-sizing: border-box;\r\n  user-select: none;\r\n}\r\n\r\n.claude-plus-tab-strip__add-button:hover {\r\n  color: var(--claude-plus-color-text);\r\n}\r\n\r\n.claude-plus-tab-strip__filler {\r\n  height: var(--claude-plus-tab-strip-height);\r\n  flex: 1;\r\n  box-sizing: border-box;\r\n}\r\n\r\n.claude-plus-table-host {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 4px;\r\n  flex: 1;\r\n  min-height: 0;\r\n}\r\n";

  StyleRegistry.register(stylesheet$8);

  /**
   * Draws each zone's frame and tab strip on a layer below the panels. A tab shows its panel's
   * title and an optional close button; the strip ends with a "+" button. What pressing, clicking
   * and closing do is left to the callbacks.
   */
  class ZoneChromeRenderer {
    /**
     * Layer holding every frame and tab strip.
     * @type {HTMLElement}
     */
    #layer = createElement('div', { className: 'claude-plus-themed claude-plus-zone-chrome-layer' });

    /**
     * Callbacks answering questions about panels and handling tab interaction.
     * @type {ZoneChromeCallbacks}
     */
    #callbacks;

    /**
     * Creates the renderer.
     * @param {ZoneChromeCallbacks} callbacks Callbacks answering questions about panels and handling tab interaction.
     */
    constructor(callbacks) {
      this.#callbacks = callbacks;
    }

    /**
     * The layer element, to add to the page.
     * @returns {HTMLElement} The layer.
     */
    get layer() {
      return this.#layer;
    }

    /**
     * Removes every drawn zone.
     * @returns {void}
     */
    clear() {
      this.#layer.replaceChildren();
    }

    /**
     * Draws a zone's frame and tab strip.
     * @param {LeafPlacement} placement The zone and its area.
     * @returns {void}
     */
    render({ leaf, rect }) {
      const borderKind = this.#callbacks.chatBorderKindOf(leaf.activeTab);
      const frame = createElement('div', { className: 'claude-plus-zone-frame' });
      const tabStrip = createElement('div', { className: 'claude-plus-tab-strip' });
      placeElement(frame, rect);
      placeElement(tabStrip, { ...rect, height: LAYOUT.tabStripHeight });
      tabStrip.append(
        ...leaf.tabs.map(panelId => this.#createTab(leaf, panelId, borderKind)),
        this.#createAddPanelButton(leaf.id, borderKind),
        ZoneChromeRenderer.#createFiller(borderKind),
      );
      this.#layer.append(frame, tabStrip);
    }

    /**
     * The border-bottom modifier every element along the strip shares, so their lines - a plain
     * tab's, the "+" button's, the trailing filler's - stay one continuous, matching-colored border
     * except where the active tab of a bordered zone leaves a real gap in it (see the CSS: only
     * that one tab omits this class, replacing it with its own bordered-flap look instead).
     * @param {?('active'|'inactive')} borderKind The zone's chat border kind, or null for none.
     * @returns {string} The class name.
     */
    static #stripBorderClassName(borderKind) {
      return `claude-plus-tab-strip__border--${borderKind ?? 'neutral'}`;
    }

    /**
     * Creates a tab that reports presses and clicks.
     * @param {LeafNode} leaf Zone of the tab.
     * @param {string} panelId Panel id.
     * @param {?('active'|'inactive')} borderKind The zone's chat border kind, or null for none.
     * @returns {HTMLElement} The tab.
     */
    #createTab(leaf, panelId, borderKind) {
      const title = this.#callbacks.titleOf(panelId);
      const isActiveTab = panelId === leaf.activeTab;
      const className = this.#tabClassName(panelId, isActiveTab, borderKind);
      const tab = createElement('div', { className, title });
      tab.append(createElement('span', { className: 'claude-plus-tab__label', textContent: title }));
      tab.addEventListener('mousedown', event => this.#callbacks.onTabPress(event, panelId));
      tab.addEventListener('click', () => this.#callbacks.onTabActivate(leaf.id, panelId));
      if (this.#callbacks.canClose(panelId)) tab.append(this.#createCloseButton(panelId));
      return tab;
    }

    /**
     * A tab's class names: the base one, plus modifiers for being the strip's active tab, a chat
     * pane, its shared border-bottom color, and (only for a zone's active tab with a chat border)
     * its own bordered-flap look, which replaces that shared border with a real gap instead.
     * @param {string} panelId Panel id.
     * @param {boolean} isActiveTab Whether this is the strip's active tab.
     * @param {?('active'|'inactive')} borderKind The zone's chat border kind, or null for none.
     * @returns {string} The class names.
     */
    #tabClassName(panelId, isActiveTab, borderKind) {
      const classNames = ['claude-plus-tab', ZoneChromeRenderer.#stripBorderClassName(borderKind)];
      if (isActiveTab) classNames.push('claude-plus-tab--active');
      if (this.#callbacks.isChatPane(panelId)) classNames.push('claude-plus-tab--chat');
      if (isActiveTab && borderKind) classNames.push(`claude-plus-tab--border-${borderKind}`);
      return classNames.join(' ');
    }

    /**
     * Creates a tab's close button; pressing it neither activates nor drags the tab.
     * @param {string} panelId Panel id.
     * @returns {HTMLElement} The button.
     */
    #createCloseButton(panelId) {
      const button = createElement('span', { className: 'claude-plus-tab__close-button', textContent: '×', title: 'Close' });
      button.addEventListener('mousedown', event => event.stopPropagation());
      button.addEventListener('click', event => {
        event.stopPropagation();
        this.#callbacks.onTabClose(panelId);
      });
      return button;
    }

    /**
     * Creates the "+" button that offers panels to add to a zone.
     * @param {string} leafId Zone id.
     * @param {?('active'|'inactive')} borderKind The zone's chat border kind, or null for none.
     * @returns {HTMLElement} The button.
     */
    #createAddPanelButton(leafId, borderKind) {
      const className = `claude-plus-tab-strip__add-button ${ZoneChromeRenderer.#stripBorderClassName(borderKind)}`;
      const button = createElement('div', { className, textContent: '+', title: 'Add a chat or panel to this zone' });
      button.addEventListener('click', event => this.#callbacks.onAddClick(event, leafId));
      return button;
    }

    /**
     * Creates the strip's trailing filler, carrying the shared border-bottom onward across any
     * space left of the strip once its tabs and "+" button don't fill it.
     * @param {?('active'|'inactive')} borderKind The zone's chat border kind, or null for none.
     * @returns {HTMLElement} The filler.
     */
    static #createFiller(borderKind) {
      return createElement('div', { className: `claude-plus-tab-strip__filler ${ZoneChromeRenderer.#stripBorderClassName(borderKind)}` });
    }
  }

  /**
   * The docking workspace below the toolbar: keeps the layout tree, lays out zones, tabs, dividers
   * and panels, saves the layout on every change, and docks panels dropped by tab drags.
   */
  class DockWorkspace {
    /**
     * The known panels.
     * @type {PanelHost}
     */
    #panels;

    /**
     * Chat panes, to decide each zone's chat border kind.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Layout storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Current layout.
     * @type {DockTree}
     */
    #tree;

    /**
     * Draws zone frames and tab strips.
     * @type {ZoneChromeRenderer}
     */
    #zoneChrome;

    /**
     * Draws the dividers.
     * @type {DividerRenderer}
     */
    #dividers;

    /**
     * Zone areas from the last layout, used to find drop targets.
     * @type {LeafPlacement[]}
     */
    #leafPlacements = [];

    /**
     * Batches layouts per frame during resizing.
     * @type {FrameScheduler}
     */
    #layoutScheduler = new FrameScheduler(() => this.layout());

    /**
     * The zones' "+" menu.
     * @type {AddPanelMenu}
     */
    #addPanelMenu;

    /**
     * Creates the default layout.
     * @type {function(): DockTree}
     */
    #createDefaultTree;

    /**
     * Ids of the panels that must always be docked.
     * @type {function(): string[]}
     */
    #requiredPanelIds;

    /**
     * Docks a required panel the layout lacks.
     * @type {function(DockTree, string): void}
     */
    #placeMissingPanel;

    /**
     * Called after every layout with the ids of the visible panels.
     * @type {function(Set<string>): void}
     */
    #onLayout;

    /**
     * Creates the workspace from the stored layout, or the default one, and docks any required
     * panel the layout lacks.
     * @param {object} options Workspace options.
     * @param {Map<string, Panel>} options.panels Panels by id; panels can be added and removed later.
     * @param {ChatPaneManager} options.paneManager Chat panes, to decide each zone's chat border kind.
     * @param {Preferences} options.preferences Layout storage.
     * @param {function(): DockTree} options.createDefaultTree Creates the default layout.
     * @param {function(): string[]} options.requiredPanelIds Ids of the panels that must always be docked.
     * @param {function(DockTree, string): void} options.placeMissingPanel Docks a required panel the layout lacks.
     * @param {{entries: function(): ChoiceOption[], onSelect: function(string, string): void}} options.addPanelMenu Entries of the zones' "+" menu, and a callback receiving the chosen entry id and the zone id.
     * @param {function(Set<string>): void} options.onLayout Called after every layout with the ids of the visible panels.
     */
    constructor({ panels, paneManager, preferences, createDefaultTree, requiredPanelIds, placeMissingPanel, addPanelMenu, onLayout }) {
      this.#panels = new PanelHost(panels);
      this.#paneManager = paneManager;
      this.#preferences = preferences;
      this.#createDefaultTree = createDefaultTree;
      this.#requiredPanelIds = requiredPanelIds;
      this.#placeMissingPanel = placeMissingPanel;
      this.#addPanelMenu = new AddPanelMenu(addPanelMenu);
      this.#onLayout = onLayout;
      this.#zoneChrome = this.#createZoneChromeRenderer();
      this.#dividers = this.#createDividerRenderer();
      this.#tree = DockTree.fromStored(preferences.readJson(STORAGE_KEYS.dockLayout), this.#panels.panelIds) ?? createDefaultTree();
      this.#dockMissingRequiredPanels();
      paneManager.subscribe('focus', () => this.#redrawZoneChrome());
    }

    /**
     * Adds the layers to the page, lays out and follows window resizes.
     * @returns {void}
     */
    mount() {
      document.body.append(this.#zoneChrome.layer, this.#dividers.layer);
      window.addEventListener('resize', () => this.#layoutScheduler.schedule());
      this.layout();
    }

    /**
     * Restores the default layout and forgets the stored one.
     * @returns {void}
     */
    resetLayout() {
      this.#preferences.remove(STORAGE_KEYS.dockLayout);
      this.#tree = this.#createDefaultTree();
      this.layout();
    }

    /**
     * Adds a panel and docks it to the right of another one, or into the first zone.
     * @param {string} panelId Id of the new panel.
     * @param {Panel} panel The panel.
     * @param {string} besidePanelId Panel to dock it next to.
     * @returns {void}
     */
    addPanel(panelId, panel, besidePanelId) {
      this.#panels.add(panelId, panel);
      const besideLeaf = this.#tree.findLeafContaining(besidePanelId) || this.#tree.firstLeaf();
      this.#tree.dockPanel(panelId, besideLeaf.id, 'right');
      this.#layoutAndSave();
    }

    /**
     * Adds a panel and docks it at a specific drop target, as chosen during a drag started with
     * beginExternalDrag.
     * @param {string} panelId Id of the new panel.
     * @param {Panel} panel The panel.
     * @param {DropTarget} dropTarget Where to dock it: an outer edge, or a region of a zone.
     * @returns {void}
     */
    addPanelAt(panelId, panel, dropTarget) {
      this.#panels.add(panelId, panel);
      this.#dockAt(panelId, dropTarget);
    }

    /**
     * Drags a floating label for something that doesn't exist as a panel yet, highlighting the same
     * drop targets a tab drag would, and invokes a callback with the chosen target on release. Lets
     * other panels (e.g. the conversation list) offer "drag this to open it as a new pane docked
     * here" without this class needing to know anything about what's being dragged.
     * @param {MouseEvent} startEvent The mousedown that starts the drag.
     * @param {string} label Text shown in the floating drag label.
     * @param {function(DropTarget): void} onDrop Called with the chosen drop target when dropped on one.
     * @returns {void}
     */
    beginExternalDrag(startEvent, label, onDrop) {
      new PanelDropDrag(startEvent, { label, findDropTarget: this.#dropTargetAt, onDrop });
    }

    /**
     * Undocks a panel, disposes it and forgets it.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    removePanel(panelId) {
      if (!this.#panels.has(panelId)) return;
      this.#tree.removePanel(panelId);
      this.#panels.remove(panelId);
      this.#layoutAndSave();
    }

    /**
     * Adds a panel as the active tab of a zone and saves the layout.
     * @param {string} panelId Id of the new panel.
     * @param {Panel} panel The panel.
     * @param {string} leafId Zone id.
     * @returns {void}
     */
    addPanelToZone(panelId, panel, leafId) {
      this.#panels.add(panelId, panel);
      this.#tree.dockPanel(panelId, leafId, 'center');
      this.#layoutAndSave();
    }

    /**
     * Makes a panel known without docking it; used before applying a layout that contains it.
     * @param {string} panelId Panel id.
     * @param {Panel} panel The panel.
     * @returns {void}
     */
    registerPanel(panelId, panel) {
      this.#panels.add(panelId, panel);
    }

    /**
     * Whether a panel is known.
     * @param {string} panelId Panel id.
     * @returns {boolean} True when it exists, docked or not.
     */
    hasPanel(panelId) {
      return this.#panels.has(panelId);
    }

    /**
     * A copy of the current arrangement.
     * @returns {DockNode} The layout tree, detached from the live one.
     */
    layoutSnapshot() {
      return JSON.parse(JSON.stringify(this.#tree));
    }

    /**
     * Applies a stored arrangement: panels it doesn't mention are closed, required panels it lacks
     * are docked, and the result is laid out and saved. Unusable arrangements fall back to the default.
     * @param {*} storedTree Stored layout tree.
     * @returns {void}
     */
    replaceLayout(storedTree) {
      this.#tree = DockTree.fromStored(storedTree, this.#panels.panelIds) ?? this.#createDefaultTree();
      this.#dockMissingRequiredPanels();
      this.#panels.panelIds.filter(panelId => !this.#tree.findLeafContaining(panelId) && this.#panels.canClose(panelId)).forEach(panelId => this.#panels.close(panelId));
      this.#layoutAndSave();
    }

    /**
     * The first docked panel satisfying a predicate.
     * @param {function(Panel): boolean} predicate Test for each panel.
     * @returns {?{panelId: string, panel: Panel}} The panel and its id, or null.
     */
    findDockedPanel(predicate) {
      const entry = this.#panels.entries.find(([panelId, panel]) => this.#tree.findLeafContaining(panelId) && predicate(panel));
      return entry ? { panelId: entry[0], panel: entry[1] } : null;
    }

    /**
     * Makes a docked panel the visible tab of its zone.
     * @param {string} panelId Panel id.
     * @returns {boolean} True if the panel is docked and now visible; false if it isn't docked.
     */
    revealPanel(panelId) {
      const leaf = this.#tree.findLeafContaining(panelId);
      if (leaf) this.#activateTab(leaf.id, panelId);
      return Boolean(leaf);
    }

    /**
     * Redraws just the zone frames and tab strips at their last computed areas, without touching
     * panel positions or dividers; used when only a chat pane's border kind can have changed.
     * @returns {void}
     */
    #redrawZoneChrome() {
      this.#zoneChrome.clear();
      this.#leafPlacements.forEach(placement => this.#zoneChrome.render(placement));
    }

    /**
     * Redraws zone frames, tab strips and dividers and positions the visible panels; other panels
     * are hidden. Reports the visible panels through the onLayout callback.
     * @returns {void}
     */
    layout() {
      const { leaves, dividers } = this.#tree.computeLayout(DockWorkspace.#workspaceBounds());
      this.#leafPlacements = leaves;
      this.#zoneChrome.clear();
      this.#dividers.clear();
      leaves.forEach(placement => this.#renderZone(placement));
      const visiblePanelIds = new Set(leaves.map(placement => placement.leaf.activeTab));
      this.#panels.hideAllExcept(visiblePanelIds);
      dividers.forEach(placement => this.#dividers.render(placement));
      this.#onLayout(visiblePanelIds);
    }

    /**
     * Area available to the dock, below the toolbar.
     * @returns {Rect} The area.
     */
    static #workspaceBounds() {
      return { left: 0, top: LAYOUT.toolbarHeight, width: window.innerWidth, height: window.innerHeight - LAYOUT.toolbarHeight };
    }

    /**
     * Creates the zone chrome renderer, wired to the panels and the tab actions.
     * @returns {ZoneChromeRenderer} The renderer.
     */
    #createZoneChromeRenderer() {
      return new ZoneChromeRenderer({
        titleOf: panelId => this.#panels.titleOf(panelId),
        canClose: panelId => this.#panels.canClose(panelId),
        isChatPane: panelId => ChatPaneManager.isPaneId(panelId),
        chatBorderKindOf: panelId => this.#paneManager.borderKindOf(panelId),
        onTabPress: (event, panelId) => this.#onTabPress(event, panelId),
        onTabActivate: (leafId, panelId) => this.#activateTab(leafId, panelId),
        onTabClose: panelId => this.#panels.close(panelId),
        onAddClick: (event, leafId) => this.#addPanelMenu.open(event, leafId),
      });
    }

    /**
     * Creates the divider renderer, resizing splits once per frame while dragging and saving on release.
     * @returns {DividerRenderer} The renderer.
     */
    #createDividerRenderer() {
      return new DividerRenderer({
        onResize: (split, index, startSizes, movedFraction) => {
          this.#tree.resizeSplit(split, index, startSizes, movedFraction);
          this.#layoutScheduler.schedule();
        },
        onResizeEnd: () => {
          this.#layoutScheduler.cancel();
          this.#layoutAndSave();
        },
      });
    }

    /**
     * Docks every required panel missing from the layout.
     * @returns {void}
     */
    #dockMissingRequiredPanels() {
      const missing = this.#requiredPanelIds().filter(panelId => !this.#tree.findLeafContaining(panelId));
      missing.forEach(panelId => this.#placeMissingPanel(this.#tree, panelId));
    }

    /**
     * Lays out and saves the layout.
     * @returns {void}
     */
    #layoutAndSave() {
      this.layout();
      this.#preferences.writeJson(STORAGE_KEYS.dockLayout, this.#tree);
    }

    /**
     * Draws a zone and shows its active panel below the tab strip.
     * @param {LeafPlacement} placement The zone and its area.
     * @returns {void}
     */
    #renderZone(placement) {
      const { leaf, rect } = placement;
      this.#zoneChrome.render(placement);
      if (leaf.activeTab) this.#panels.show(leaf.activeTab, { ...rect, top: rect.top + LAYOUT.tabStripHeight, height: rect.height - LAYOUT.tabStripHeight });
    }

    /**
     * Shows a tab's panel and saves the layout.
     * @param {string} leafId Zone id.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    #activateTab(leafId, panelId) {
      this.#tree.activateTab(leafId, panelId);
      this.#layoutAndSave();
    }

    /**
     * Starts dragging a tab to another place on a primary-button press.
     * @param {MouseEvent} event The mousedown on a tab.
     * @param {string} panelId Panel of the tab.
     * @returns {void}
     */
    #onTabPress(event, panelId) {
      if (event.button !== 0) return;
      new PanelDropDrag(event, {
        label: this.#panels.titleOf(panelId),
        findDropTarget: this.#dropTargetAt,
        onDrop: dropTarget => this.#dockAt(panelId, dropTarget),
      });
    }

    /**
     * Docks a known panel at a drop target and saves the layout.
     * @param {string} panelId Panel id.
     * @param {DropTarget} dropTarget Where to dock it.
     * @returns {void}
     */
    #dockAt(panelId, dropTarget) {
      if (dropTarget.edge) this.#tree.dockPanelAtEdge(panelId, dropTarget.edge);
      else this.#tree.dockPanel(panelId, dropTarget.leafId, dropTarget.region);
      this.#layoutAndSave();
    }

    /**
     * The drop target under the pointer in the current layout.
     * @param {number} pointerX Pointer x.
     * @param {number} pointerY Pointer y.
     * @returns {?DropTarget} The target, or null outside every zone.
     */
    #dropTargetAt = (pointerX, pointerY) => DropTargetResolver.resolve(pointerX, pointerY, DockWorkspace.#workspaceBounds(), this.#leafPlacements);
  }

  /**
   * The hotkey commands of the app itself, in the order the settings list them. A command's chord is
   * written "Mod+Alt+Shift+Key": Mod is Ctrl, or Cmd on a Mac. The user can rebind each one in the
   * settings; defaultChord applies until they do. Commands of one vendor live with that vendor.
   * @type {ReadonlyArray<Readonly<{id: string, label: string, defaultChord: string}>>}
   */
  const HOTKEY_COMMANDS = Object.freeze([
    Object.freeze({ id: 'findInChat', label: 'Find in the active chat', defaultChord: 'Mod+F' }),
    Object.freeze({ id: 'globalSearch', label: 'Open the global search', defaultChord: 'Mod+Shift+F' }),
    Object.freeze({ id: 'focusChatList', label: 'Search the chat list', defaultChord: 'Mod+K' }),
  ]);

  /**
   * Asks a yes/no question with Cancel and a confirming button; the themed replacement of confirm().
   */
  class ConfirmDialog extends ActionDialog {
    /**
     * Label of the confirming button.
     * @type {string}
     */
    #confirmLabel;

    /**
     * Creates the dialog without showing it.
     * @param {string} message Question to show.
     * @param {string} confirmLabel Label of the confirming button.
     */
    constructor(message, confirmLabel) {
      super(message);
      this.#confirmLabel = confirmLabel;
    }

    /**
     * Asks a question and waits for the answer.
     * @param {string} message Question to show.
     * @param {string} [confirmLabel] Label of the confirming button.
     * @returns {Promise<boolean>} Resolves true if confirmed, false if cancelled.
     */
    static ask(message, confirmLabel = 'Confirm') {
      return new ConfirmDialog(message, confirmLabel).show();
    }

    /**
     * A dismissed question counts as not confirmed.
     * @returns {boolean} Always false.
     */
    get cancelValue() {
      return false;
    }

    /**
     * Builds the Cancel and confirming buttons.
     * @returns {HTMLButtonElement[]} The buttons.
     */
    createActions() {
      return [
        this.createClosingButton('Cancel', false, () => false),
        this.createClosingButton(this.#confirmLabel, true, () => true),
      ];
    }
  }

  /**
   * A timestamp as local date.
   * @param {?string} isoDate ISO timestamp.
   * @returns {string} The formatted date, or an empty string when missing or invalid.
   */
  function formatDay(isoDate) {
    const epochMs = toEpochMs(isoDate);
    return epochMs ? new Date(epochMs).toLocaleDateString() : '';
  }

  var stylesheet$7 = ".claude-plus-conversation:hover .claude-plus-conversation__action-button {\r\n  visibility: visible;\r\n}\r\n\r\n.claude-plus-conversation {\r\n  cursor: pointer;\r\n}\r\n\r\n.claude-plus-conversation:hover > td {\r\n  background: var(--claude-plus-color-hover);\r\n}\r\n\r\n.claude-plus-conversation--active > td {\r\n  background: var(--claude-plus-color-accent-soft);\r\n}\r\n\r\n.claude-plus-conversation--open-elsewhere > td:first-child {\r\n  box-shadow: inset 2px 0 0 var(--claude-plus-color-accent);\r\n}\r\n\r\n.claude-plus-conversation__actions {\r\n  display: inline-flex;\r\n  white-space: nowrap;\r\n}\r\n\r\n.claude-plus-conversation__action-button {\r\n  visibility: hidden;\r\n  background: none;\r\n  border: none;\r\n  cursor: pointer;\r\n  font-size: 12px;\r\n  padding: 4px;\r\n  border-radius: 4px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-conversation__action-button:hover {\r\n  background: rgba(255, 255, 255, 0.1);\r\n}\r\n";

  StyleRegistry.register(stylesheet$7);

  /**
   * Conversation list as a column table, with a quick title search, open in a new pane, delete, and
   * dragging an entry out to open it as a new pane docked where it is dropped. Clicking a
   * conversation opens it in the focused chat pane.
   */
  class ConversationListPanel extends Panel {
    /**
     * Shared conversation list.
     * @type {CombinedConversationDirectory}
     */
    #directory;

    /**
     * Navigation.
     * @type {Router}
     */
    #router;

    /**
     * Chat panes.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Conversation statistics, for the turn and file columns.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Table settings storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Lower-case quick search text.
     * @type {string}
     */
    #searchText = '';

    /**
     * The conversation table; created with the DOM.
     * @type {?ColumnTable}
     */
    #table = null;

    /**
     * Handler per button data-action value inside a conversation row.
     * @type {Map<string, function(HTMLElement): void>}
     */
    #rowActionHandlers = new Map([
      ['delete', row => this.#confirmAndDelete(row)],
      ['openInNewPane', row => this.#paneManager.openPane(row.dataset.conversationId)],
    ]);

    /**
     * Creates the panel.
     * @param {object} services Panel dependencies.
     * @param {CombinedConversationDirectory} services.directory Shared conversation list.
     * @param {Router} services.router Navigation.
     * @param {ChatPaneManager} services.paneManager Chat panes.
     * @param {StatsIndex} services.stats Conversation statistics, for the turn and file columns.
     * @param {Preferences} services.preferences Table settings storage.
     */
    constructor({ directory, router, paneManager, stats, preferences }) {
      super('Chats');
      this.#directory = directory;
      this.#router = router;
      this.#paneManager = paneManager;
      this.#stats = stats;
      this.#preferences = preferences;
    }

    /**
     * HTML of the panel body.
     * @returns {string} Quick search box and table host.
     */
    createBodyHtml() {
      return `
      <input class="claude-plus-search-input" data-name="searchInput" type="text" placeholder="Search chats…" />
      <div class="claude-plus-table-host" data-name="tableHost"></div>`;
    }

    /**
     * Creates the table, wires search, row clicks and drags, and follows list, focus, pane and stats changes.
     * @returns {void}
     */
    bindEvents() {
      this.#table = new ColumnTable({
        container: this.elements.tableHost,
        tableId: 'conversations',
        columns: this.#columns(),
        preferences: this.#preferences,
        defaultSort: { column: 'date', direction: -1 },
        rowAttributes: conversation => this.#rowAttributes(conversation),
        emptyText: 'No conversations.',
      });
      this.elements.searchInput.addEventListener('input', () => this.#applySearch(this.elements.searchInput.value));
      this.#table.bodyElement.addEventListener('mousedown', event => this.#onRowPress(event));
      this.#table.bodyElement.addEventListener('click', event => this.#onRowClick(event));
      this.listenTo(this.#directory, 'conversations', () => this.render());
      this.listenTo(this.#paneManager, 'focus', () => this.render());
      this.listenTo(this.#paneManager, 'paneConversations', () => this.render());
      this.listenTo(this.#stats, 'aggregate', () => this.render());
    }

    /**
     * Shows the conversations matching the quick search.
     * @returns {void}
     */
    render() {
      this.#table.setRows(this.#directory.conversations.filter(conversation => this.#matchesSearch(conversation)));
    }

    /**
     * Closes the table's typeahead and ends the subscriptions.
     * @returns {void}
     */
    dispose() {
      if (this.#table) this.#table.dispose();
      super.dispose();
    }

    /**
     * Moves keyboard focus to the search box and selects its text.
     * @returns {void}
     */
    focusSearch() {
      this.elements.searchInput.focus();
      this.elements.searchInput.select();
    }

    /**
     * The table's columns: name (always shown), date, turns, files, and the row buttons.
     * @returns {TableColumn[]} The columns.
     */
    #columns() {
      return [
        { id: 'name', label: 'Name', isAlwaysVisible: true, filter: 'values', sortValue: conversation => (ConversationListingFields.title(conversation) || '').toLowerCase(), filterValue: conversation => ConversationListingFields.title(conversation) || UNTITLED, cellHtml: conversation => `<span class="claude-plus-conversation__title">${escapeHtml(ConversationListingFields.title(conversation) || UNTITLED)}</span>` },
        { id: 'origin', label: 'Origin', isVisibleByDefault: true, filter: 'values', sortValue: conversation => ConversationListPanel.#originLabel(conversation), filterValue: conversation => ConversationListPanel.#originLabel(conversation), cellHtml: conversation => escapeHtml(ConversationListPanel.#originLabel(conversation)) },
        { id: 'date', label: 'Date', isVisibleByDefault: true, filter: 'date', sortValue: conversation => toEpochMs(ConversationListingFields.updatedAt(conversation)), filterValue: conversation => ConversationListingFields.updatedAt(conversation), cellHtml: conversation => escapeHtml(formatDay(ConversationListingFields.updatedAt(conversation))) },
        { id: 'turns', label: 'Turns', sortValue: conversation => this.#indexedCount(conversation, 'promptCount'), cellHtml: conversation => this.#indexedCountHtml(conversation, 'promptCount') },
        { id: 'files', label: 'Files', sortValue: conversation => this.#indexedCount(conversation, 'fileCount'), cellHtml: conversation => this.#indexedCountHtml(conversation, 'fileCount') },
        { id: 'actions', label: '', isAlwaysVisible: true, isNotSortable: true, sortValue: () => 0, cellHtml: () => ConversationListPanel.#actionButtonsHtml() },
      ];
    }

    /**
     * A conversation's origin, for the Origin column.
     * @param {ConversationListing} conversation The conversation.
     * @returns {'Live'|'Imported'} The label.
     */
    static #originLabel(conversation) {
      return ConversationListingFields.isImported(conversation) ? 'Imported' : 'Live';
    }

    /**
     * A per-conversation count from the stats index.
     * @param {ConversationListing} conversation The conversation.
     * @param {string} field 'promptCount' or 'fileCount'.
     * @returns {number} The count, or -1 while the conversation isn't indexed, so unindexed ones sort together.
     */
    #indexedCount(conversation, field) {
      const counts = this.#stats.aggregate.perConversation.get(ConversationListingFields.id(conversation));
      return counts ? counts[field] : -1;
    }

    /**
     * Cell HTML of a per-conversation count.
     * @param {ConversationListing} conversation The conversation.
     * @param {string} field 'promptCount' or 'fileCount'.
     * @returns {string} The count, or "–" while the conversation isn't indexed.
     */
    #indexedCountHtml(conversation, field) {
      const count = this.#indexedCount(conversation, field);
      return count < 0 ? '–' : String(count);
    }

    /**
     * Attributes of a conversation's row: its id and the modifier showing where it is open.
     * @param {ConversationListing} conversation The conversation.
     * @returns {string} The attributes.
     */
    #rowAttributes(conversation) {
      const conversationId = ConversationListingFields.id(conversation);
      const modifier = ConversationListPanel.#stateModifier(conversationId, this.#paneManager.focusedSession.openConversationId, this.#paneManager.openConversationIds());
      return `class="claude-plus-conversation${modifier}" data-conversation-id="${escapeHtml(conversationId)}"`;
    }

    /**
     * Modifier class marking where a conversation is open.
     * @param {string} conversationId Conversation id.
     * @param {?string} focusedId Conversation of the focused pane.
     * @param {Set<string>} openIds Conversations open in any pane.
     * @returns {string} The active modifier, the open-elsewhere modifier, or an empty string.
     */
    static #stateModifier(conversationId, focusedId, openIds) {
      if (conversationId === focusedId) return ' claude-plus-conversation--active';
      return openIds.has(conversationId) ? ' claude-plus-conversation--open-elsewhere' : '';
    }

    /**
     * HTML of a row's buttons.
     * @returns {string} Open-in-new-pane and delete buttons.
     */
    static #actionButtonsHtml() {
      return `<span class="claude-plus-conversation__actions"><button class="claude-plus-conversation__action-button" data-action="openInNewPane" title="Open in new pane">⧉</button><button class="claude-plus-conversation__action-button" data-action="delete" title="Delete chat">🗑</button></span>`;
    }

    /**
     * Filters the list by title.
     * @param {string} text Search text.
     * @returns {void}
     */
    #applySearch(text) {
      this.#searchText = text.toLowerCase();
      this.render();
    }

    /**
     * Whether a conversation's title contains the quick search text.
     * @param {ConversationListing} conversation The conversation.
     * @returns {boolean} True when it matches or there is no search.
     */
    #matchesSearch(conversation) {
      return (ConversationListingFields.title(conversation) || '').toLowerCase().includes(this.#searchText);
    }

    /**
     * Starts dragging a conversation out of the list on a primary-button press away from its
     * buttons; releasing over a dock target opens it as a new pane docked there. A plain click still
     * reaches #onRowClick.
     * @param {MouseEvent} event Mouse press in the table body.
     * @returns {void}
     */
    #onRowPress(event) {
      const row = event.target.closest('[data-conversation-id]');
      if (event.button !== 0 || !row || event.target.closest('[data-action]')) return;
      const conversationId = row.dataset.conversationId;
      this.#paneManager.beginDragToOpenPane(event, conversationId, this.#directory.titleOf(conversationId));
    }

    /**
     * Runs the clicked row button's action, or opens the clicked conversation in the focused pane.
     * @param {MouseEvent} event Click in the table body.
     * @returns {void}
     */
    #onRowClick(event) {
      const row = event.target.closest('[data-conversation-id]');
      if (!row) return;
      const button = event.target.closest('[data-action]');
      if (button) this.#rowActionHandlers.get(button.dataset.action)(row);
      else this.#router.openConversation(row.dataset.conversationId);
    }

    /**
     * Asks for confirmation, then deletes a conversation. The row is dimmed while deleting and
     * restored if deleting fails.
     * @param {HTMLElement} row The conversation's row.
     * @returns {Promise<void>} Resolves once deleted, declined or failed.
     */
    async #confirmAndDelete(row) {
      const conversationId = row.dataset.conversationId;
      const isConfirmed = await ConfirmDialog.ask(`Delete "${this.#directory.titleOf(conversationId)}"? This cannot be undone.`, 'Delete');
      if (!isConfirmed) return;
      row.classList.add('claude-plus-pending');
      try {
        await this.#directory.deleteConversation(conversationId);
      } catch (error) {
        console.warn(LOG_PREFIX, 'delete failed', error);
        row.classList.remove('claude-plus-pending');
      }
    }
  }

  /**
   * Finds chats, files, web sources and tool uses matching a SearchQuery. Qualifiers naming a kind
   * (file, source, outlet, tool) restrict the results to those kinds; chat, before and after apply to
   * every kind; free terms must match the item's text or its conversation title.
   */
  class SearchEngine {
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
      const chats = conversations.map(conversation => SearchEngine.#item('chat', ConversationListingFields.title(conversation) || UNTITLED, null, { conversationId: ConversationListingFields.id(conversation), conversationTitle: ConversationListingFields.title(conversation) || UNTITLED, timestamp: ConversationListingFields.updatedAt(conversation), isImported: ConversationListingFields.isImported(conversation) }));
      const files = aggregate.folders.flatMap(folder => folder.files).map(file => SearchEngine.#item('file', file.title || file.path, null, file));
      const sources = aggregate.sources.map(source => SearchEngine.#item('source', source.title, `${source.outlet || ''} ${source.url}`, source));
      const tools = [...aggregate.perConversation].flatMap(([conversationId, summary]) => summary.toolCalls.map(call => SearchEngine.#item('tool', call.name, null, { conversationId, conversationTitle: summary.title, timestamp: call.timestamp, isImported: summary.isImported, messageId: call.messageId })));
      return [...chats, ...files, ...sources, ...tools];
    }

    /**
     * Creates a search item.
     * @param {string} kind Item kind.
     * @param {string} text The item's own text.
     * @param {?string} detail Secondary text.
     * @param {{conversationId: string, conversationTitle: string, timestamp: ?string, isImported: ?boolean, messageId: ?string}} origin Conversation, time and message of the item.
     * @returns {SearchItem} The item.
     */
    static #item(kind, text, detail, origin) {
      return { kind, text, detail, conversationId: origin.conversationId, conversationTitle: origin.conversationTitle, timestamp: origin.timestamp, isImported: Boolean(origin.isImported), messageId: origin.messageId ?? null };
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

  /**
   * A parsed search query: free terms plus qualifiers such as `file:*.pdf` or `outlet:"new york times"`.
   * Qualifier values and terms may contain `*` wildcards; `before:` and `after:` take YYYY-MM-DD dates.
   */
  class SearchQuery {
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

  var stylesheet$6 = ".claude-plus-search-result {\r\n  cursor: pointer;\r\n}\r\n\r\n.claude-plus-search-result:hover > td {\r\n  background: var(--claude-plus-color-hover);\r\n}\r\n";

  StyleRegistry.register(stylesheet$6);

  /**
   * Structured search over chats, files, web sources and tool uses, e.g. `file:*.pdf`,
   * `outlet:*nbc*`, `tool:web_search`, `chat:budget`, `after:2026-01-01`. Results show what matched,
   * where, when and why; clicking one opens its conversation in the active chat.
   */
  class SearchPanel extends Panel {
    /**
     * Conversation statistics.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Shared conversation list.
     * @type {CombinedConversationDirectory}
     */
    #directory;

    /**
     * Navigation.
     * @type {Router}
     */
    #router;

    /**
     * Table settings storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * The current query.
     * @type {SearchQuery}
     */
    #query = SearchQuery.parse('');

    /**
     * The results table; created with the DOM.
     * @type {?ColumnTable}
     */
    #table = null;

    /**
     * Creates the panel.
     * @param {object} services Panel dependencies.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {CombinedConversationDirectory} services.directory Shared conversation list.
     * @param {Router} services.router Navigation.
     * @param {Preferences} services.preferences Table settings storage.
     */
    constructor({ stats, directory, router, preferences }) {
      super('Search');
      this.#stats = stats;
      this.#directory = directory;
      this.#router = router;
      this.#preferences = preferences;
    }

    /**
     * HTML of the panel body.
     * @returns {string} Query input, syntax hint and results host.
     */
    createBodyHtml() {
      return `
      <input class="claude-plus-search-input" data-name="queryInput" type="text" placeholder="Search… e.g. file:*.pdf outlet:*nbc*" />
      <div class="claude-plus-hint">Qualifiers: chat: file: source: outlet: tool: after:YYYY-MM-DD before:YYYY-MM-DD — * is a wildcard, quote values with spaces.</div>
      <div class="claude-plus-table-host" data-name="tableHost"></div>`;
    }

    /**
     * Creates the results table, wires the query and result clicks, and follows data changes.
     * @returns {void}
     */
    bindEvents() {
      this.#table = new ColumnTable({
        container: this.elements.tableHost,
        tableId: 'searchResults',
        columns: SearchPanel.#columns(),
        preferences: this.#preferences,
        defaultSort: { column: 'date', direction: -1 },
        rowAttributes: item => `class="claude-plus-search-result" data-conversation-id="${escapeHtml(item.conversationId)}" data-message-id="${escapeHtml(item.messageId ?? '')}"`,
        emptyText: 'No results.',
      });
      this.elements.queryInput.addEventListener('input', () => this.#runQuery(this.elements.queryInput.value));
      this.#table.bodyElement.addEventListener('click', event => this.#onResultClick(event));
      this.listenTo(this.#stats, 'aggregate', () => this.render());
      this.listenTo(this.#directory, 'conversations', () => this.render());
    }

    /**
     * Shows the results of the current query; none for an empty query.
     * @returns {void}
     */
    render() {
      this.#table.setRows(this.#query.isEmpty ? [] : SearchEngine.find(this.#query, this.#stats.aggregate, this.#directory.conversations));
    }

    /**
     * Moves keyboard focus to the query field and selects its text.
     * @returns {void}
     */
    focusQuery() {
      const input = this.element.querySelector('[data-name="queryInput"]');
      input.focus();
      input.select();
    }

    /**
     * Closes the table's typeahead and ends the subscriptions.
     * @returns {void}
     */
    dispose() {
      if (this.#table) this.#table.dispose();
      super.dispose();
    }

    /**
     * Columns of the results table.
     * @returns {TableColumn[]} Match, kind, chat, date and reason.
     */
    static #columns() {
      return [
        { id: 'match', label: 'Match', isAlwaysVisible: true, sortValue: item => item.text.toLowerCase(), cellHtml: item => escapeHtml(item.text) },
        { id: 'kind', label: 'Kind', isVisibleByDefault: true, filter: 'values', sortValue: item => SearchEngine.kindLabel(item.kind), cellHtml: item => escapeHtml(SearchEngine.kindLabel(item.kind)) },
        { id: 'origin', label: 'Origin', isVisibleByDefault: true, filter: 'values', sortValue: item => SearchPanel.#originLabel(item), filterValue: item => SearchPanel.#originLabel(item), cellHtml: item => escapeHtml(SearchPanel.#originLabel(item)) },
        { id: 'conversation', label: 'Chat', isVisibleByDefault: true, filter: 'values', sortValue: item => item.conversationTitle.toLowerCase(), filterValue: item => item.conversationTitle, cellHtml: item => escapeHtml(item.conversationTitle) },
        { id: 'date', label: 'Date', isVisibleByDefault: true, filter: 'date', sortValue: item => toEpochMs(item.timestamp), filterValue: item => item.timestamp, cellHtml: item => escapeHtml(formatTimestamp(item.timestamp)) },
        { id: 'reason', label: 'Why', isVisibleByDefault: true, sortValue: item => item.reason, cellHtml: item => escapeHtml(item.reason) },
      ];
    }

    /**
     * A search item's origin label, for the Origin column.
     * @param {SearchItem} item The item.
     * @returns {'Live'|'Imported'} The label.
     */
    static #originLabel(item) {
      return item.isImported ? 'Imported' : 'Live';
    }

    /**
     * Parses new query text and shows its results.
     * @param {string} text Query text.
     * @returns {void}
     */
    #runQuery(text) {
      this.#query = SearchQuery.parse(text);
      this.render();
    }

    /**
     * Opens the clicked result's conversation in the active chat, then scrolls to and highlights the
     * matched message, if the result is tied to one.
     * @param {MouseEvent} event Click in the results body.
     * @returns {Promise<void>} Resolves once opened and, when applicable, scrolled to.
     */
    async #onResultClick(event) {
      const row = event.target.closest('[data-conversation-id]');
      if (!row) return;
      await this.#router.openConversation(row.dataset.conversationId);
      this.#router.revealFocusedChat();
      if (row.dataset.messageId) this.#router.scrollToMessage(row.dataset.messageId);
    }
  }

  /**
   * The actions of the app's own hotkey commands (see HOTKEY_COMMANDS).
   */
  class HotkeyActions {
    /**
     * Workspace used to find and reveal panels.
     * @type {DockWorkspace}
     */
    #workspace;

    /**
     * Creates panels that are not docked yet.
     * @type {PanelFactory}
     */
    #panelFactory;

    /**
     * Chat panes, for the active chat.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Creates the actions.
     * @param {object} services What the actions work with.
     * @param {DockWorkspace} services.workspace Workspace used to find and reveal panels.
     * @param {PanelFactory} services.panelFactory Creates panels that are not docked yet.
     * @param {ChatPaneManager} services.paneManager Chat panes, for the active chat.
     */
    constructor({ workspace, panelFactory, paneManager }) {
      this.#workspace = workspace;
      this.#panelFactory = panelFactory;
      this.#paneManager = paneManager;
    }

    /**
     * The actions by command id.
     * @returns {Map<string, function(): void>} The actions.
     */
    toMap() {
      return new Map([
        ['findInChat', () => this.#paneManager.focusedPanel.toggleFind()],
        ['globalSearch', () => this.#openGlobalSearch()],
        ['focusChatList', () => this.#focusChatListSearch()],
      ]);
    }

    /**
     * Shows the first docked conversation list and focuses its search box; does nothing when none is docked.
     * @returns {void}
     */
    #focusChatListSearch() {
      const docked = this.#workspace.findDockedPanel(panel => panel instanceof ConversationListPanel);
      if (docked && this.#workspace.revealPanel(docked.panelId)) docked.panel.focusSearch();
    }

    /**
     * Shows the first docked search panel and focuses its query field, adding a search panel next to
     * the active chat when none is docked.
     * @returns {void}
     */
    #openGlobalSearch() {
      const docked = this.#workspace.findDockedPanel(panel => panel instanceof SearchPanel);
      if (docked) {
        this.#workspace.revealPanel(docked.panelId);
        docked.panel.focusQuery();
        return;
      }
      const { panelId, panel } = this.#panelFactory.createInstance('search');
      this.#workspace.addPanel(panelId, panel, this.#paneManager.focusedPaneId);
      panel.focusQuery();
    }
  }

  /**
   * Key combinations as text, "Mod+Alt+Shift+Key": Mod stands for Ctrl, or Cmd on a Mac, so one
   * chord means the same on every platform.
   */
  class HotkeyChord {
    /**
     * Keys that are only modifiers and so never end a chord.
     * @type {ReadonlySet<string>}
     */
    static #MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);

    /**
     * The chord a key press makes.
     * @param {KeyboardEvent} event The key press.
     * @returns {?string} The chord, or null while only modifiers are held.
     */
    static fromEvent(event) {
      if (HotkeyChord.#MODIFIER_KEYS.has(event.key)) return null;
      const held = [['Mod', event.ctrlKey || event.metaKey], ['Alt', event.altKey], ['Shift', event.shiftKey]];
      return [...held.filter(([, isHeld]) => isHeld).map(([name]) => name), HotkeyChord.#keyName(event)].join('+');
    }

    /**
     * A chord as the user reads it.
     * @param {string} chord The chord; empty for none.
     * @returns {string} Its text, with Mod as Ctrl or Cmd; "Not set" for none.
     */
    static format(chord) {
      if (!chord) return 'Not set';
      return chord.replace('Mod', /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl');
    }

    /**
     * The name of the key of a key press, taken from its position for letters and digits so the
     * chord does not change with the keyboard layout or Shift.
     * @param {KeyboardEvent} event The key press.
     * @returns {string} The name.
     */
    static #keyName(event) {
      const positional = /^(?:Key|Digit)(.)$/.exec(event.code);
      if (positional) return positional[1];
      if (event.key === ' ') return 'Space';
      return event.key.length === 1 ? event.key.toUpperCase() : event.key;
    }
  }

  /**
   * The hotkey bindings: every command of every group (the app's own and each vendor's) with its
   * default chord, and the user's overrides, which are stored. An override can be an empty chord,
   * meaning the command has none.
   * @fires Hotkeys#changed A binding changed.
   */
  class Hotkeys extends EventEmitter {
    /**
     * Storage of the overrides.
     * @type {Preferences}
     */
    #preferences;

    /**
     * The command groups.
     * @type {HotkeyGroup[]}
     */
    #groups;

    /**
     * The user's chord per command id; an empty string means unassigned.
     * @type {Object<string, string>}
     */
    #overrides;

    /**
     * Whether a settings control is recording the next key press, so no command must run for it.
     * @type {boolean}
     */
    #isRecording = false;

    /**
     * Creates the bindings.
     * @param {Preferences} preferences Storage of the overrides.
     * @param {HotkeyGroup[]} groups The command groups.
     */
    constructor(preferences, groups) {
      super();
      this.#preferences = preferences;
      this.#groups = groups;
      this.#overrides = preferences.readJson(STORAGE_KEYS.hotkeys) ?? {};
    }

    /**
     * The command groups, in settings order.
     * @returns {HotkeyGroup[]} The groups.
     */
    get groups() {
      return this.#groups;
    }

    /**
     * Whether a settings control is recording the next key press.
     * @returns {boolean} True while recording.
     */
    get isRecording() {
      return this.#isRecording;
    }

    /**
     * Starts or ends recording, during which no command runs.
     * @param {boolean} isRecording Whether a control is recording.
     * @returns {void}
     */
    setRecording(isRecording) {
      this.#isRecording = isRecording;
    }

    /**
     * A command's current chord.
     * @param {string} commandId Command id.
     * @returns {string} The override if there is one, else the default; empty for none.
     */
    chordOf(commandId) {
      return commandId in this.#overrides ? this.#overrides[commandId] : (this.#find(commandId)?.defaultChord ?? '');
    }

    /**
     * Whether a command's chord differs from its default.
     * @param {string} commandId Command id.
     * @returns {boolean} True when the user changed it.
     */
    isCustomized(commandId) {
      return commandId in this.#overrides;
    }

    /**
     * The command a key press triggers.
     * @param {KeyboardEvent} event The key press.
     * @returns {?string} The command id, or null when no command has that chord.
     */
    commandIdFor(event) {
      const chord = HotkeyChord.fromEvent(event);
      return chord ? (this.#commands().find(command => this.chordOf(command.id) === chord)?.id ?? null) : null;
    }

    /**
     * Binds a chord to a command, unless another command already has it.
     * @param {string} commandId Command id.
     * @param {string} chord The chord; empty to leave the command without one.
     * @returns {?{id: string, label: string}} The command that already has the chord, when the change was refused.
     */
    setChord(commandId, chord) {
      const conflict = chord ? this.#conflictOf(commandId, chord) : null;
      if (conflict) return conflict;
      this.#store({ ...this.#overrides, [commandId]: chord });
      return null;
    }

    /**
     * Returns a command to its default chord.
     * @param {string} commandId Command id.
     * @returns {?{id: string, label: string}} The command that already has the default chord, when the reset was refused.
     */
    reset(commandId) {
      const defaultChord = this.#find(commandId)?.defaultChord ?? '';
      const conflict = defaultChord ? this.#conflictOf(commandId, defaultChord) : null;
      if (conflict) return conflict;
      const remaining = { ...this.#overrides };
      delete remaining[commandId];
      this.#store(remaining);
      return null;
    }

    /**
     * Another command that has a chord.
     * @param {string} commandId The command that wants the chord.
     * @param {string} chord The chord.
     * @returns {?{id: string, label: string}} The other command, or undefined when the chord is free.
     */
    #conflictOf(commandId, chord) {
      return this.#commands().find(command => command.id !== commandId && this.chordOf(command.id) === chord);
    }

    /**
     * Every command of every group.
     * @returns {Array<{id: string, label: string, defaultChord: string}>} The commands.
     */
    #commands() {
      return this.#groups.flatMap(group => [...group.commands]);
    }

    /**
     * A command by id.
     * @param {string} commandId Command id.
     * @returns {?{id: string, label: string, defaultChord: string}} The command, or undefined when none has that id.
     */
    #find(commandId) {
      return this.#commands().find(command => command.id === commandId);
    }

    /**
     * Keeps new overrides and announces the change.
     * @param {Object<string, string>} overrides The overrides.
     * @returns {void}
     */
    #store(overrides) {
      this.#overrides = overrides;
      this.#preferences.writeJson(STORAGE_KEYS.hotkeys, overrides);
      this.publish('changed');
    }
  }

  /**
   * Maps a raw conversation from claude.ai's data export into the same shape ClaudeApi's live
   * responses already produce, so the existing rendering pipeline (ChatSession, ConversationTree,
   * ChatMessage, MessageContent) renders an imported conversation unmodified.
   */
  class ClaudeExportMapper {
    /**
     * Maps one exported conversation.
     * @param {object} rawConversation A conversations.json entry.
     * @param {Map<string, {html: string}>} artifactsById Imported Artifact content, by artifact id;
     * empty when the frames file wasn't provided.
     * @returns {{conversationId: string, title: string, updatedAt: string, messages: ApiMessage[], hasReadableContent: boolean}}
     * The mapped conversation. hasReadableContent is false for a conversation with no messages, or
     * where not one message has any plain text to show (e.g. a deleted or never-really-started chat
     * an export still lists) - real, importable data, just nothing a picker UI should bother a human
     * with by default.
     */
    static mapConversation(rawConversation, artifactsById) {
      const messages = rawConversation.chat_messages.map(rawMessage => ClaudeExportMapper.#mapMessage(rawMessage, artifactsById));
      return {
        conversationId: rawConversation.uuid,
        title: rawConversation.name,
        updatedAt: rawConversation.updated_at,
        messages,
        hasReadableContent: messages.some(message => MessageContent.plainText(message).trim().length > 0),
      };
    }

    /**
     * Maps one exported message.
     * @param {object} rawMessage A chat_messages entry.
     * @param {Map<string, {html: string}>} artifactsById Imported Artifact content, by artifact id.
     * @returns {ApiMessage} The mapped message.
     */
    static #mapMessage(rawMessage, artifactsById) {
      return {
        uuid: rawMessage.uuid,
        parent_message_uuid: rawMessage.parent_message_uuid,
        sender: rawMessage.sender,
        text: rawMessage.text,
        created_at: rawMessage.created_at,
        content: (rawMessage.content ?? []).map(block => ClaudeExportMapper.#mapContentBlock(block, artifactsById)),
        attachments: ClaudeExportMapper.#mapUploads(rawMessage),
        files: [],
      };
    }

    /**
     * Maps one content block, resolving an Artifact tool_result's real HTML when available. Every
     * other block type (including injected_prompt_block, already excluded from the chat log by the
     * existing renderer) passes through unchanged.
     * @param {object} block A raw content block.
     * @param {Map<string, {html: string}>} artifactsById Imported Artifact content, by artifact id.
     * @returns {ContentBlock} The mapped block.
     */
    static #mapContentBlock(block, artifactsById) {
      const artifactId = block.structured_content?.artifact_id;
      const artifact = artifactId ? artifactsById.get(artifactId) : null;
      return artifact ? { ...block, structured_content: { ...block.structured_content, resolvedArtifactHtml: artifact.html } } : block;
    }

    /**
     * A message's uploads as one array: its attachments as-is (already carrying full content for
     * text-based files), plus any files[] entry with no matching attachments[] entry by filename -
     * the binary case, which renders as a filename-only placeholder through the existing renderer.
     * @param {object} rawMessage A chat_messages entry.
     * @returns {object[]} The combined uploads.
     */
    static #mapUploads(rawMessage) {
      const attachments = rawMessage.attachments ?? [];
      const attachedNames = new Set(attachments.map(attachment => attachment.file_name));
      const unmatchedFiles = (rawMessage.files ?? []).filter(file => !attachedNames.has(file.file_name));
      return [...attachments, ...unmatchedFiles];
    }
  }

  /**
   * Extracts the app's own record shapes from claude.ai's data-export JSON, for every category
   * besides conversations (already the right shape - see ClaudeExportMapper). Each method takes
   * already-parsed JSON, since how the file itself is selected and read is a UI concern.
   */
  class ClaudeExportParser {
    /**
     * Memory files from one account's memories export.
     * @param {{account_uuid: string, memory_files: Array<{path: string, content: string, updated_at: string}>}} memoriesJson Parsed memories-000 content.
     * @returns {ImportedMemoryFileRecord[]} The memory files.
     */
    static memoryFiles(memoriesJson) {
      return memoriesJson.memory_files.map(file => ({
        accountId: memoriesJson.account_uuid,
        path: file.path,
        content: file.content,
        updatedAt: file.updated_at,
      }));
    }

    /**
     * One Artifact's content from its frames-000 folder.
     * @param {{id: string, versions: Array<{id: string, title: string}>, active_version: string}} artifactJson Parsed artifact.json content.
     * @param {Map<string, string>} htmlByVersionId Each version's HTML, by version id.
     * @returns {ImportedArtifactRecord} The Artifact record.
     */
    static artifact(artifactJson, htmlByVersionId) {
      return {
        artifactId: artifactJson.id,
        title: artifactJson.versions.find(version => version.id === artifactJson.active_version)?.title ?? '',
        activeVersionId: artifactJson.active_version,
        html: htmlByVersionId.get(artifactJson.active_version) ?? '',
        knownVersionIds: artifactJson.versions.map(version => version.id),
      };
    }

    /**
     * One Project's content from its projects-000 file.
     * @param {object} projectJson Parsed projects-000/projects/<id>.json content.
     * @returns {ImportedProjectRecord} The Project record.
     */
    static project(projectJson) {
      return {
        projectId: projectJson.uuid,
        name: projectJson.name,
        description: projectJson.description,
        promptTemplate: projectJson.prompt_template,
        updatedAt: projectJson.updated_at,
        docs: projectJson.docs.map(doc => ({ docId: doc.uuid, filename: doc.filename, content: doc.content, createdAt: doc.created_at })),
      };
    }

    /**
     * Feedback/reflection periods from one account's feedback export.
     * @param {{account_uuid: string, reflections: Array<{period: string, content: object}>}} feedbackJson Parsed feedback-000 content.
     * @returns {ImportedFeedbackPeriodRecord[]} The periods.
     */
    static feedbackPeriods(feedbackJson) {
      return feedbackJson.reflections.map(reflection => ({
        accountId: feedbackJson.account_uuid,
        period: reflection.period,
        content: reflection.content,
      }));
    }

    /**
     * The account profile from a light_metadata export's users.json.
     * @param {Array<{uuid: string, full_name: string, email_address: string}>} usersJson Parsed users.json content.
     * @returns {ImportedAccountProfileRecord} The profile.
     */
    static accountProfile(usersJson) {
      const user = usersJson[0];
      return { accountId: user.uuid, fullName: user.full_name, emailAddress: user.email_address };
    }

    /**
     * Login events from a light_metadata export's login_history.json.
     * @param {{login_events: Array<object>}} loginHistoryJson Parsed login_history.json content.
     * @returns {ImportedLoginEventRecord[]} The events.
     */
    static loginEvents(loginHistoryJson) {
      return loginHistoryJson.login_events.map(event => ({
        accountId: event.account_uuid,
        timestamp: event.timestamp,
        ipAddress: event.ip_address,
        userAgent: event.user_agent,
        method: event.method,
        locationInfo: event.location_info,
      }));
    }
  }

  /**
   * Sorts the files a user selected from an extracted data export into their categories, by content
   * shape rather than filename - conversations.json is the only export file with a predictable name;
   * memories/projects/feedback files are named by uuid, and an Artifact's html is named by version id.
   * Classification reads only a small prefix of each file, never the whole thing: conversations.json
   * in a real export can run to hundreds of megabytes, and is kept as a File reference rather than
   * parsed here, so it can be streamed later (see StreamingJsonArrayReader) instead of ever being
   * held whole in memory.
   */
  class ImportFileClassifier {
    /**
     * Bytes read from each file to detect its category.
     * @type {number}
     */
    static #PEEK_BYTES = 16384;

    /**
     * Category detectors tried in turn against a file's leading text; the first match wins. A
     * detector may also require the file to start with an array (`[`), to tell apart, e.g., a
     * conversations export (an array of objects with chat_messages) from something else that
     * happens to mention the same field name.
     * @type {ReadonlyArray<{key: string, requiresArray: boolean, marker: string}>}
     */
    static #DETECTORS = [
      { key: 'conversations', requiresArray: true, marker: '"chat_messages"' },
      { key: 'users', requiresArray: true, marker: '"full_name"' },
      { key: 'memories', requiresArray: false, marker: '"memory_files"' },
      { key: 'feedback', requiresArray: false, marker: '"reflections"' },
      { key: 'loginHistory', requiresArray: false, marker: '"login_events"' },
      { key: 'artifact', requiresArray: false, marker: '"active_version"' },
      { key: 'project', requiresArray: false, marker: '"prompt_template"' },
    ];

    /**
     * Classifies a set of selected files.
     * @param {File[]} files The selected files.
     * @returns {Promise<{conversationsFile: ?File, memoriesJsons: object[], projectsJsons: object[], feedbackJsons: object[], usersJson: ?Array, loginHistoryJson: ?object, artifacts: Array<{artifactJson: object, htmlByVersionId: Map<string, string>}>}>}
     * The classified files, ready for ClaudeExportParser/ClaudeExportMapper/StreamingJsonArrayReader.
     */
    static async classify(files) {
      const htmlByBasename = await ImportFileClassifier.#htmlFilesByBasename(files);
      const buckets = { conversationsFile: null, memoriesJsons: [], projectsJsons: [], feedbackJsons: [], usersJson: null, loginHistoryJson: null, artifactJsons: [] };
      const jsonFiles = files.filter(file => !file.name.endsWith('.html'));
      await Promise.all(jsonFiles.map(file => ImportFileClassifier.#classifyOne(file, buckets)));
      return { ...buckets, artifacts: buckets.artifactJsons.map(artifactJson => ({ artifactJson, htmlByVersionId: htmlByBasename })) };
    }

    /**
     * Every selected .html file's text, by its basename without extension (an Artifact version id).
     * @param {File[]} files The selected files.
     * @returns {Promise<Map<string, string>>} The html, by version id.
     */
    static async #htmlFilesByBasename(files) {
      const htmlFiles = files.filter(file => file.name.endsWith('.html'));
      const entries = await Promise.all(htmlFiles.map(async file => [ImportFileClassifier.#basename(file.name), await file.text()]));
      return new Map(entries);
    }

    /**
     * A filename without its extension.
     * @param {string} filename The filename.
     * @returns {string} The basename.
     */
    static #basename(filename) {
      return filename.replace(/\.[^.]+$/, '');
    }

    /**
     * Detects one file's category from its leading bytes, then files it into the matching bucket - a
     * File reference for conversations.json, the fully parsed content for every other, small category.
     * A file whose category can't be detected is silently ignored.
     * @param {File} file The file.
     * @param {object} buckets Buckets accumulated so far.
     * @returns {Promise<void>} Resolves once classified.
     */
    static async #classifyOne(file, buckets) {
      const prefix = await file.slice(0, ImportFileClassifier.#PEEK_BYTES).text();
      const key = ImportFileClassifier.#detect(prefix);
      if (!key) return;
      if (key === 'conversations') { buckets.conversationsFile = file; return; }
      const json = await ImportFileClassifier.#parseOrNull(file);
      if (json !== null) ImportFileClassifier.#BUCKET_ASSIGNERS[key](buckets, json);
    }

    /**
     * Category a file's leading text matches, if any.
     * @param {string} prefix The file's leading text.
     * @returns {?string} The detector key, or null when none matches.
     */
    static #detect(prefix) {
      const startsWithArray = prefix.trimStart().startsWith('[');
      const detector = ImportFileClassifier.#DETECTORS.find(candidate => candidate.requiresArray === startsWithArray && prefix.includes(candidate.marker));
      return detector?.key ?? null;
    }

    /**
     * Files a parsed, non-conversations category into its bucket, by detector key.
     * @type {Readonly<Record<string, function(object, *): void>>}
     */
    static #BUCKET_ASSIGNERS = Object.freeze({
      users: (buckets, json) => { buckets.usersJson = json; },
      memories: (buckets, json) => buckets.memoriesJsons.push(json),
      feedback: (buckets, json) => buckets.feedbackJsons.push(json),
      loginHistory: (buckets, json) => { buckets.loginHistoryJson = json; },
      artifact: (buckets, json) => buckets.artifactJsons.push(json),
      project: (buckets, json) => buckets.projectsJsons.push(json),
    });

    /**
     * A file's content, parsed as JSON.
     * @param {File} file The file.
     * @returns {Promise<*>} The parsed content, or null when it isn't valid JSON.
     */
    static async #parseOrNull(file) {
      try {
        return JSON.parse(await file.text());
      } catch {
        return null;
      }
    }
  }

  /**
   * Merges a newly parsed data export into what's already stored, per category, so re-running an
   * import never discards anything and never duplicates anything unchanged. Every rule follows the
   * same idea: a later export is more information about something already known, not a replacement
   * for it.
   */
  class ImportMerger {
    /**
     * How a newly mapped conversation compares to what's already stored.
     * @param {?ImportedConversationRecord} storedRecord The stored record, or null when not seen before.
     * @param {{conversationId: string, title: string, messages: ApiMessage[]}} mapped The newly mapped conversation.
     * @returns {'new'|'changed'|'renamedOnly'|'unchanged'} The classification.
     */
    static classifyConversation(storedRecord, mapped) {
      if (!storedRecord) return 'new';
      if (ImportMerger.#hasNewMessages(storedRecord, mapped)) return 'changed';
      return storedRecord.title === mapped.title ? 'unchanged' : 'renamedOnly';
    }

    /**
     * Merges a newly mapped conversation into what's already stored.
     * @param {?ImportedConversationRecord} storedRecord The stored record, or null when not seen before.
     * @param {{conversationId: string, title: string, updatedAt: string, messages: ApiMessage[]}} mapped The newly mapped conversation.
     * @param {string} importedAt ISO timestamp of this import.
     * @returns {?ImportedConversationRecord} The record to write, or null when nothing changed.
     */
    static mergeConversation(storedRecord, mapped, importedAt) {
      const classification = ImportMerger.classifyConversation(storedRecord, mapped);
      if (classification === 'unchanged') return null;
      if (classification === 'renamedOnly') return { ...storedRecord, title: mapped.title, updatedAt: mapped.updatedAt, lastImportedAt: importedAt };
      const messages = classification === 'new' ? mapped.messages : ImportMerger.#addedMessages(storedRecord, mapped);
      return { conversationId: mapped.conversationId, title: mapped.title, updatedAt: mapped.updatedAt, messages, currentLeafId: ImportMerger.defaultLeafOf(messages), lastImportedAt: importedAt };
    }

    /**
     * Whether a mapped conversation has any message not already stored.
     * @param {ImportedConversationRecord} storedRecord The stored record.
     * @param {{messages: ApiMessage[]}} mapped The newly mapped conversation.
     * @returns {boolean} True when at least one message is new.
     */
    static #hasNewMessages(storedRecord, mapped) {
      const knownIds = new Set(storedRecord.messages.map(message => message.uuid));
      return mapped.messages.some(message => !knownIds.has(message.uuid));
    }

    /**
     * The stored messages plus every newly mapped message not already among them, each kept exactly
     * as mapped - a plain continuation and a branch are both just new messages whose parent already
     * resolves correctly, so nothing here needs to tell them apart.
     * @param {ImportedConversationRecord} storedRecord The stored record.
     * @param {{messages: ApiMessage[]}} mapped The newly mapped conversation.
     * @returns {ApiMessage[]} The combined messages.
     */
    static #addedMessages(storedRecord, mapped) {
      const knownIds = new Set(storedRecord.messages.map(message => message.uuid));
      return [...storedRecord.messages, ...mapped.messages.filter(message => !knownIds.has(message.uuid))];
    }

    /**
     * The leaf a freshly imported or merged conversation should show by default: among messages no
     * other message names as its parent, the one created most recently. A real export can contain a
     * conversation with no messages at all (deleted or never sent past creation); there's no leaf to
     * pick for one, so it gets none rather than treating that as an error.
     * @param {ApiMessage[]} messages The conversation's messages.
     * @returns {?string} The leaf message's id, or null when there are no messages.
     */
    static defaultLeafOf(messages) {
      if (messages.length === 0) return null;
      const parentIds = new Set(messages.map(message => message.parent_message_uuid));
      const leaves = messages.filter(message => !parentIds.has(message.uuid));
      return leaves.reduce((latest, message) => ((message.created_at ?? '') > (latest.created_at ?? '') ? message : latest)).uuid;
    }

    /**
     * Merges a newly parsed memory file into what's already stored: only overwritten when the new
     * version is actually newer.
     * @param {?ImportedMemoryFileRecord} storedRecord The stored record, or null when not seen before.
     * @param {ImportedMemoryFileRecord} parsed The newly parsed file.
     * @returns {?ImportedMemoryFileRecord} The record to write, or null when it isn't newer.
     */
    static mergeMemoryFile(storedRecord, parsed) {
      return !storedRecord || parsed.updatedAt > storedRecord.updatedAt ? parsed : null;
    }

    /**
     * Merges newly parsed Artifact content into what's already stored: written only when it brings a
     * version not already known.
     * @param {?ImportedArtifactRecord} storedRecord The stored record, or null when not seen before.
     * @param {ImportedArtifactRecord} parsed The newly parsed Artifact.
     * @returns {?ImportedArtifactRecord} The record to write, or null when nothing new arrived.
     */
    static mergeArtifact(storedRecord, parsed) {
      if (!storedRecord) return parsed;
      const knownVersionIds = new Set(storedRecord.knownVersionIds);
      if (knownVersionIds.has(parsed.activeVersionId)) return null;
      return { ...parsed, knownVersionIds: [...storedRecord.knownVersionIds, ...parsed.knownVersionIds.filter(id => !knownVersionIds.has(id))] };
    }

    /**
     * Merges a newly parsed Project into what's already stored: the project's own fields update when
     * newer, and each doc is merged independently by the same rule.
     * @param {?ImportedProjectRecord} storedRecord The stored record, or null when not seen before.
     * @param {ImportedProjectRecord} parsed The newly parsed Project.
     * @returns {ImportedProjectRecord} The record to write; unchanged fields are kept as they were.
     */
    static mergeProject(storedRecord, parsed) {
      if (!storedRecord) return parsed;
      const fields = parsed.updatedAt > storedRecord.updatedAt ? parsed : storedRecord;
      return { projectId: parsed.projectId, name: fields.name, description: fields.description, promptTemplate: fields.promptTemplate, updatedAt: fields.updatedAt, docs: ImportMerger.#mergedDocs(storedRecord.docs, parsed.docs) };
    }

    /**
     * Merges a Project's docs by id: a doc is only replaced when it comes back with a newer createdAt.
     * @param {ImportedProjectDoc[]} storedDocs Already-stored docs.
     * @param {ImportedProjectDoc[]} parsedDocs Newly parsed docs.
     * @returns {ImportedProjectDoc[]} The merged docs.
     */
    static #mergedDocs(storedDocs, parsedDocs) {
      const parsedById = new Map(parsedDocs.map(doc => [doc.docId, doc]));
      const merged = storedDocs.map(stored => {
        const parsed = parsedById.get(stored.docId);
        return parsed && parsed.createdAt > stored.createdAt ? parsed : stored;
      });
      const knownIds = new Set(storedDocs.map(doc => doc.docId));
      return [...merged, ...parsedDocs.filter(doc => !knownIds.has(doc.docId))];
    }

    /**
     * Merges a newly parsed Feedback/reflection period into what's already stored: a period already
     * seen is treated as a fixed historical record and left alone.
     * @param {?ImportedFeedbackPeriodRecord} storedRecord The stored record, or null when not seen before.
     * @param {ImportedFeedbackPeriodRecord} parsed The newly parsed period.
     * @returns {?ImportedFeedbackPeriodRecord} The record to write, or null when already known.
     */
    static mergeFeedbackPeriod(storedRecord, parsed) {
      return storedRecord ? null : parsed;
    }

    /**
     * Merges a newly parsed account profile into what's already stored: always the latest snapshot.
     * @param {ImportedAccountProfileRecord} parsed The newly parsed profile.
     * @returns {ImportedAccountProfileRecord} The record to write.
     */
    static mergeAccountProfile(parsed) {
      return parsed;
    }

    /**
     * Merges a newly parsed login event into what's already stored: a duplicate (same account,
     * timestamp and IP) is left alone.
     * @param {?ImportedLoginEventRecord} storedRecord The stored record, or null when not seen before.
     * @param {ImportedLoginEventRecord} parsed The newly parsed event.
     * @returns {?ImportedLoginEventRecord} The record to write, or null when already known.
     */
    static mergeLoginEvent(storedRecord, parsed) {
      return storedRecord ? null : parsed;
    }
  }

  /**
   * Persisted imported conversations, read as the app's own conversation shape so they load through
   * the same pipeline as a live fetch, and listed alongside live conversations in the directory.
   */
  class ImportedConversationStore {
    /**
     * Backing storage.
     * @type {IndexedDbStore}
     */
    #database;

    /**
     * Creates the store on top of the shared database.
     * @param {IndexedDbStore} database Backing storage.
     */
    constructor(database) {
      this.#database = database;
    }

    /**
     * An imported conversation, ready to render.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<?ApiConversation>} The conversation, or null when it isn't an imported one.
     */
    async get(conversationId) {
      const record = await this.getRecord(conversationId);
      return record ? ImportedConversationStore.toApiConversation(record) : null;
    }

    /**
     * A conversation's stored record, for merging a newly imported export against it.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<?ImportedConversationRecord>} The record, or undefined when not imported yet.
     */
    getRecord(conversationId) {
      return this.#database.read(DATABASE.stores.importedConversations, conversationId);
    }

    /**
     * Listings of every imported conversation, for merging into the directory.
     * @returns {Promise<ConversationListing[]>} The listings, each tagged isImported.
     */
    async listings() {
      const records = await this.#database.readAll(DATABASE.stores.importedConversations);
      return records.map(record => ({ uuid: record.conversationId, name: record.title, updated_at: record.updatedAt, isImported: true }));
    }

    /**
     * Stores a merged conversation record.
     * @param {ImportedConversationRecord} record The record.
     * @returns {Promise<void>} Resolves once written.
     */
    write(record) {
      return this.#database.write(DATABASE.stores.importedConversations, record);
    }

    /**
     * Removes an imported conversation from the local store.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once removed.
     */
    remove(conversationId) {
      return this.#database.remove(DATABASE.stores.importedConversations, conversationId);
    }

    /**
     * A stored record as the app's own conversation shape, for rendering or re-indexing.
     * @param {ImportedConversationRecord} record The record.
     * @returns {ApiConversation} The conversation.
     */
    static toApiConversation(record) {
      return { uuid: record.conversationId, name: record.title, updated_at: record.updatedAt, current_leaf_message_uuid: record.currentLeafId, chat_messages: record.messages };
    }
  }

  /**
   * Reads a file whose content is one large top-level JSON array of objects, one element at a time,
   * without ever holding the whole file's text or the whole array in memory - only the current
   * element's own text, bounded by that one element's size regardless of how large the file is.
   * Built for conversations.json, which real exports can grow to hundreds of megabytes: a plain
   * `JSON.parse(await file.text())` would materialize the whole file as text and then again as a
   * full object graph, and would block the main thread for as long as that takes.
   */
  class StreamingJsonArrayReader {
    /**
     * Characters that open a nesting level.
     * @type {ReadonlySet<string>}
     */
    static #OPENERS = new Set(['{', '[']);

    /**
     * Characters that close a nesting level.
     * @type {ReadonlySet<string>}
     */
    static #CLOSERS = new Set(['}', ']']);

    /**
     * Every element of the array, parsed, one at a time.
     * @param {File} file A file whose content is a JSON array of objects.
     * @returns {AsyncGenerator<*>} The elements, parsed, in file order.
     * @yields {*} Each array element, parsed.
     */
    static async *readArray(file) {
      for await (const text of StreamingJsonArrayReader.#readRawElements(file)) yield JSON.parse(text);
    }

    /**
     * The number of elements in the array, without parsing any of them.
     * @param {File} file A file whose content is a JSON array of objects.
     * @returns {Promise<number>} The count.
     */
    static async countArrayElements(file) {
      const elements = StreamingJsonArrayReader.#readRawElements(file);
      let count = 0;
      for (let step = await elements.next(); !step.done; step = await elements.next()) count += 1;
      return count;
    }

    /**
     * Every top-level element's raw, unparsed text, found by tracking brace/bracket depth and string
     * state character by character across chunk boundaries. The accumulated buffer is only ever
     * dropped when nothing is mid-element - while assembling one element's text, the buffer keeps
     * growing (bounded by that element's own size) rather than being rescanned from the start on
     * every new chunk, which would otherwise reprocess already-seen characters and miscount depth.
     * @param {File} file A file whose content is a JSON array of objects.
     * @returns {AsyncGenerator<string>} The elements' exact source text, in file order.
     * @yields {string} Each element's exact source text.
     */
    static async *#readRawElements(file) {
      const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
      try {
        yield* StreamingJsonArrayReader.#scanChunks(reader);
      } finally {
        reader.releaseLock();
      }
    }

    /**
     * Reads decoded text chunks from a stream reader and yields each completed top-level element as
     * it's found.
     * @param {ReadableStreamDefaultReader<string>} reader Reader of the decoded text stream.
     * @returns {AsyncGenerator<string>} The elements' exact source text, in file order.
     * @yields {string} Each element's exact source text.
     */
    static async *#scanChunks(reader) {
      const state = { depth: 0, inString: false, isEscaped: false, elementStart: -1 };
      let buffer = '';
      let scannedUpTo = 0;
      let step = await reader.read();
      while (!step.done) {
        buffer += step.value;
        const { elements, scannedUpTo: newScannedUpTo } = StreamingJsonArrayReader.#scan(buffer, scannedUpTo, state);
        yield* elements;
        ({ buffer, scannedUpTo } = StreamingJsonArrayReader.#afterScan(buffer, newScannedUpTo, state));
        step = await reader.read();
      }
    }

    /**
     * Drops the buffer once nothing is mid-element (there's nothing useful left in it but consumed
     * elements and separator noise), otherwise keeps it as-is so the next chunk can extend it.
     * @param {string} buffer The buffer as scanned so far.
     * @param {number} scannedUpTo How much of the buffer has been scanned.
     * @param {{elementStart: number}} state Scan state.
     * @returns {{buffer: string, scannedUpTo: number}} The buffer and scan position to continue from.
     */
    static #afterScan(buffer, scannedUpTo, state) {
      return state.elementStart === -1 ? { buffer: '', scannedUpTo: 0 } : { buffer, scannedUpTo };
    }

    /**
     * Scans a buffer from where the last call left off, updating the scan state in place.
     * @param {string} buffer Text accumulated so far.
     * @param {number} startIndex Index to resume scanning from; characters before it were already scanned.
     * @param {{depth: number, inString: boolean, isEscaped: boolean, elementStart: number}} state
     * Mutable scan state, carried across calls (and across chunk boundaries).
     * @returns {{elements: string[], scannedUpTo: number}} Completed elements found, in order, and
     * how much of the buffer has now been scanned.
     */
    static #scan(buffer, startIndex, state) {
      const elements = [];
      let index = startIndex;
      for (; index < buffer.length; index += 1) {
        if (StreamingJsonArrayReader.#step(buffer, index, state)) {
          elements.push(buffer.slice(state.elementStart, index + 1));
          state.elementStart = -1;
        }
      }
      return { elements, scannedUpTo: index };
    }

    /**
     * Advances the scan state by one character.
     * @param {string} buffer The buffer being scanned.
     * @param {number} index Index of the character to process.
     * @param {{depth: number, inString: boolean, isEscaped: boolean, elementStart: number}} state
     * Mutable scan state.
     * @returns {boolean} True when this character completed a top-level element.
     */
    static #step(buffer, index, state) {
      const char = buffer[index];
      if (state.inString) return StreamingJsonArrayReader.#stepInString(char, state);
      if (char === '"') { state.inString = true; return false; }
      if (StreamingJsonArrayReader.#OPENERS.has(char)) return StreamingJsonArrayReader.#open(index, state);
      return StreamingJsonArrayReader.#CLOSERS.has(char) && StreamingJsonArrayReader.#close(state);
    }

    /**
     * Advances the scan state by one character while inside a string.
     * @param {string} char The character.
     * @param {{inString: boolean, isEscaped: boolean}} state Mutable scan state.
     * @returns {boolean} Always false; a string can't itself complete a top-level element.
     */
    static #stepInString(char, state) {
      if (state.isEscaped) state.isEscaped = false;
      else if (char === '\\') state.isEscaped = true;
      else if (char === '"') state.inString = false;
      return false;
    }

    /**
     * Handles an opening brace or bracket: entering the array (depth 0 to 1) starts nothing; entering
     * an element (depth 1 to 2) marks where it begins.
     * @param {number} index Index of the opening character.
     * @param {{depth: number, elementStart: number}} state Mutable scan state.
     * @returns {boolean} Always false; an opening character can't complete an element.
     */
    static #open(index, state) {
      state.depth += 1;
      if (state.depth === 2) state.elementStart = index;
      return false;
    }

    /**
     * Handles a closing brace or bracket: leaving an element (depth 2 to 1) completes it.
     * @param {{depth: number, elementStart: number}} state Mutable scan state.
     * @returns {boolean} True when this closed a top-level element.
     */
    static #close(state) {
      state.depth -= 1;
      return state.depth === 1 && state.elementStart >= 0;
    }
  }

  /**
   * Runs an import in two passes over conversations.json, never holding more than one conversation's
   * full message body in memory at a time so a real export's file - hundreds of megabytes is normal -
   * never has to be read whole: previewClassified() streams through once to classify every
   * conversation and build the lightweight rows a picker UI shows, without writing anything; apply()
   * streams through again and writes only the conversations selected from that preview, plus every
   * other category.
   */
  class ImportOrchestrator {
    /**
     * Conversations processed between yields to the browser's event loop, so a large import never
     * blocks the tab long enough to look frozen.
     * @type {number}
     */
    static #YIELD_EVERY = 200;

    /**
     * Backing storage.
     * @type {IndexedDbStore}
     */
    #database;

    /**
     * Imported conversations, read/written as raw stored records here (see get() for the
     * ApiConversation-shaped read the rest of the app uses).
     * @type {ImportedConversationStore}
     */
    #conversationStore;

    /**
     * Conversation statistics, indexed for every written conversation as the last import step.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Creates the orchestrator.
     * @param {IndexedDbStore} database Backing storage.
     * @param {ImportedConversationStore} conversationStore Imported conversations.
     * @param {StatsIndex} stats Conversation statistics, indexed for every written conversation.
     */
    constructor(database, conversationStore, stats) {
      this.#database = database;
      this.#conversationStore = conversationStore;
      this.#stats = stats;
    }

    /**
     * Classifies the selected files without writing anything, ready for a picker UI: one row per
     * conversation, plus counts for every other category.
     * @param {File[]} files The files the user selected.
     * @param {function(number): void} [onConversationProgress] Called with the number of
     * conversations classified so far, periodically during the scan.
     * @returns {Promise<{classified: object, artifactRecords: object[], conversationRows: Array<{conversationId: string, title: string, updatedAt: string, promptCount: number, classification: string}>, failedCount: number, emptySkippedCount: number}>}
     * The raw classification (for apply()), the parsed Artifact records, the conversation rows, how
     * many conversations couldn't be read at all (logged, and left out of the rows - a single
     * unreadable conversation elsewhere in the file never stops the rest from being previewed), and
     * how many had no readable content and so were left out deliberately (see mapConversation's
     * hasReadableContent) - a deleted or never-really-started chat an export still lists, not an error.
     * @throws {Error} When no conversations.json was among the selected files.
     */
    async previewClassified(files, onConversationProgress) {
      const classified = await ImportFileClassifier.classify(files);
      if (!classified.conversationsFile) throw new Error('No conversations.json was among the selected files.');
      const artifactRecords = classified.artifacts.map(({ artifactJson, htmlByVersionId }) => ClaudeExportParser.artifact(artifactJson, htmlByVersionId));
      const artifactsById = new Map(artifactRecords.map(record => [record.artifactId, record]));
      const { rows, failedCount, emptySkippedCount } = await this.#previewConversations(classified.conversationsFile, artifactsById, onConversationProgress);
      return { classified, artifactRecords, conversationRows: rows, failedCount, emptySkippedCount };
    }

    /**
     * Writes the conversations selected from a preview, plus every other classified category.
     * @param {object} classified A previewClassified() result's classified files.
     * @param {object[]} artifactRecords A previewClassified() result's parsed Artifact records.
     * @param {Set<string>} selectedConversationIds Ids of the conversations to actually write.
     * @param {function(number): void} [onConversationProgress] Called with the number of
     * conversations processed so far, periodically during the scan.
     * @returns {Promise<object>} Per-category counts: conversations {new, changed, renamedOnly,
     * unchanged} (only among the selected ones), and written/total for memoryFiles, artifacts,
     * projects, feedbackPeriods and loginEvents; accountProfile is true when a profile was written.
     */
    async apply(classified, artifactRecords, selectedConversationIds, onConversationProgress) {
      const importedAt = new Date().toISOString();
      const artifactsById = new Map(artifactRecords.map(record => [record.artifactId, record]));
      return {
        conversations: await this.#applyConversations(classified.conversationsFile, artifactsById, selectedConversationIds, importedAt, onConversationProgress),
        memoryFiles: await this.#importEach(DATABASE.stores.importedMemoryFiles, classified.memoriesJsons.flatMap(ClaudeExportParser.memoryFiles), record => [record.accountId, record.path], ImportMerger.mergeMemoryFile),
        artifacts: await this.#writeArtifacts(artifactRecords),
        projects: await this.#importEach(DATABASE.stores.importedProjects, classified.projectsJsons.map(ClaudeExportParser.project), record => record.projectId, ImportMerger.mergeProject),
        feedbackPeriods: await this.#importEach(DATABASE.stores.importedFeedbackPeriods, classified.feedbackJsons.flatMap(ClaudeExportParser.feedbackPeriods), record => [record.accountId, record.period], ImportMerger.mergeFeedbackPeriod),
        accountProfile: await this.#importAccountProfile(classified.usersJson),
        loginEvents: await this.#importEach(DATABASE.stores.importedLoginEvents, classified.loginHistoryJson ? ClaudeExportParser.loginEvents(classified.loginHistoryJson) : [], record => [record.accountId, record.timestamp, record.ipAddress], ImportMerger.mergeLoginEvent),
      };
    }

    /**
     * Streams every conversation, classifying each against what's already stored, without writing.
     * @param {File} conversationsFile The conversations.json file.
     * @param {Map<string, {html: string}>} artifactsById Parsed Artifact content, by artifact id.
     * @param {function(number): void} [onProgress] Called with the number processed so far (found, empty or failed).
     * @returns {Promise<{rows: Array<{conversationId: string, title: string, updatedAt: string, promptCount: number, classification: string}>, failedCount: number, emptySkippedCount: number}>}
     * The rows, in file order, how many conversations failed to preview, and how many had no
     * readable content and were left out deliberately.
     */
    async #previewConversations(conversationsFile, artifactsById, onProgress) {
      const rows = [];
      let failedCount = 0;
      let emptySkippedCount = 0;
      let processed = 0;
      for await (const rawConversation of StreamingJsonArrayReader.readArray(conversationsFile)) {
        const result = await this.#previewOneConversation(rawConversation, artifactsById);
        if (result.outcome === 'included') rows.push(result.row);
        else if (result.outcome === 'failed') failedCount += 1;
        else emptySkippedCount += 1;
        processed += 1;
        await ImportOrchestrator.#reportProgressIfDue(processed, onProgress);
      }
      onProgress?.(processed);
      return { rows, failedCount, emptySkippedCount };
    }

    /**
     * Maps and classifies one conversation for preview, without writing anything.
     * @param {object} rawConversation A conversations.json entry.
     * @param {Map<string, {html: string}>} artifactsById Parsed Artifact content, by artifact id.
     * @returns {Promise<{outcome: 'included', row: {conversationId: string, title: string, updatedAt: string, promptCount: number, classification: string}}|{outcome: 'emptySkipped'}|{outcome: 'failed'}>}
     * The row when it has readable content; 'emptySkipped' when it deliberately doesn't (not an
     * error); 'failed' when it couldn't be read at all (logged, not thrown, so it doesn't stop the
     * rest of the scan).
     */
    async #previewOneConversation(rawConversation, artifactsById) {
      try {
        const mapped = ClaudeExportMapper.mapConversation(rawConversation, artifactsById);
        if (!mapped.hasReadableContent) return { outcome: 'emptySkipped' };
        const stored = await this.#conversationStore.getRecord(mapped.conversationId);
        return {
          outcome: 'included',
          row: {
            conversationId: mapped.conversationId,
            title: mapped.title,
            updatedAt: rawConversation.updated_at,
            promptCount: mapped.messages.filter(message => message.sender === 'human').length,
            classification: ImportMerger.classifyConversation(stored, mapped),
          },
        };
      } catch (error) {
        console.warn(LOG_PREFIX, 'skipping a conversation that failed to preview', rawConversation?.uuid, error);
        return { outcome: 'failed' };
      }
    }

    /**
     * Streams every conversation again, writing only the ones selected from the preview and indexing
     * each one the moment it is written, so its date, turn count, files, sources and tools are
     * searchable right away and an interrupted import leaves nothing unindexed; the statistics are
     * recomputed once at the end.
     * @param {File} conversationsFile The conversations.json file.
     * @param {Map<string, {html: string}>} artifactsById Parsed Artifact content, by artifact id.
     * @param {Set<string>} selectedConversationIds Ids of the conversations to write.
     * @param {string} importedAt ISO timestamp of this import.
     * @param {function(number): void} [onProgress] Called with the number processed so far.
     * @returns {Promise<{new: number, changed: number, renamedOnly: number, unchanged: number, failed: number}>}
     * The counts, among the selected conversations only.
     */
    async #applyConversations(conversationsFile, artifactsById, selectedConversationIds, importedAt, onProgress) {
      const tally = { new: 0, changed: 0, renamedOnly: 0, unchanged: 0, failed: 0 };
      let processed = 0;
      for await (const rawConversation of StreamingJsonArrayReader.readArray(conversationsFile)) {
        if (selectedConversationIds.has(rawConversation.uuid)) await this.#applyOneConversation(rawConversation, artifactsById, importedAt, tally);
        processed += 1;
        await ImportOrchestrator.#reportProgressIfDue(processed, onProgress);
      }
      onProgress?.(processed);
      await this.#stats.refreshAggregate();
      return tally;
    }

    /**
     * Maps, classifies and merges one selected conversation, tallying its classification and indexing
     * it when it was actually written.
     * @param {object} rawConversation A conversations.json entry.
     * @param {Map<string, {html: string}>} artifactsById Parsed Artifact content, by artifact id.
     * @param {string} importedAt ISO timestamp of this import.
     * @param {{new: number, changed: number, renamedOnly: number, unchanged: number, failed: number}} tally Counts to update.
     * @returns {Promise<void>} Resolves once written, if anything changed; a failure is logged and
     * tallied rather than thrown, so it doesn't stop the rest of the selected conversations from importing.
     */
    async #applyOneConversation(rawConversation, artifactsById, importedAt, tally) {
      try {
        const mapped = ClaudeExportMapper.mapConversation(rawConversation, artifactsById);
        const stored = await this.#conversationStore.getRecord(mapped.conversationId);
        tally[ImportMerger.classifyConversation(stored, mapped)] += 1;
        const merged = ImportMerger.mergeConversation(stored, mapped, importedAt);
        if (merged) {
          await this.#conversationStore.write(merged);
          await this.#stats.storeImportedSummary(ImportedConversationStore.toApiConversation(merged));
        }
      } catch (error) {
        tally.failed += 1;
        console.warn(LOG_PREFIX, 'skipping a conversation that failed to import', rawConversation?.uuid, error);
      }
    }

    /**
     * Writes every Artifact, tallying how many were newly written.
     * @param {object[]} artifactRecords The parsed Artifact records.
     * @returns {Promise<{written: number, total: number}>} The counts.
     */
    async #writeArtifacts(artifactRecords) {
      let written = 0;
      for (const record of artifactRecords) {
        const stored = await this.#database.read(DATABASE.stores.importedArtifacts, record.artifactId);
        const merged = ImportMerger.mergeArtifact(stored, record);
        if (merged) { await this.#database.write(DATABASE.stores.importedArtifacts, merged); written += 1; }
      }
      return { written, total: artifactRecords.length };
    }

    /**
     * Imports the account profile, if one was selected.
     * @param {?Array} usersJson Parsed users.json content, or null when not selected.
     * @returns {Promise<boolean>} True when a profile was written.
     */
    async #importAccountProfile(usersJson) {
      if (!usersJson) return false;
      const record = ImportMerger.mergeAccountProfile(ClaudeExportParser.accountProfile(usersJson));
      await this.#database.write(DATABASE.stores.importedAccountProfiles, record);
      return true;
    }

    /**
     * Imports a category of independently-keyed records, tallying how many were written.
     * @param {string} storeName Object store to write to.
     * @param {object[]} parsedRecords The parsed records.
     * @param {function(object): (string|string[])} keyOf The record's store key.
     * @param {function(?object, object): ?object} mergeFn Merge rule; returns the record to write, or null to skip it.
     * @returns {Promise<{written: number, total: number}>} The counts.
     */
    async #importEach(storeName, parsedRecords, keyOf, mergeFn) {
      let written = 0;
      for (const record of parsedRecords) {
        const stored = await this.#database.read(storeName, keyOf(record));
        const merged = mergeFn(stored, record);
        if (merged) { await this.#database.write(storeName, merged); written += 1; }
      }
      return { written, total: parsedRecords.length };
    }

    /**
     * Reports progress and yields to the browser's event loop every #YIELD_EVERY conversations, so a
     * large import stays responsive instead of blocking the tab until it finishes.
     * @param {number} processed Number of conversations processed so far.
     * @param {function(number): void} [onProgress] Called with the count when due.
     * @returns {Promise<void>} Resolves immediately, or after yielding when progress was reported.
     */
    static async #reportProgressIfDue(processed, onProgress) {
      if (processed % ImportOrchestrator.#YIELD_EVERY !== 0) return;
      onProgress?.(processed);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /**
   * Promise-based access to one IndexedDB database. The connection opens on first use and is
   * retried after a failure.
   */
  class IndexedDbStore {
    /**
     * Database name.
     * @type {string}
     */
    #databaseName;

    /**
     * Schema version.
     * @type {number}
     */
    #schemaVersion;

    /**
     * Creates missing object stores on upgrade.
     * @type {function(IDBDatabase): void}
     */
    #upgradeSchema;

    /**
     * The open connection, or null before first use or after a failure.
     * @type {?Promise<IDBDatabase>}
     */
    #connection = null;

    /**
     * Describes the database; nothing is opened yet.
     * @param {object} options Database description.
     * @param {string} options.name Database name.
     * @param {number} options.version Schema version.
     * @param {function(IDBDatabase): void} options.upgrade Called when the schema must be created or upgraded.
     */
    constructor({ name, version, upgrade }) {
      this.#databaseName = name;
      this.#schemaVersion = version;
      this.#upgradeSchema = upgrade;
    }

    /**
     * Reads one record.
     * @param {string} storeName Object store.
     * @param {IDBValidKey} key Record key.
     * @returns {Promise<*>} The record, or undefined when absent.
     * @throws {DOMException} When the database can't be opened or read.
     */
    read(storeName, key) {
      return this.#runRequest(storeName, 'readonly', store => store.get(key));
    }

    /**
     * Reads every record of a store.
     * @param {string} storeName Object store.
     * @returns {Promise<Array<*>>} All records.
     * @throws {DOMException} When the database can't be opened or read.
     */
    readAll(storeName) {
      return this.#runRequest(storeName, 'readonly', store => store.getAll());
    }

    /**
     * Inserts or replaces a record.
     * @param {string} storeName Object store.
     * @param {object} record Record; its key comes from the store's key path.
     * @returns {Promise<IDBValidKey>} The record's key.
     * @throws {DOMException} When the database can't be opened or written.
     */
    write(storeName, record) {
      return this.#runRequest(storeName, 'readwrite', store => store.put(record));
    }

    /**
     * Deletes a record; deleting a missing record succeeds.
     * @param {string} storeName Object store.
     * @param {IDBValidKey} key Record key.
     * @returns {Promise<void>} Resolves once deleted.
     * @throws {DOMException} When the database can't be opened or written.
     */
    remove(storeName, key) {
      return this.#runRequest(storeName, 'readwrite', store => store.delete(key));
    }

    /**
     * Reads a record and writes back a replacement in one transaction, so concurrent tabs can't
     * overwrite each other's changes.
     * @param {string} storeName Object store.
     * @param {IDBValidKey} key Record key.
     * @param {function(*): object} createReplacement Receives the current record (or undefined) and returns the replacement.
     * @returns {Promise<*>} The record as it was before the update.
     * @throws {DOMException} When the database can't be opened or written.
     */
    update(storeName, key, createReplacement) {
      return this.#runRequest(storeName, 'readwrite', (store) => {
        const readRequest = store.get(key);
        readRequest.onsuccess = () => store.put(createReplacement(readRequest.result));
        return readRequest;
      });
    }

    /**
     * The database connection, opening it on first use.
     * @returns {Promise<IDBDatabase>} The open database.
     * @throws {DOMException} When opening fails; the next call retries.
     */
    #openConnection() {
      this.#connection ??= this.#connect().catch((error) => {
        this.#connection = null;
        throw error;
      });
      return this.#connection;
    }

    /**
     * Opens the database, upgrading the schema when needed.
     * @returns {Promise<IDBDatabase>} The open database.
     * @throws {DOMException} When the request fails.
     */
    #connect() {
      return new Promise((resolve, reject) => {
        const openRequest = indexedDB.open(this.#databaseName, this.#schemaVersion);
        openRequest.onupgradeneeded = () => this.#upgradeSchema(openRequest.result);
        openRequest.onsuccess = () => resolve(openRequest.result);
        openRequest.onerror = () => reject(openRequest.error);
      });
    }

    /**
     * Runs one request in its own transaction and resolves once the transaction completes.
     * @param {string} storeName Object store.
     * @param {IDBTransactionMode} mode Transaction mode.
     * @param {function(IDBObjectStore): IDBRequest} issueRequest Issues the request whose result is returned.
     * @returns {Promise<*>} The request's result.
     * @throws {DOMException} When the transaction fails or aborts.
     */
    async #runRequest(storeName, mode, issueRequest) {
      const database = await this.#openConnection();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const request = issueRequest(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }
  }

  /**
   * Runs the action of the hotkey command a key press triggers. Which key triggers which command
   * comes from the Hotkeys bindings, so the user's changes apply at once. Key presses are handled in
   * the capture phase and stopped there, so claude.ai's own hidden app and the browser never react to
   * a chord bound to a command.
   */
  class KeyboardShortcuts {
    /**
     * The bindings.
     * @type {Hotkeys}
     */
    #hotkeys;

    /**
     * Action per command id.
     * @type {Map<string, function(): void>}
     */
    #actions;

    /**
     * Creates the shortcuts.
     * @param {Hotkeys} hotkeys The bindings.
     * @param {Map<string, function(): void>} actions Action per command id; a command without one does nothing.
     */
    constructor(hotkeys, actions) {
      this.#hotkeys = hotkeys;
      this.#actions = actions;
    }

    /**
     * Starts listening for the shortcuts.
     * @returns {void}
     */
    install() {
      window.addEventListener('keydown', this.#handleKeydown, true);
    }

    /**
     * Runs the action of the command a key press is bound to, unless a settings control is recording
     * the key press as a new binding.
     * @param {KeyboardEvent} event The key press.
     * @returns {void}
     */
    #handleKeydown = (event) => {
      if (this.#hotkeys.isRecording || event.repeat) return;
      const action = this.#actions.get(this.#hotkeys.commandIdFor(event));
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    };
  }

  /**
   * Named layouts: saves the current dock arrangement together with each chat pane's conversation,
   * and restores a saved one, recreating the panels it needs.
   */
  class LayoutLibrary {
    /**
     * Storage of the saved layouts.
     * @type {Preferences}
     */
    #preferences;

    /**
     * The workspace.
     * @type {DockWorkspace}
     */
    #workspace;

    /**
     * Chat panes.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Creates view panels a layout needs.
     * @type {PanelFactory}
     */
    #panelFactory;

    /**
     * Creates the library.
     * @param {object} services Library dependencies.
     * @param {Preferences} services.preferences Storage of the saved layouts.
     * @param {DockWorkspace} services.workspace The workspace.
     * @param {ChatPaneManager} services.paneManager Chat panes.
     * @param {PanelFactory} services.panelFactory Creates view panels a layout needs.
     */
    constructor({ preferences, workspace, paneManager, panelFactory }) {
      this.#preferences = preferences;
      this.#workspace = workspace;
      this.#paneManager = paneManager;
      this.#panelFactory = panelFactory;
    }

    /**
     * Names of the saved layouts.
     * @returns {string[]} The names, sorted.
     */
    names() {
      return Object.keys(this.#readAll()).sort((first, second) => first.localeCompare(second));
    }

    /**
     * Saves the current arrangement under a name, replacing a layout of the same name.
     * @param {string} name Layout name.
     * @returns {void}
     */
    save(name) {
      const layouts = this.#readAll();
      layouts[name] = { tree: this.#workspace.layoutSnapshot(), chatPanes: this.#paneManager.storedPanes() };
      this.#preferences.writeJson(STORAGE_KEYS.savedLayouts, layouts);
    }

    /**
     * Restores a saved layout: creates the panels it references that don't exist, applies its
     * arrangement and closes the panels it doesn't contain. Unknown names are ignored.
     * @param {string} name Layout name.
     * @returns {void}
     */
    load(name) {
      const layout = this.#readAll()[name];
      if (!layout) return;
      const conversationByPane = new Map((Array.isArray(layout.chatPanes) ? layout.chatPanes : []).map(pane => [pane.paneId, pane.conversationId]));
      DockTree.collectPanelIds(layout.tree).forEach(panelId => this.#ensurePanel(panelId, conversationByPane.get(panelId) ?? null));
      this.#workspace.replaceLayout(layout.tree);
    }

    /**
     * Deletes a saved layout.
     * @param {string} name Layout name.
     * @returns {void}
     */
    remove(name) {
      const layouts = this.#readAll();
      delete layouts[name];
      this.#preferences.writeJson(STORAGE_KEYS.savedLayouts, layouts);
    }

    /**
     * Creates a panel referenced by a layout if it doesn't exist yet; unknown ids are ignored.
     * @param {string} panelId Panel id from the layout.
     * @param {?string} conversationId Conversation of a chat pane, or null.
     * @returns {void}
     */
    #ensurePanel(panelId, conversationId) {
      if (this.#workspace.hasPanel(panelId)) return;
      if (ChatPaneManager.isPaneId(panelId)) this.#workspace.registerPanel(panelId, this.#paneManager.createPaneForLayout(panelId, conversationId));
      else if (this.#panelFactory.isViewPanelId(panelId)) this.#workspace.registerPanel(panelId, this.#panelFactory.create(panelId));
    }

    /**
     * The saved layouts.
     * @returns {Object<string, {tree: DockNode, chatPanes: Array<{paneId: string, conversationId: ?string}>}>} Layouts by name; empty when nothing valid is stored.
     */
    #readAll() {
      const stored = this.#preferences.readJson(STORAGE_KEYS.savedLayouts);
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    }
  }

  /**
   * Selectable effort levels; the first is the default.
   * @type {ReadonlyArray<ChoiceOption>}
   */
  const EFFORTS = Object.freeze([
    { id: 'low', label: 'Low effort' },
    { id: 'medium', label: 'Medium effort' },
    { id: 'high', label: 'High effort' },
    { id: 'xhigh', label: 'Extra effort' },
    { id: 'max', label: 'Max effort' },
  ]);

  /**
   * Selectable models; the first is the default.
   * @type {ReadonlyArray<ChoiceOption>}
   */
  const MODELS = Object.freeze([
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  ]);

  /**
   * Waits for a given time.
   * @param {number} durationMs Milliseconds to wait.
   * @returns {Promise<void>} Resolves after the delay.
   */
  function wait(durationMs) {
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }

  /**
   * Effort labels for known ids, since claude.ai's effort submenu doesn't render its options as
   * cleanly labelled text as the model list does. An id outside this map still works, with a label
   * derived from the id itself.
   * @type {Readonly<Record<string, string>>}
   */
  const KNOWN_EFFORT_LABELS = Object.freeze({ low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra effort', max: 'Max effort' });

  /**
   * Reads the live model and effort lists straight from claude.ai's own composer, run fresh and
   * self-contained in a hidden same-origin iframe: the same "never touch the page's own native app
   * instance" approach used to extract widgets. claude.ai doesn't expose this as an API either - its
   * own dropdown list is compiled into its client bundle - so the only way to stay in sync with a
   * roster that changes regularly is to read the choices it renders for itself.
   */
  class ModelCatalogSource {
    /**
     * Extracts the current model and effort lists.
     * @returns {Promise<{models: ChoiceOption[], efforts: ChoiceOption[]}>} The lists.
     * @throws {Error} When the composer or its option menus don't appear within the timeout.
     */
    static async extract() {
      const iframe = ModelCatalogSource.#createHiddenIframe();
      document.body.append(iframe);
      try {
        return await ModelCatalogSource.#readFromFrame(iframe);
      } finally {
        iframe.remove();
      }
    }

    /**
     * Creates a hidden iframe pointed at a fresh chat, ready to append.
     * @returns {HTMLIFrameElement} The iframe.
     */
    static #createHiddenIframe() {
      return createElement('iframe', { src: 'https://claude.ai/new', style: 'position:fixed; top:-9999px; left:-9999px; width:900px; height:900px; border:0;' });
    }

    /**
     * Opens the model dropdown and its effort submenu in turn and reads each one's options.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @returns {Promise<{models: ChoiceOption[], efforts: ChoiceOption[]}>} The lists.
     * @throws {Error} When a step doesn't appear within the timeout.
     */
    static async #readFromFrame(iframe) {
      const deadline = Date.now() + TIMING.modelCatalogTimeoutMs;
      const dropdownTrigger = await ModelCatalogSource.#waitFor(iframe, doc => doc.querySelector('[data-testid="model-selector-dropdown"]'), deadline);
      dropdownTrigger.click();
      await ModelCatalogSource.#waitFor(iframe, doc => doc.querySelector('[data-model-id]'), deadline);
      await ModelCatalogSource.#expandMoreModels(iframe);
      const models = await ModelCatalogSource.#waitForOptions(iframe, '[data-model-id]', deadline, ModelCatalogSource.#modelOption);
      const effortTrigger = await ModelCatalogSource.#waitFor(iframe, doc => ModelCatalogSource.#menuItemStartingWith(doc, 'Effort'), deadline);
      effortTrigger.click();
      const efforts = await ModelCatalogSource.#waitForOptions(iframe, '[data-effort-id]', deadline, ModelCatalogSource.#effortOption);
      if (!models.length) throw new Error('model list did not render within the timeout');
      return { models, efforts };
    }

    /**
     * Clicks the "More models" entry if the menu has one, revealing the rest of the roster beyond
     * its short top-level list; a menu without one (a plan with only the short list) is left as is.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @returns {Promise<void>} Resolves once clicked (if present) and given a moment to expand.
     */
    static async #expandMoreModels(iframe) {
      const moreTrigger = ModelCatalogSource.#menuItemStartingWith(ModelCatalogSource.#documentOf(iframe), 'More models');
      if (!moreTrigger) return;
      moreTrigger.click();
      await wait(TIMING.modelCatalogPollMs);
    }

    /**
     * A menu item whose trimmed text starts with a label, such as the "Effort" or "More models"
     * entries, which also carry their current value or a hint in the same text node.
     * @param {?Document} doc The iframe's document, or null while it can't be read yet.
     * @param {string} label The label prefix.
     * @returns {?HTMLElement} The item, or null when not rendered yet.
     */
    static #menuItemStartingWith(doc, label) {
      if (!doc) return null;
      return [...doc.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim().startsWith(label)) ?? null;
    }

    /**
     * Polls the iframe's document until a query returns a truthy result or the deadline passes.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @param {function(Document): *} query Reads the desired value from the document.
     * @param {number} deadline Epoch ms after which to give up.
     * @returns {Promise<*>} The query's result.
     * @throws {Error} When the deadline passes without a result.
     */
    static async #waitFor(iframe, query, deadline) {
      while (Date.now() < deadline) {
        const doc = ModelCatalogSource.#documentOf(iframe);
        const result = doc ? query(doc) : null;
        if (result) return result;
        await wait(TIMING.modelCatalogPollMs);
      }
      throw new Error('claude.ai did not render the expected control within the timeout');
    }

    /**
     * Polls for a menu's options to appear, mapping each to a choice once they do.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @param {string} selector Selector matching each option element.
     * @param {number} deadline Epoch ms after which to give up (returns whatever is found by then).
     * @param {function(HTMLElement): ChoiceOption} toOption Reads one option element's choice.
     * @returns {Promise<ChoiceOption[]>} The options, in the order rendered; empty past the deadline.
     */
    static async #waitForOptions(iframe, selector, deadline, toOption) {
      while (Date.now() < deadline) {
        const doc = ModelCatalogSource.#documentOf(iframe);
        const items = doc ? [...doc.querySelectorAll(selector)] : [];
        if (items.length) return items.map(toOption);
        await wait(TIMING.modelCatalogPollMs);
      }
      return [];
    }

    /**
     * A model menu item's choice: its id and its clean display label, without the description or
     * "requires usage credits" badge that share the same item.
     * @param {HTMLElement} item The menu item.
     * @returns {ChoiceOption} The choice.
     */
    static #modelOption(item) {
      const truncated = item.querySelectorAll('.truncate');
      const label = (truncated[1] ?? truncated[0])?.textContent?.trim();
      return { id: item.getAttribute('data-model-id'), label: label || item.getAttribute('data-model-id') };
    }

    /**
     * An effort menu item's choice: its id, labelled from the known map or derived from the id.
     * @param {HTMLElement} item The menu item.
     * @returns {ChoiceOption} The choice.
     */
    static #effortOption(item) {
      const id = item.getAttribute('data-effort-id');
      return { id, label: KNOWN_EFFORT_LABELS[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)} effort` };
    }

    /**
     * The iframe's document, or null while it can't be read (not yet navigated, still loading).
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @returns {?Document} The document, or null.
     */
    static #documentOf(iframe) {
      try {
        return iframe.contentDocument;
      } catch {
        return null;
      }
    }
  }

  /**
   * The selectable models and effort levels, kept in sync with claude.ai's own roster instead of a
   * list hardcoded here that would go stale as models are added or retired. Starts from the small
   * built-in fallback (or a cached extraction, if one isn't stale yet), then refreshes in the
   * background; refresh() is safe to call repeatedly, since a fresh-enough cache or an already
   * running extraction is reused rather than repeated.
   * @fires ModelCatalog#catalog The live lists changed.
   */
  class ModelCatalog extends EventEmitter {
    /**
     * Cache storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Current model list.
     * @type {ChoiceOption[]}
     */
    #models = MODELS;

    /**
     * Current effort list.
     * @type {ChoiceOption[]}
     */
    #efforts = EFFORTS;

    /**
     * When the current lists were last extracted; null for the built-in fallback.
     * @type {?number}
     */
    #fetchedAt = null;

    /**
     * A refresh already in flight, reused by a concurrent call instead of starting another.
     * @type {?Promise<void>}
     */
    #refreshPromise = null;

    /**
     * Creates the catalog on top of a cache, applying it immediately if it isn't stale.
     * @param {Preferences} preferences Cache storage.
     */
    constructor(preferences) {
      super();
      this.#preferences = preferences;
      this.#loadCached();
    }

    /**
     * Selectable models; the first is the default.
     * @returns {ChoiceOption[]} The list.
     */
    get models() {
      return this.#models;
    }

    /**
     * Selectable effort levels; the first is the default.
     * @returns {ChoiceOption[]} The list.
     */
    get efforts() {
      return this.#efforts;
    }

    /**
     * Extracts the live lists if the current ones are stale (or were never extracted), then caches
     * and publishes them. A failure is logged and leaves the previous lists in place.
     * @returns {Promise<void>} Resolves once refreshed, reused, or failed.
     */
    refresh() {
      if (!this.#isStale()) return Promise.resolve();
      this.#refreshPromise ??= this.#runRefresh().finally(() => { this.#refreshPromise = null; });
      return this.#refreshPromise;
    }

    /**
     * Runs one extraction and applies it, or logs and keeps the previous lists on failure.
     * @returns {Promise<void>} Resolves once applied or failed.
     */
    async #runRefresh() {
      try {
        const { models, efforts } = await ModelCatalogSource.extract();
        this.#apply(ModelCatalog.#withPreferredDefaultFirst(models), efforts.length ? efforts : this.#efforts, Date.now());
        this.#preferences.writeJson(STORAGE_KEYS.modelCatalog, { fetchedAt: this.#fetchedAt, models: this.#models, efforts: this.#efforts });
      } catch (error) {
        console.warn(LOG_PREFIX, 'extracting the live model list failed; keeping the previous list', error);
      }
    }

    /**
     * Moves the built-in fallback's own default model to the front of a freshly extracted list, so
     * a user who never picked one keeps getting a sensible default instead of whatever claude.ai's
     * own menu happens to render first (which can be a credit-gated model like Fable). A list
     * without that id, or already led by it, is returned as is.
     * @param {ChoiceOption[]} models Freshly extracted models.
     * @returns {ChoiceOption[]} The models, reordered if needed.
     */
    static #withPreferredDefaultFirst(models) {
      const preferredIndex = models.findIndex(model => model.id === MODELS[0].id);
      if (preferredIndex <= 0) return models;
      const reordered = [...models];
      const [preferred] = reordered.splice(preferredIndex, 1);
      reordered.unshift(preferred);
      return reordered;
    }

    /**
     * Applies a cached catalog if it looks valid.
     * @returns {void}
     */
    #loadCached() {
      const cached = this.#preferences.readJson(STORAGE_KEYS.modelCatalog);
      if (ModelCatalog.#looksValid(cached)) this.#apply(cached.models, cached.efforts, cached.fetchedAt);
    }

    /**
     * Whether the current lists are stale enough to warrant a fresh extraction.
     * @returns {boolean} True for the built-in fallback or a cache past its TTL.
     */
    #isStale() {
      return this.#fetchedAt === null || Date.now() - this.#fetchedAt > TIMING.modelCatalogTtlMs;
    }

    /**
     * Replaces the current lists and publishes the change.
     * @param {ChoiceOption[]} models New model list.
     * @param {ChoiceOption[]} efforts New effort list.
     * @param {number} fetchedAt When this list was extracted.
     * @returns {void}
     */
    #apply(models, efforts, fetchedAt) {
      this.#models = models;
      this.#efforts = efforts;
      this.#fetchedAt = fetchedAt;
      this.publish('catalog');
    }

    /**
     * Whether a cached value looks like a usable catalog.
     * @param {*} cached The parsed cache entry.
     * @returns {boolean} True when it carries non-empty model and effort arrays.
     */
    static #looksValid(cached) {
      return Boolean(cached) && Array.isArray(cached.models) && cached.models.length > 0 && Array.isArray(cached.efforts) && cached.efforts.length > 0;
    }
  }

  var stylesheet$5 = ".claude-plus-folder {\r\n  cursor: pointer;\r\n}\r\n\r\n.claude-plus-folder:hover > td {\r\n  background: var(--claude-plus-color-hover);\r\n}\r\n\r\n.claude-plus-breadcrumb {\r\n  font-size: 12px;\r\n  color: var(--claude-plus-color-text-muted);\r\n  margin-bottom: 6px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-breadcrumb__back-link {\r\n  color: var(--claude-plus-color-accent);\r\n  cursor: pointer;\r\n}\r\n";

  StyleRegistry.register(stylesheet$5);

  /**
   * Uploaded and produced files: a table of conversations with files, and per conversation a table
   * of its files; both with configurable columns, sorting and filters. Double-clicking a file opens
   * its conversation and jumps to the message it belongs to.
   */
  class FilesPanel extends Panel {
    /**
     * Conversation statistics.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Table settings storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Navigation.
     * @type {Router}
     */
    #router;

    /**
     * Conversation id of the open folder, or null for the folder table.
     * @type {?string}
     */
    #openFolderId = null;

    /**
     * Table of conversations with files; created with the DOM.
     * @type {?ColumnTable}
     */
    #folderTable = null;

    /**
     * Table of the open folder's files; created with the DOM.
     * @type {?ColumnTable}
     */
    #fileTable = null;

    /**
     * Creates the panel.
     * @param {object} services Panel dependencies.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {Preferences} services.preferences Table settings storage.
     * @param {Router} services.router Navigation.
     */
    constructor({ stats, preferences, router }) {
      super('Files');
      this.#stats = stats;
      this.#preferences = preferences;
      this.#router = router;
    }

    /**
     * HTML of the panel body.
     * @returns {string} Breadcrumb and the two table hosts.
     */
    createBodyHtml() {
      return `
      <div class="claude-plus-breadcrumb" data-name="breadcrumb"></div>
      <div class="claude-plus-table-host" data-name="folderTableHost"></div>
      <div class="claude-plus-table-host" data-name="fileTableHost" hidden></div>`;
    }

    /**
     * Creates both tables, wires navigation and follows aggregate changes.
     * @returns {void}
     */
    bindEvents() {
      this.#folderTable = new ColumnTable({
        container: this.elements.folderTableHost,
        tableId: 'fileFolders',
        columns: FilesPanel.#folderColumns(),
        preferences: this.#preferences,
        defaultSort: { column: 'date', direction: -1 },
        rowAttributes: folder => `class="claude-plus-folder" data-conversation-id="${escapeHtml(folder.conversationId)}"`,
        emptyText: 'No files or attachments indexed yet.',
      });
      this.#fileTable = new ColumnTable({
        container: this.elements.fileTableHost,
        tableId: 'files',
        columns: createFileColumns(false),
        preferences: this.#preferences,
        defaultSort: { column: 'date', direction: -1 },
        rowAttributes: file => `data-message-id="${escapeHtml(file.messageId ?? '')}"`,
        emptyText: 'No files here.',
      });
      this.#folderTable.bodyElement.addEventListener('click', event => this.#onFolderClick(event));
      this.#fileTable.bodyElement.addEventListener('dblclick', event => this.#onFileDoubleClick(event));
      this.elements.breadcrumb.addEventListener('click', event => this.#onBreadcrumbClick(event));
      this.listenTo(this.#stats, 'aggregate', () => this.render());
    }

    /**
     * Shows the open folder's files, or the folder table when none is open or it no longer exists.
     * @returns {void}
     */
    render() {
      const openFolder = this.#stats.aggregate.folders.find(folder => folder.conversationId === this.#openFolderId);
      if (openFolder) this.#showFiles(openFolder);
      else this.#showFolders();
    }

    /**
     * Closes the tables' typeaheads and ends the subscriptions.
     * @returns {void}
     */
    dispose() {
      [this.#folderTable, this.#fileTable].filter(Boolean).forEach(table => table.dispose());
      super.dispose();
    }

    /**
     * Columns of the folder table.
     * @returns {TableColumn[]} Chat, file count and newest file date.
     */
    static #folderColumns() {
      return [
        { id: 'conversation', label: 'Chat', isAlwaysVisible: true, filter: 'values', sortValue: folder => folder.conversationTitle.toLowerCase(), filterValue: folder => folder.conversationTitle, cellHtml: folder => `📁 ${escapeHtml(folder.conversationTitle)}` },
        { id: 'fileCount', label: 'Files', isVisibleByDefault: true, sortValue: folder => folder.files.length, cellHtml: folder => String(folder.files.length) },
        { id: 'date', label: 'Newest', isVisibleByDefault: true, filter: 'date', sortValue: folder => folder.newestFileTime, filterValue: folder => new Date(folder.newestFileTime).toISOString(), cellHtml: folder => escapeHtml(formatTimestamp(new Date(folder.newestFileTime).toISOString())) },
      ];
    }

    /**
     * Opens the clicked folder.
     * @param {MouseEvent} event Click in the folder table body.
     * @returns {void}
     */
    #onFolderClick(event) {
      const row = event.target.closest('[data-conversation-id]');
      if (row) this.#openFolder(row.dataset.conversationId);
    }

    /**
     * Opens the open folder's conversation and jumps to a double-clicked file's message.
     * @param {MouseEvent} event The double-click.
     * @returns {Promise<void>} Resolves once opened and scrolled to.
     */
    async #onFileDoubleClick(event) {
      const messageId = event.target.closest('[data-message-id]')?.dataset.messageId;
      if (!messageId) return;
      await this.#router.openConversation(this.#openFolderId);
      this.#router.scrollToMessage(messageId);
    }

    /**
     * Returns to the folder table when the back link is clicked.
     * @param {MouseEvent} event Click in the breadcrumb.
     * @returns {void}
     */
    #onBreadcrumbClick(event) {
      if (event.target.closest('[data-action="back"]')) this.#openFolder(null);
    }

    /**
     * Opens a folder, or the folder table.
     * @param {?string} conversationId Folder to open, or null for the folder table.
     * @returns {void}
     */
    #openFolder(conversationId) {
      this.#openFolderId = conversationId;
      this.render();
    }

    /**
     * Shows the folder table.
     * @returns {void}
     */
    #showFolders() {
      this.#openFolderId = null;
      this.elements.breadcrumb.innerHTML = '<span>All folders</span>';
      this.elements.folderTableHost.hidden = false;
      this.elements.fileTableHost.hidden = true;
      this.#folderTable.setRows(this.#stats.aggregate.folders);
    }

    /**
     * Shows a folder's files.
     * @param {FileFolder} folder The folder.
     * @returns {void}
     */
    #showFiles(folder) {
      this.elements.breadcrumb.innerHTML = `<span class="claude-plus-breadcrumb__back-link" data-action="back">← All folders</span> / ${escapeHtml(folder.conversationTitle)}`;
      this.elements.folderTableHost.hidden = true;
      this.elements.fileTableHost.hidden = false;
      this.#fileTable.setRows(folder.files);
    }
  }

  /**
   * Formats a usage window's utilization as a percentage rounded to two decimals.
   * @param {?UsageWindow} usageWindow The window, or null when unknown.
   * @returns {string} The percentage, or "–" when unknown.
   */
  function formatUtilization(usageWindow) {
    if (!usageWindow) return '–';
    return `${Math.round((usageWindow.utilization || 0) * 100) / 100}%`;
  }

  var stylesheet$4 = ".claude-plus-stats-view-toggle {\n  display: flex;\n  gap: 6px;\n}\n\n.claude-plus-stats-view-toggle__button--active {\n  background: var(--claude-plus-color-accent);\n  color: #fff;\n}\n";

  StyleRegistry.register(stylesheet$4);

  /**
   * Activity, usage, token estimates, tool calls and the history backfill.
   */
  class StatsPanel extends Panel {
    /**
     * Conversation statistics.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Active-time tracking.
     * @type {ActivityTracker}
     */
    #activity;

    /**
     * Usage windows.
     * @type {RateLimitMonitor}
     */
    #rateLimits;

    /**
     * Which aggregate the totals section currently shows.
     * @type {'combined'|'live'|'imported'}
     */
    #view = 'combined';

    /**
     * Creates the panel.
     * @param {StatsIndex} stats Conversation statistics.
     * @param {ActivityTracker} activity Active-time tracking.
     * @param {RateLimitMonitor} rateLimits Usage windows.
     */
    constructor(stats, activity, rateLimits) {
      super('Stats');
      this.#stats = stats;
      this.#activity = activity;
      this.#rateLimits = rateLimits;
    }

    /**
     * HTML of the panel body.
     * @returns {string} The stat sections.
     */
    createBodyHtml() {
      const row = StatsPanel.#namedValueRowHtml;
      return `
      <div class="claude-plus-panel__section">${row('Active today', 'activeToday')}${row('Active all-time', 'activeAllTime')}${row('Status', 'activityStatus')}</div>
      <div class="claude-plus-panel__section">
        <div class="claude-plus-stats-view-toggle" data-name="viewToggle">
          <button class="claude-plus-toolbar__button claude-plus-stats-view-toggle__button" data-view="combined">Combined</button>
          <button class="claude-plus-toolbar__button claude-plus-stats-view-toggle__button" data-view="live">Live</button>
          <button class="claude-plus-toolbar__button claude-plus-stats-view-toggle__button" data-view="imported">Imported</button>
        </div>
      </div>
      <div class="claude-plus-panel__section">${row('Turns', 'promptCount')}${row('Avg response time', 'averageResponseTime')}</div>
      <div class="claude-plus-panel__section">${row('Session limit (5h)', 'sessionLimit')}${row('Weekly limit', 'weeklyLimit')}</div>
      <div class="claude-plus-panel__section">${row('Est. tokens in / out', 'estimatedTokens')}
        <div class="claude-plus-hint">Estimated from text length — claude.ai doesn't expose real token counts.</div></div>
      <details class="claude-plus-panel__section" open><summary>Tool calls (<span data-name="toolCallTotal">0</span>)</summary><div class="claude-plus-scrollable" data-name="toolCallRanking"></div></details>
      <div class="claude-plus-panel__section">
        <button class="claude-plus-primary-button claude-plus-full-width" data-name="backfillButton">Index full history</button>
        <div class="claude-plus-hint" data-name="backfillStatus"></div>
        <div class="claude-plus-spaced-above">${row('Conversations indexed', 'indexedConversationCount')}</div>
        <div class="claude-plus-hint" data-name="staleRecordHint" hidden></div>
      </div>`;
    }

    /**
     * Wires the backfill button and follows every data source.
     * @returns {void}
     */
    bindEvents() {
      this.elements.backfillButton.addEventListener('click', () => this.#toggleBackfill());
      this.elements.viewToggle.addEventListener('click', event => this.#onViewToggleClick(event));
      this.listenTo(this.#activity, 'activity', () => this.#renderActivity());
      this.listenTo(this.#rateLimits, 'rateLimits', () => this.#renderRateLimits());
      this.listenTo(this.#stats, 'aggregate', () => this.#renderAggregate());
      this.listenTo(this.#stats, 'backfill', () => this.#renderBackfill());
    }

    /**
     * Renders every section.
     * @returns {void}
     */
    render() {
      this.#renderActivity();
      this.#renderRateLimits();
      this.#renderAggregate();
      this.#renderBackfill();
    }

    /**
     * HTML of a labelled value filled in later through its data-name.
     * @param {string} label Row label.
     * @param {string} valueName data-name of the value element.
     * @returns {string} The row.
     */
    static #namedValueRowHtml(label, valueName) {
      return `<div class="claude-plus-value-row"><span>${escapeHtml(label)}</span><b data-name="${valueName}">–</b></div>`;
    }

    /**
     * Starts the backfill, or cancels it while running.
     * @returns {void}
     */
    #toggleBackfill() {
      if (this.#stats.backfill.isRunning) this.#stats.cancelBackfill();
      else this.#stats.runBackfill();
    }

    /**
     * Shows active time and idle state.
     * @returns {void}
     */
    #renderActivity() {
      this.elements.activeToday.textContent = formatDuration(this.#activity.activeTodayMs);
      this.elements.activeAllTime.textContent = formatDuration(this.#activity.activeAllTimeMs);
      this.elements.activityStatus.textContent = this.#activity.isIdle ? 'idle' : 'active';
    }

    /**
     * Shows the usage windows, once known.
     * @returns {void}
     */
    #renderRateLimits() {
      const limits = this.#rateLimits.limits;
      if (!limits) return;
      this.elements.sessionLimit.textContent = formatUtilization(limits.fiveHour);
      this.elements.weeklyLimit.textContent = formatUtilization(limits.sevenDay);
    }

    /**
     * Switches which aggregate the totals section shows, unless the toggle itself was clicked
     * without hitting a button.
     * @param {MouseEvent} event Click in the view toggle.
     * @returns {void}
     */
    #onViewToggleClick(event) {
      const button = event.target.closest('[data-view]');
      if (button) { this.#view = button.dataset.view; this.#renderAggregate(); }
    }

    /**
     * The currently selected aggregate.
     * @returns {StatsAggregate} Combined, live-only or imported-only totals.
     */
    #selectedAggregate() {
      if (this.#view === 'live') return this.#stats.liveAggregate;
      if (this.#view === 'imported') return this.#stats.importedAggregate;
      return this.#stats.aggregate;
    }

    /**
     * Shows the totals and the tool call ranking for the currently selected view.
     * @returns {void}
     */
    #renderAggregate() {
      const aggregate = this.#selectedAggregate();
      const toolRanking = entriesByDescendingCount(aggregate.toolCallCounts);
      const responseTimes = aggregate.responseTimesMs;
      this.elements.viewToggle.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('claude-plus-stats-view-toggle__button--active', button.dataset.view === this.#view));
      this.elements.promptCount.textContent = aggregate.promptCount;
      this.elements.averageResponseTime.textContent = responseTimes.length ? formatDuration(average(responseTimes)) : '–';
      this.elements.estimatedTokens.textContent = `~${aggregate.estimatedTokensIn.toLocaleString()} in / ~${aggregate.estimatedTokensOut.toLocaleString()} out`;
      this.elements.indexedConversationCount.textContent = aggregate.conversationCount;
      this.elements.staleRecordHint.hidden = aggregate.skippedRecordCount === 0;
      this.elements.staleRecordHint.textContent = `${aggregate.skippedRecordCount} stored record(s) look stale and were skipped — consider running "Index full history".`;
      this.elements.toolCallTotal.textContent = toolRanking.reduce((sum, [, count]) => sum + count, 0);
      this.elements.toolCallRanking.innerHTML = toolRanking.map(([toolName, count]) => valueRowHtml(toolName, count)).join('') || emptyStateHtml('No tool calls indexed yet.');
    }

    /**
     * Shows the backfill button label and progress.
     * @returns {void}
     */
    #renderBackfill() {
      const progress = this.#stats.backfill;
      this.elements.backfillButton.textContent = progress.isRunning ? 'Cancel indexing' : 'Index full history';
      this.elements.backfillStatus.textContent = StatsPanel.#backfillStatusText(progress);
    }

    /**
     * Status line under the backfill button.
     * @param {BackfillProgress} progress Backfill state.
     * @returns {string} Progress while running, the last result after a run, or a hint before any.
     */
    static #backfillStatusText({ isRunning, processedCount, totalCount }) {
      if (isRunning) return `Indexing… ${processedCount} / ${totalCount}`;
      if (totalCount) return `Last run: ${processedCount} / ${totalCount} indexed`;
      return 'Not run yet — pulls every past conversation once.';
    }
  }

  /**
   * Web sources cited in tool results, as a column table with typeahead and date filters, plus an
   * outlet ranking. Double-clicking a source opens its conversation and jumps to the citing message.
   */
  class WebSourcesPanel extends Panel {
    /**
     * Conversation statistics.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Table settings storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Navigation.
     * @type {Router}
     */
    #router;

    /**
     * The sources table; created with the DOM.
     * @type {?ColumnTable}
     */
    #table = null;

    /**
     * Creates the panel.
     * @param {object} services Panel dependencies.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {Preferences} services.preferences Table settings storage.
     * @param {Router} services.router Navigation.
     */
    constructor({ stats, preferences, router }) {
      super('Web Sources');
      this.#stats = stats;
      this.#preferences = preferences;
      this.#router = router;
    }

    /**
     * HTML of the panel body.
     * @returns {string} Table host and outlet ranking.
     */
    createBodyHtml() {
      return `
      <div class="claude-plus-table-host" data-name="tableHost"></div>
      <details class="claude-plus-panel__section"><summary>Top outlets (<span data-name="outletTotal">0</span>)</summary><div class="claude-plus-scrollable" data-name="outletRanking"></div></details>`;
    }

    /**
     * Creates the table and follows aggregate changes.
     * @returns {void}
     */
    bindEvents() {
      this.#table = new ColumnTable({
        container: this.elements.tableHost,
        tableId: 'webSources',
        columns: createSourceColumns(true),
        preferences: this.#preferences,
        defaultSort: { column: 'date', direction: -1 },
        rowAttributes: source => `data-conversation-id="${escapeHtml(source.conversationId)}" data-message-id="${escapeHtml(source.messageId ?? '')}"`,
        emptyText: 'No web sources match these filters.',
      });
      this.#table.bodyElement.addEventListener('dblclick', event => this.#onRowDoubleClick(event));
      this.listenTo(this.#stats, 'aggregate', () => this.render());
    }

    /**
     * Renders the table and the ranking.
     * @returns {void}
     */
    render() {
      this.#table.setRows(this.#stats.aggregate.sources);
      this.#renderOutletRanking();
    }

    /**
     * Closes the table's typeahead and ends the subscriptions.
     * @returns {void}
     */
    dispose() {
      if (this.#table) this.#table.dispose();
      super.dispose();
    }

    /**
     * Opens a double-clicked source's conversation and jumps to the message that cited it.
     * @param {MouseEvent} event The double-click.
     * @returns {Promise<void>} Resolves once opened and scrolled to.
     */
    async #onRowDoubleClick(event) {
      const row = event.target.closest('[data-conversation-id]');
      if (!row) return;
      await this.#router.openConversation(row.dataset.conversationId);
      if (row.dataset.messageId) this.#router.scrollToMessage(row.dataset.messageId);
    }

    /**
     * Shows the most cited outlets, up to LIMITS.rankedOutlets.
     * @returns {void}
     */
    #renderOutletRanking() {
      const outletCounts = this.#stats.aggregate.outletCounts;
      this.elements.outletTotal.textContent = Object.keys(outletCounts).length;
      this.elements.outletRanking.innerHTML = entriesByDescendingCount(outletCounts).slice(0, LIMITS.rankedOutlets)
        .map(([outlet, count]) => valueRowHtml(outlet, count)).join('') || emptyStateHtml('No sources yet.');
    }
  }

  /**
   * Creates view panels (chats list, stats, sources, files, search). Any number of instances of a
   * type can exist; they are independent views of the same shared data. Instance ids are the type
   * ("stats") for the first instance and "type#uuid" for added ones, so instances stored in a layout
   * can be recreated on the next visit.
   */
  class PanelFactory {
    /**
     * Menu label and constructor per view panel type, in menu order.
     * @type {Map<string, {label: string, create: function(object): Panel}>}
     */
    static #VIEW_TYPES = new Map([
      ['conversations', { label: 'Chats-list', create: services => new ConversationListPanel(services) }],
      ['stats', { label: 'Stats', create: services => new StatsPanel(services.stats, services.activity, services.rateLimits) }],
      ['webSources', { label: 'Sources', create: services => new WebSourcesPanel(services) }],
      ['files', { label: 'Files', create: services => new FilesPanel(services) }],
      ['search', { label: 'Search', create: services => new SearchPanel(services) }],
    ]);

    /**
     * Services passed to the panel constructors.
     * @type {object}
     */
    #services;

    /**
     * Workspace the panels live in; set by attachWorkspace.
     * @type {?DockWorkspace}
     */
    #workspace = null;

    /**
     * Creates the factory.
     * @param {object} services Services passed to the panel constructors.
     * @param {CombinedConversationDirectory} services.directory Shared conversation list.
     * @param {Router} services.router Navigation.
     * @param {ChatPaneManager} services.paneManager Chat panes.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {ActivityTracker} services.activity Active-time tracking.
     * @param {RateLimitMonitor} services.rateLimits Usage windows.
     * @param {Preferences} services.preferences Settings storage.
     */
    constructor(services) {
      this.#services = services;
    }

    /**
     * Ids of the default instance of every view type.
     * @returns {string[]} The ids.
     */
    static get defaultPanelIds() {
      return [...PanelFactory.#VIEW_TYPES.keys()];
    }

    /**
     * Connects the workspace, which removes panels when they are closed.
     * @param {DockWorkspace} workspace The workspace.
     * @returns {void}
     */
    attachWorkspace(workspace) {
      this.#workspace = workspace;
    }

    /**
     * Whether an id belongs to a view panel instance.
     * @param {string} panelId Panel id.
     * @returns {boolean} True when its type is a view type.
     */
    isViewPanelId(panelId) {
      return PanelFactory.#VIEW_TYPES.has(PanelFactory.#typeOf(panelId));
    }

    /**
     * Creates the view panel with an id; closing it removes it from the workspace.
     * @param {string} panelId Panel id of a view type.
     * @returns {Panel} The panel.
     */
    create(panelId) {
      const panel = PanelFactory.#VIEW_TYPES.get(PanelFactory.#typeOf(panelId)).create(this.#services);
      panel.setCloseHandler(() => this.#workspace.removePanel(panelId));
      return panel;
    }

    /**
     * Creates a new instance of a view type with a new id.
     * @param {string} type View type.
     * @returns {{panelId: string, panel: Panel}} The id and the panel.
     */
    createInstance(type) {
      const panelId = `${type}#${crypto.randomUUID()}`;
      return { panelId, panel: this.create(panelId) };
    }

    /**
     * Entries of a zone's "+" menu.
     * @returns {ChoiceOption[]} "Add chat", then one "Add … panel" entry per view type.
     */
    addMenuEntries() {
      return [{ id: 'chat', label: 'Add chat' }, ...[...PanelFactory.#VIEW_TYPES].map(([type, definition]) => ({ id: type, label: `Add ${definition.label} panel` }))];
    }

    /**
     * Type part of a panel id.
     * @param {string} panelId Panel id.
     * @returns {string} Everything before the first "#".
     */
    static #typeOf(panelId) {
      return String(panelId).split('#')[0];
    }
  }

  /**
   * localStorage access that degrades to no-ops when storage is unavailable (private mode, blocked
   * site data), because every accessor can throw there.
   */
  class Preferences {
    /**
     * Reads a string value.
     * @param {string} key Storage key.
     * @returns {?string} The stored value, or null when missing or unavailable.
     */
    read(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    }

    /**
     * Stores a value as a string; silently skipped when storage is unavailable.
     * @param {string} key Storage key.
     * @param {*} value Value to store.
     * @returns {void}
     */
    write(key, value) {
      try {
        localStorage.setItem(key, String(value));
      } catch {
        return;
      }
    }

    /**
     * Removes a value; silently skipped when storage is unavailable.
     * @param {string} key Storage key.
     * @returns {void}
     */
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        return;
      }
    }

    /**
     * Reads and parses a JSON value.
     * @param {string} key Storage key.
     * @returns {*} The parsed value, or null when missing, unavailable or not valid JSON.
     */
    readJson(key) {
      try {
        return JSON.parse(this.read(key));
      } catch {
        return null;
      }
    }

    /**
     * Stores a value as JSON.
     * @param {string} key Storage key.
     * @param {*} value JSON-serializable value.
     * @returns {void}
     */
    writeJson(key, value) {
      this.write(key, JSON.stringify(value));
    }

    /**
     * Every stored entry whose key starts with a prefix.
     * @param {string} prefix Key prefix.
     * @returns {Object<string, string>} Raw stored values by key; empty when storage is unavailable.
     */
    entriesWithPrefix(prefix) {
      return Object.fromEntries(this.#keysWithPrefix(prefix).map(key => [key, this.read(key)]));
    }

    /**
     * Removes every stored entry whose key starts with a prefix, then stores the given entries.
     * @param {string} prefix Key prefix.
     * @param {Object<string, string>} entries Raw values by key.
     * @returns {void}
     */
    replaceEntriesWithPrefix(prefix, entries) {
      this.#keysWithPrefix(prefix).forEach(key => this.remove(key));
      Object.entries(entries).forEach(([key, value]) => this.write(key, value));
    }

    /**
     * Stored keys starting with a prefix.
     * @param {string} prefix Key prefix.
     * @returns {string[]} The keys; empty when storage is unavailable.
     */
    #keysWithPrefix(prefix) {
      try {
        return Object.keys(localStorage).filter(key => key.startsWith(prefix));
      } catch {
        return [];
      }
    }
  }

  /**
   * Latest known usage windows, from polling and from message_limit stream events.
   * @fires RateLimitMonitor#rateLimits The limits changed.
   */
  class RateLimitMonitor extends EventEmitter {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Creates the monitor.
     * @param {ClaudeApi} api API client.
     */
    constructor(api) {
      super();
      this.#api = api;
      this.limits = null;
    }

    /**
     * Polls now and then every TIMING.rateLimitPollMs.
     * @returns {void}
     */
    start() {
      this.#fetchLimits();
      setInterval(() => this.#fetchLimits(), TIMING.rateLimitPollMs);
    }

    /**
     * Replaces the known limits.
     * @param {RateLimits} limits New limits.
     * @returns {void}
     */
    setLimits(limits) {
      this.limits = limits;
      this.publish('rateLimits');
    }

    /**
     * Fetches the limits; on failure the last known values stay and the next poll retries.
     * @returns {Promise<void>} Resolves once fetched or failed.
     */
    async #fetchLimits() {
      try {
        this.setLimits(await this.#api.getUsage());
      } catch {
        return;
      }
    }
  }

  /**
   * Path of the new-chat page.
   * @type {string}
   */
  const NEW_CHAT_PATH = '/new';

  /**
   * Matches a conversation page path and captures the conversation id.
   * @type {RegExp}
   */
  const CHAT_PATH_PATTERN = /^\/chat\/([0-9a-f-]{36})/i;

  /**
   * Extracts the conversation id from a page path.
   * @param {string} pathname Path such as "/chat/<uuid>".
   * @returns {?string} The conversation id, or null when the path isn't a conversation page.
   */
  function conversationIdFromPath(pathname) {
    const match = pathname.match(CHAT_PATH_PATTERN);
    return match ? match[1] : null;
  }

  /**
   * Page path of a conversation.
   * @param {string} conversationId Conversation id.
   * @returns {string} The path.
   */
  function conversationPath(conversationId) {
    return `/chat/${conversationId}`;
  }

  /**
   * Keeps the URL in sync with the focused pane's conversation and handles back/forward navigation.
   */
  class Router {
    /**
     * Chat panes.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Creates the router.
     * @param {ChatPaneManager} paneManager Chat panes.
     */
    constructor(paneManager) {
      this.#paneManager = paneManager;
    }

    /**
     * Opens what the current URL points to in the focused pane and starts following navigation.
     * @returns {Promise<void>} Resolves once the conversation is shown.
     */
    async start() {
      window.addEventListener('popstate', () => this.#openFromUrl());
      this.#paneManager.subscribe('focus', () => this.#updateUrlToFocusedConversation());
      this.#paneManager.subscribe('paneConversations', paneId => this.#onPaneConversationChanged(paneId));
      await this.#openFromUrl();
    }

    /**
     * Opens a conversation in the focused pane as a user navigation, adding a history entry.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once the conversation is shown.
     */
    openConversation(conversationId) {
      if (conversationIdFromPath(location.pathname) !== conversationId) history.pushState(null, '', conversationPath(conversationId));
      return this.#paneManager.openInFocusedPane(conversationId);
    }

    /**
     * Makes the focused chat visible if another panel in its zone is covering it.
     * @returns {void}
     */
    revealFocusedChat() {
      this.#paneManager.revealFocusedPane();
    }

    /**
     * Reveals the focused pane and scrolls it to a message, if it's currently shown there.
     * @param {string} messageId Message id.
     * @returns {void}
     */
    scrollToMessage(messageId) {
      this.revealFocusedChat();
      this.#paneManager.focusedPanel.scrollToMessage(messageId);
    }

    /**
     * Starts a new chat in the focused pane as a user navigation, adding a history entry.
     * @returns {void}
     */
    startNewConversation() {
      if (location.pathname !== NEW_CHAT_PATH) history.pushState(null, '', NEW_CHAT_PATH);
      this.#paneManager.startNewInFocusedPane();
    }

    /**
     * Opens the conversation in the URL, or a new chat, in the focused pane.
     * @returns {Promise<void>} Resolves once a conversation is shown.
     */
    async #openFromUrl() {
      const conversationId = conversationIdFromPath(location.pathname);
      if (conversationId) await this.#paneManager.openInFocusedPane(conversationId);
      else this.#paneManager.startNewInFocusedPane();
    }

    /**
     * Follows conversation changes of the focused pane only.
     * @param {string} paneId Pane whose conversation changed.
     * @returns {void}
     */
    #onPaneConversationChanged(paneId) {
      if (paneId === this.#paneManager.focusedPaneId) this.#updateUrlToFocusedConversation();
    }

    /**
     * Points the URL at the focused pane's conversation, replacing the history entry rather than adding one.
     * @returns {void}
     */
    #updateUrlToFocusedConversation() {
      const openId = this.#paneManager.focusedSession.openConversationId;
      if (openId === conversationIdFromPath(location.pathname)) return;
      history.replaceState(null, '', openId ? conversationPath(openId) : NEW_CHAT_PATH);
    }
  }

  /**
   * Prefix shared by every localStorage key of this script; settings export and import cover
   * exactly the keys with this prefix.
   * @type {string}
   */
  const STORAGE_KEY_PREFIX = 'claudePlus.';

  /**
   * Exports all ClaudePlus settings (every localStorage entry of the script: preferences, panes,
   * layouts, table columns, sub-pane docking) to a JSON file and imports them back. The indexed
   * conversation cache is not included; it can be rebuilt with "Index full history".
   */
  class SettingsTransfer {
    /**
     * Format marker of exported files.
     * @type {string}
     */
    static #FORMAT = 'ClaudePlus settings';

    /**
     * Settings storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Creates the transfer.
     * @param {Preferences} preferences Settings storage.
     */
    constructor(preferences) {
      this.#preferences = preferences;
    }

    /**
     * Downloads every setting as "ClaudePlus settings <date>.json".
     * @returns {void}
     */
    exportSettings() {
      const exportedAt = new Date().toISOString();
      const document = { format: SettingsTransfer.#FORMAT, exportedAt, settings: this.#preferences.entriesWithPrefix(STORAGE_KEY_PREFIX) };
      downloadTextFile(`ClaudePlus settings ${exportedAt.slice(0, 10)}.json`, `${JSON.stringify(document, null, 2)}\n`, 'application/json');
    }

    /**
     * Lets the user pick an exported file and imports it.
     * @returns {void}
     */
    chooseFileAndImport() {
      const input = createElement('input', { type: 'file', accept: 'application/json,.json' });
      input.addEventListener('change', () => this.#importFile(input.files[0]));
      input.click();
    }

    /**
     * Reads an exported file, asks for confirmation, replaces all settings and reloads the page.
     * Invalid files are reported in a dialog and change nothing.
     * @param {?File} file The chosen file.
     * @returns {Promise<void>} Resolves once imported, declined or failed.
     */
    async #importFile(file) {
      if (!file) return;
      try {
        const settings = SettingsTransfer.#parseSettings(await file.text());
        if (!(await ConfirmDialog.ask('Replace all ClaudePlus settings with the imported ones? The page reloads afterwards.', 'Import'))) return;
        this.#preferences.replaceEntriesWithPrefix(STORAGE_KEY_PREFIX, settings);
        location.reload();
      } catch (error) {
        await AlertDialog.inform(`Import failed: ${error.message}`);
      }
    }

    /**
     * Validates an exported file and extracts its settings.
     * @param {string} text File content.
     * @returns {Object<string, string>} Settings by storage key; only ClaudePlus keys with string values.
     * @throws {Error} When the content isn't a ClaudePlus settings file.
     */
    static #parseSettings(text) {
      const parsed = JSON.parse(text);
      if (!parsed || parsed.format !== SettingsTransfer.#FORMAT || !parsed.settings || typeof parsed.settings !== 'object') throw new Error('this is not a ClaudePlus settings file');
      return Object.fromEntries(Object.entries(parsed.settings).filter(([key, value]) => key.startsWith(STORAGE_KEY_PREFIX) && typeof value === 'string'));
    }
  }

  /**
   * Field access for an ApiConversation, so callers never read its raw API field names directly.
   */
  class ApiConversationFields {
    /**
     * A conversation's id.
     * @param {ApiConversation} conversation The conversation.
     * @returns {string} Its id.
     */
    static id(conversation) {
      return conversation.uuid;
    }

    /**
     * When a conversation last changed.
     * @param {ApiConversation} conversation The conversation.
     * @returns {string} ISO timestamp of the last change.
     */
    static updatedAt(conversation) {
      return conversation.updated_at;
    }
  }

  /**
   * Version of the conversation summaries' content. A stored summary of another version is
   * recomputed the next time its conversation is indexed, opened, imported or reconciled, so a change
   * to what a summary contains reaches conversations whose own timestamp did not change.
   * @type {number}
   */
  const SUMMARY_VERSION = 2;

  /**
   * Adds to a counter in a count map, creating it at zero first.
   * @param {Object<string, number>} counts The count map; modified in place.
   * @param {string} key Counter to increase.
   * @param {number} amount Amount to add.
   * @returns {void}
   */
  function addToCount(counts, key, amount) {
    counts[key] = (counts[key] ?? 0) + amount;
  }

  /**
   * Estimates a token count from text length, at four characters per token. claude.ai doesn't
   * expose real token counts.
   * @param {?string} text The text.
   * @returns {number} Estimated tokens; 0 for empty text.
   */
  function estimateTokens(text) {
    return text ? Math.ceil(text.length / 4) : 0;
  }

  /**
   * Splits a URL's host into outlet (host without "www.") and top-level domain.
   * @param {string} url Absolute URL.
   * @returns {{outlet: ?string, topLevelDomain: ?string}} The parts; both null for an invalid URL.
   */
  function hostParts(url) {
    try {
      const outlet = new URL(url).hostname.replace(/^www\./, '');
      const labels = outlet.split('.');
      return { outlet, topLevelDomain: labels.length > 1 ? labels[labels.length - 1] : '' };
    } catch {
      return { outlet: null, topLevelDomain: null };
    }
  }

  /**
   * Computes a ConversationSummary from a full conversation.
   */
  class ConversationSummarizer {
    /**
     * Tools whose input describes a file Claude produced, mapped to how to read its path and title.
     * @type {Map<string, function(object): {path: string, title: ?string}>}
     */
    static #FILE_PRODUCING_TOOLS = new Map([
      ['create_file', input => ({ path: input.path || input.file_path || '', title: input.description })],
      ['Artifact', input => ({ path: input.file_path || '', title: input.title })],
    ]);

    /**
     * Summary being built.
     * @type {ConversationSummary}
     */
    #summary;

    /**
     * Creation time of the prompt awaiting an answer.
     * @type {?string}
     */
    #unansweredPromptTime = null;

    /**
     * Starts an empty summary.
     * @param {ApiConversation} conversation The conversation being summarized.
     * @param {boolean} isImported Whether it came from an imported data export rather than the live API.
     */
    constructor(conversation, isImported) {
      this.#summary = {
        conversationId: conversation.uuid,
        title: conversation.name || UNTITLED,
        updatedAt: conversation.updated_at,
        version: SUMMARY_VERSION,
        isImported,
        promptCount: 0,
        toolCallCounts: Object.create(null),
        toolCalls: [],
        sources: [],
        files: [],
        estimatedTokensIn: 0,
        estimatedTokensOut: 0,
        responseTimesMs: [],
      };
    }

    /**
     * Summarizes a conversation.
     * @param {ApiConversation} conversation The conversation, with every message.
     * @param {boolean} [isImported] Whether it came from an imported data export rather than the live API.
     * @returns {ConversationSummary} The summary.
     */
    static summarize(conversation, isImported = false) {
      const summarizer = new ConversationSummarizer(conversation, isImported);
      for (const message of conversation.chat_messages ?? []) summarizer.#addMessage(message);
      return summarizer.#summary;
    }

    /**
     * Adds one message; messages from other senders are ignored.
     * @param {ApiMessage} message The message.
     * @returns {void}
     */
    #addMessage(message) {
      if (message.sender === 'human') this.#addPrompt(message);
      else if (message.sender === 'assistant') this.#addReply(message);
    }

    /**
     * Counts a prompt, its estimated tokens and its uploads - not the quote-reply text file
     * claude.ai attaches when a message quotes part of an earlier one, which isn't a real upload.
     * @param {ApiMessage} message A human message.
     * @returns {void}
     */
    #addPrompt(message) {
      this.#summary.promptCount += 1;
      this.#summary.estimatedTokensIn += estimateTokens(MessageContent.plainText(message));
      this.#unansweredPromptTime = message.created_at;
      for (const upload of MessageContent.uploads(message)) {
        const name = MessageContent.uploadName(upload);
        if (QUOTE_ATTACHMENT_NAME_PATTERN.test(name)) continue;
        this.#summary.files.push({ path: name, title: name, timestamp: upload.created_at || message.created_at, source: 'user', messageId: message.uuid });
      }
    }

    /**
     * Counts a reply's estimated tokens, response time, tool calls, sources and produced files.
     * @param {ApiMessage} message An assistant message.
     * @returns {void}
     */
    #addReply(message) {
      this.#summary.estimatedTokensOut += estimateTokens(MessageContent.plainText(message));
      this.#recordResponseTime(message.created_at);
      const producedFilesByPath = new Map();
      for (const block of message.content ?? []) this.#addContentBlock(block, block.stop_timestamp || message.created_at, message.uuid, producedFilesByPath);
      this.#summary.files.push(...producedFilesByPath.values());
    }

    /**
     * Records the time since the unanswered prompt, if plausible, and clears it.
     * @param {string} answerTime Creation time of the answer.
     * @returns {void}
     */
    #recordResponseTime(answerTime) {
      if (!this.#unansweredPromptTime) return;
      const responseMs = toEpochMs(answerTime) - toEpochMs(this.#unansweredPromptTime);
      if (responseMs > 0 && responseMs < TIMING.maxResponseGapMs) this.#summary.responseTimesMs.push(responseMs);
      this.#unansweredPromptTime = null;
    }

    /**
     * Adds one content block of a reply.
     * @param {ContentBlock} block The block.
     * @param {string} blockTime Timestamp of the block.
     * @param {string} messageId Id of the message the block belongs to.
     * @param {Map<string, FileEntry>} producedFilesByPath Files produced by the reply, keyed by path; the last write wins.
     * @returns {void}
     */
    #addContentBlock(block, blockTime, messageId, producedFilesByPath) {
      if (block.type === 'tool_use') this.#addToolCall(block, blockTime, messageId, producedFilesByPath);
      else if (block.type === 'tool_result') this.#addToolResult(block, blockTime, messageId);
    }

    /**
     * Counts a tool call, records its occurrence and the file it produced, if any.
     * @param {ContentBlock} block A tool_use block.
     * @param {string} blockTime Timestamp of the block.
     * @param {string} messageId Id of the message the block belongs to.
     * @param {Map<string, FileEntry>} producedFilesByPath Files produced by the reply, keyed by path.
     * @returns {void}
     */
    #addToolCall(block, blockTime, messageId, producedFilesByPath) {
      const toolName = block.name || 'unknown_tool';
      addToCount(this.#summary.toolCallCounts, toolName, 1);
      this.#summary.toolCalls.push({ name: toolName, timestamp: blockTime, messageId });
      const describeFile = ConversationSummarizer.#FILE_PRODUCING_TOOLS.get(toolName);
      if (!describeFile || !block.input) return;
      const { path, title } = describeFile(block.input);
      producedFilesByPath.set(path, { path, title: title || lastPathSegment(path), timestamp: blockTime, source: 'claude', messageId });
    }

    /**
     * Records the web sources a tool result cites.
     * @param {ContentBlock} block A tool_result block.
     * @param {string} blockTime Timestamp of the block.
     * @param {string} messageId Id of the message the block belongs to.
     * @returns {void}
     */
    #addToolResult(block, blockTime, messageId) {
      const items = Array.isArray(block.content) ? block.content : [];
      for (const item of items.filter(ConversationSummarizer.#isWebSource)) {
        this.#summary.sources.push({ title: item.title, url: item.url, ...hostParts(item.url), timestamp: blockTime, messageId });
      }
    }

    /**
     * Whether a tool result item is a citable web source.
     * @param {?object} item The item.
     * @returns {boolean} True when it has a URL and a title.
     */
    static #isWebSource(item) {
      return Boolean(item && item.url && item.title);
    }
  }

  /**
   * Totals across every stored conversation summary.
   */
  class StatsAggregate {
    /**
     * Creates empty totals.
     */
    constructor() {
      this.conversationCount = 0;
      this.promptCount = 0;
      this.estimatedTokensIn = 0;
      this.estimatedTokensOut = 0;
      this.responseTimesMs = [];
      this.toolCallCounts = Object.create(null);
      this.outletCounts = Object.create(null);
      this.topLevelDomains = new Set();
      this.sources = [];
      this.folders = [];

      /**
       * Prompt and file counts by conversation id, for showing them as sidebar columns without
       * needing a separate lookup structure. Only conversations that have been indexed (opened, or
       * pulled in by a backfill) appear here.
       * @type {Map<string, {title: string, updatedAt: string, isImported: boolean, promptCount: number, fileCount: number, toolCalls: Array<{name: string, timestamp: string, messageId: string}>}>}
       */
      this.perConversation = new Map();

      /**
       * Stored records skipped because they didn't look valid.
       * @type {number}
       */
      this.skippedRecordCount = 0;
    }

    /**
     * Aggregates summaries. Sources end up newest first; folders most recently active first.
     * @param {ConversationSummary[]} summaries Stored summaries.
     * @returns {StatsAggregate} The totals.
     */
    static fromSummaries(summaries) {
      const aggregate = new StatsAggregate();
      summaries.forEach(summary => aggregate.#addSummary(summary));
      aggregate.sources.sort((first, second) => toEpochMs(second.timestamp) - toEpochMs(first.timestamp));
      aggregate.folders.sort((first, second) => second.newestFileTime - first.newestFileTime);
      return aggregate;
    }

    /**
     * Adds one conversation's summary.
     * @param {ConversationSummary} summary The summary.
     * @returns {void}
     */
    #addSummary(summary) {
      const origin = { conversationTitle: summary.title, conversationId: summary.conversationId, isImported: Boolean(summary.isImported) };
      this.conversationCount += 1;
      this.promptCount += summary.promptCount;
      this.estimatedTokensIn += summary.estimatedTokensIn;
      this.estimatedTokensOut += summary.estimatedTokensOut;
      this.responseTimesMs.push(...summary.responseTimesMs);
      this.#addToolCallCounts(summary.toolCallCounts);
      this.#addSources(summary.sources, origin);
      this.#addFolder(summary.files, origin);
      this.perConversation.set(summary.conversationId, {
        title: summary.title,
        updatedAt: summary.updatedAt,
        isImported: Boolean(summary.isImported),
        promptCount: summary.promptCount,
        fileCount: summary.files.length,
        toolCalls: summary.toolCalls ?? [],
      });
    }

    /**
     * Adds tool call counts.
     * @param {Object<string, number>} toolCallCounts Calls per tool name.
     * @returns {void}
     */
    #addToolCallCounts(toolCallCounts) {
      for (const [toolName, count] of Object.entries(toolCallCounts)) addToCount(this.toolCallCounts, toolName, count);
    }

    /**
     * Adds web sources and counts their outlets and top-level domains.
     * @param {SourceEntry[]} sources The sources.
     * @param {{conversationTitle: string, conversationId: string}} origin Conversation they came from.
     * @returns {void}
     */
    #addSources(sources, origin) {
      for (const source of sources) {
        this.sources.push({ ...source, ...origin });
        if (source.outlet) addToCount(this.outletCounts, source.outlet, 1);
        if (source.topLevelDomain) this.topLevelDomains.add(source.topLevelDomain);
      }
    }

    /**
     * Adds a conversation's files as one folder; conversations without files get none.
     * @param {FileEntry[]} files The files.
     * @param {{conversationTitle: string, conversationId: string}} origin Conversation they came from.
     * @returns {void}
     */
    #addFolder(files, origin) {
      if (files.length === 0) return;
      const entries = files.map(file => ({ ...file, ...origin, extension: fileExtension(file.title || file.path) }));
      this.folders.push({ ...origin, files: entries, newestFileTime: Math.max(...entries.map(entry => toEpochMs(entry.timestamp))) });
    }
  }

  /**
   * Checks that a record read from the stats cache has the shape this script writes, so a stale or
   * damaged record is skipped (and re-indexed later) instead of breaking the panels.
   */
  class SummaryValidator {
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

  /**
   * Per-conversation summaries cached in IndexedDB, plus their aggregate.
   * @fires StatsIndex#aggregate The aggregate was recomputed.
   * @fires StatsIndex#backfill Backfill progress changed.
   */
  class StatsIndex extends EventEmitter {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Summary cache.
     * @type {IndexedDbStore}
     */
    #database;

    /**
     * Current totals across every indexed conversation.
     * @type {StatsAggregate}
     */
    #aggregate = new StatsAggregate();

    /**
     * Current totals across only live conversations.
     * @type {StatsAggregate}
     */
    #liveAggregate = new StatsAggregate();

    /**
     * Current totals across only imported conversations.
     * @type {StatsAggregate}
     */
    #importedAggregate = new StatsAggregate();

    /**
     * Backfill state.
     * @type {BackfillProgress}
     */
    #backfill = { isRunning: false, processedCount: 0, totalCount: 0 };

    /**
     * Conversations stored during the running backfill.
     * @type {number}
     */
    #storedDuringBackfill = 0;

    /**
     * Creates the index.
     * @param {ClaudeApi} api API client.
     * @param {IndexedDbStore} database Summary cache.
     */
    constructor(api, database) {
      super();
      this.#api = api;
      this.#database = database;
    }

    /**
     * Current totals across every indexed conversation.
     * @returns {StatsAggregate} The aggregate.
     */
    get aggregate() {
      return this.#aggregate;
    }

    /**
     * Current totals across only live conversations.
     * @returns {StatsAggregate} The aggregate.
     */
    get liveAggregate() {
      return this.#liveAggregate;
    }

    /**
     * Current totals across only imported conversations.
     * @returns {StatsAggregate} The aggregate.
     */
    get importedAggregate() {
      return this.#importedAggregate;
    }

    /**
     * Backfill state.
     * @returns {BackfillProgress} A copy of the progress.
     */
    get backfill() {
      return { ...this.#backfill };
    }

    /**
     * Recomputes the aggregate from the cache, skipping records that don't look valid. Failures are
     * logged and keep the previous totals.
     * @returns {Promise<void>} Resolves once recomputed or failed.
     */
    async refreshAggregate() {
      try {
        const records = await this.#database.readAll(DATABASE.stores.conversationSummaries);
        const summaries = records.filter(record => SummaryValidator.isValid(record)).map(record => StatsIndex.#withoutQuoteFiles(record));
        this.#aggregate = StatsAggregate.fromSummaries(summaries);
        this.#aggregate.skippedRecordCount = records.length - summaries.length;
        this.#liveAggregate = StatsAggregate.fromSummaries(summaries.filter(summary => !summary.isImported));
        this.#importedAggregate = StatsAggregate.fromSummaries(summaries.filter(summary => summary.isImported));
        this.publish('aggregate');
      } catch (error) {
        console.warn(LOG_PREFIX, 'reading stats failed', error);
      }
    }

    /**
     * A summary without the quote-reply text files claude.ai attaches, which are not real files. New
     * summaries never contain them; this also cleans summaries stored before that was so, whatever
     * their conversation's version, so they never show up until the conversation is indexed again.
     * @param {ConversationSummary} summary A valid stored summary.
     * @returns {ConversationSummary} The summary, with its file list cleaned when it had such files.
     */
    static #withoutQuoteFiles(summary) {
      const files = summary.files.filter(file => !QUOTE_ATTACHMENT_NAME_PATTERN.test(file.path) && !QUOTE_ATTACHMENT_NAME_PATTERN.test(file.title));
      return files.length === summary.files.length ? summary : { ...summary, files };
    }

    /**
     * A conversation's cached summary, for a view scoped to just that conversation rather than the
     * whole aggregate.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<?ConversationSummary>} The summary, or null when it isn't indexed yet or
     * looks invalid.
     */
    async summaryFor(conversationId) {
      try {
        const summary = await this.#database.read(DATABASE.stores.conversationSummaries, conversationId);
        return SummaryValidator.isValid(summary) ? StatsIndex.#withoutQuoteFiles(summary) : null;
      } catch (error) {
        console.warn(LOG_PREFIX, 'reading a conversation summary failed', error);
        return null;
      }
    }

    /**
     * Stores a conversation's summary if it changed, then recomputes the aggregate. Failures are logged.
     * @param {ApiConversation} conversation The conversation.
     * @param {boolean} [isImported] Whether it came from an imported data export rather than the live API.
     * @returns {Promise<void>} Resolves once done.
     */
    async indexConversation(conversation, isImported = false) {
      try {
        if (await this.#storeSummaryIfOutdated(conversation, isImported)) await this.refreshAggregate();
      } catch (error) {
        console.warn(LOG_PREFIX, 'indexing conversation failed', error);
      }
    }

    /**
     * Stores an imported conversation's summary unconditionally, without recomputing the aggregate -
     * used while an import writes a conversation, so it is indexed the moment it is stored and an
     * interrupted import leaves nothing unindexed. The caller refreshes the aggregate once at the end.
     * Failures are logged.
     * @param {ApiConversation} conversation The conversation, shaped for the live pipeline.
     * @returns {Promise<void>} Resolves once stored or failed.
     */
    async storeImportedSummary(conversation) {
      try {
        await this.#database.write(DATABASE.stores.conversationSummaries, ConversationSummarizer.summarize(conversation, true));
      } catch (error) {
        console.warn(LOG_PREFIX, 'indexing an imported conversation failed', error);
      }
    }

    /**
     * Indexes every imported conversation whose summary is missing, damaged or of another version,
     * so imported chats are searchable and counted however they got stored (an interrupted import,
     * an import by an older version), then recomputes the aggregate once. Failures are logged.
     * @param {ConversationListing[]} listings The imported conversations' listings.
     * @param {function(string): Promise<?ApiConversation>} loadConversation Reads an imported conversation with its messages.
     * @returns {Promise<void>} Resolves once done.
     */
    async reindexImported(listings, loadConversation) {
      try {
        let storedCount = 0;
        for (const listing of listings) storedCount += await this.#reindexOneImported(listing, loadConversation);
        if (storedCount) await this.refreshAggregate();
      } catch (error) {
        console.warn(LOG_PREFIX, 'reindexing imported conversations failed', error);
      }
    }

    /**
     * Indexes one imported conversation if its summary is outdated, yielding to the browser first so
     * a long run never blocks the page.
     * @param {ConversationListing} listing The conversation's listing.
     * @param {function(string): Promise<?ApiConversation>} loadConversation Reads an imported conversation with its messages.
     * @returns {Promise<number>} 1 when a summary was stored, else 0.
     * @throws {DOMException} When the cache can't be read or written.
     */
    async #reindexOneImported(listing, loadConversation) {
      const conversationId = ConversationListingFields.id(listing);
      if (!(await this.#isOutdated(conversationId, ConversationListingFields.updatedAt(listing)))) return 0;
      await wait(0);
      const conversation = await loadConversation(conversationId);
      if (!conversation) return 0;
      await this.#database.write(DATABASE.stores.conversationSummaries, ConversationSummarizer.summarize(conversation, true));
      return 1;
    }

    /**
     * Removes a deleted conversation's summary, then recomputes the aggregate. Failures are logged.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once done.
     */
    async removeConversation(conversationId) {
      try {
        await this.#database.remove(DATABASE.stores.conversationSummaries, conversationId);
        await this.refreshAggregate();
      } catch (error) {
        console.warn(LOG_PREFIX, 'removing conversation stats failed', error);
      }
    }

    /**
     * Fetches and stores every conversation not yet cached at its current version. Ignored while
     * running; cancellable with cancelBackfill. Failures are logged.
     * @returns {Promise<void>} Resolves when finished, cancelled or failed.
     */
    async runBackfill() {
      if (this.#backfill.isRunning) return;
      this.#storedDuringBackfill = 0;
      this.#updateBackfill({ isRunning: true, processedCount: 0, totalCount: 0 });
      try {
        await this.#indexListings(await this.#listAllConversations());
      } catch (error) {
        console.warn(LOG_PREFIX, 'indexing history failed', error);
      } finally {
        this.#updateBackfill({ isRunning: false });
        await this.refreshAggregate();
      }
    }

    /**
     * Stops a running backfill after the conversation in progress.
     * @returns {void}
     */
    cancelBackfill() {
      if (this.#backfill.isRunning) this.#updateBackfill({ isRunning: false });
    }

    /**
     * Lists every conversation page by page; stops early when the backfill is cancelled.
     * @returns {Promise<ConversationListing[]>} The conversations.
     * @throws {ApiError} When a page can't be fetched.
     */
    async #listAllConversations() {
      const listings = [];
      for (let page = null; this.#shouldRequestNextPage(page); ) {
        page = await this.#api.listConversations(listings.length, LIMITS.backfillPageSize);
        listings.push(...page);
      }
      return listings;
    }

    /**
     * Whether another listing page should be requested.
     * @param {?ConversationListing[]} previousPage Previous page, or null before the first.
     * @returns {boolean} True before the first page, and while pages are full and the backfill runs.
     */
    #shouldRequestNextPage(previousPage) {
      return previousPage === null || (previousPage.length === LIMITS.backfillPageSize && this.#backfill.isRunning);
    }

    /**
     * Indexes listed conversations one at a time, reporting progress.
     * @param {ConversationListing[]} listings The conversations.
     * @returns {Promise<void>} Resolves when done or cancelled.
     * @throws {ApiError|DOMException} When fetching or storing fails.
     */
    async #indexListings(listings) {
      this.#updateBackfill({ totalCount: listings.length });
      for (const listing of listings) {
        if (!this.#backfill.isRunning) return;
        await this.#indexListing(listing);
        this.#updateBackfill({ processedCount: this.#backfill.processedCount + 1 });
      }
    }

    /**
     * Fetches and stores one conversation if its cached summary is outdated, refreshing the
     * aggregate every LIMITS.backfillRefreshInterval stored conversations.
     * @param {ConversationListing} listing The conversation.
     * @returns {Promise<void>} Resolves once done.
     * @throws {ApiError|DOMException} When fetching or storing fails.
     */
    async #indexListing(listing) {
      const listingId = ConversationListingFields.id(listing);
      if (!(await this.#isOutdated(listingId, ConversationListingFields.updatedAt(listing)))) return;
      await this.#storeSummaryIfOutdated(await this.#api.getConversation(listingId), false);
      this.#storedDuringBackfill += 1;
      if (this.#storedDuringBackfill % LIMITS.backfillRefreshInterval === 0) await this.refreshAggregate();
      await wait(TIMING.backfillPauseMs);
    }

    /**
     * Whether the cache lacks a conversation, holds another version of it or another summary
     * version, or holds a record that doesn't look valid.
     * @param {string} conversationId Conversation id.
     * @param {string} updatedAt Current version timestamp of the conversation.
     * @returns {Promise<boolean>} True when it must be (re)indexed.
     * @throws {DOMException} When the cache can't be read.
     */
    async #isOutdated(conversationId, updatedAt) {
      const summary = await this.#database.read(DATABASE.stores.conversationSummaries, conversationId);
      return !SummaryValidator.isValid(summary) || summary.updatedAt !== updatedAt || summary.version !== SUMMARY_VERSION;
    }

    /**
     * Stores a conversation's summary if the cached one is outdated.
     * @param {ApiConversation} conversation The conversation.
     * @param {boolean} isImported Whether it came from an imported data export rather than the live API.
     * @returns {Promise<boolean>} True if a summary was written.
     * @throws {DOMException} When the cache can't be read or written.
     */
    async #storeSummaryIfOutdated(conversation, isImported) {
      if (!(await this.#isOutdated(ApiConversationFields.id(conversation), ApiConversationFields.updatedAt(conversation)))) return false;
      await this.#database.write(DATABASE.stores.conversationSummaries, ConversationSummarizer.summarize(conversation, isImported));
      return true;
    }

    /**
     * Updates backfill progress and notifies listeners.
     * @param {Partial<BackfillProgress>} changes Fields to change.
     * @returns {void}
     */
    #updateBackfill(changes) {
      Object.assign(this.#backfill, changes);
      this.publish('backfill');
    }
  }

  /**
   * The key colors themeable in the Settings screen; every other color derives from the app's
   * built-in stylesheet. Each default is a plain hex color, so it can seed a native color input.
   * @type {ReadonlyArray<{key: string, cssVar: string, label: string, default: string}>}
   */
  const THEME_COLOR_FIELDS = Object.freeze([
    { key: 'background', cssVar: '--claude-plus-color-background', label: 'Background', default: '#1a1918' },
    { key: 'raised', cssVar: '--claude-plus-color-raised', label: 'Panels', default: '#262523' },
    { key: 'text', cssVar: '--claude-plus-color-text', label: 'Text', default: '#ececec' },
    { key: 'accent', cssVar: '--claude-plus-color-accent', label: 'Accent', default: '#d97757' },
  ]);

  /**
   * Whether a hex color reads as dark, by perceived brightness (the YIQ formula) rather than raw
   * component averages, so the answer matches what the eye actually sees.
   * @param {string} hexColor A color in "#rrggbb" form.
   * @returns {boolean} True when it reads as dark.
   */
  function isDarkColor(hexColor) {
    const red = Number.parseInt(hexColor.slice(1, 3), 16);
    const green = Number.parseInt(hexColor.slice(3, 5), 16);
    const blue = Number.parseInt(hexColor.slice(5, 7), 16);
    return (red * 299 + green * 587 + blue * 114) / 1000 < 128;
  }

  /**
   * The app's colors and fonts, stored as one JSON preference and applied as CSS custom properties
   * on the document root, so the built-in stylesheet (which already reads those properties) repaints
   * without any component needing to know theming exists.
   */
  class Theme {
    /**
     * Theme storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Creates the theme and applies whatever is currently stored (or the defaults).
     * @param {Preferences} preferences Theme storage.
     */
    constructor(preferences) {
      this.#preferences = preferences;
      this.apply();
    }

    /**
     * The current settings, filled in with defaults for anything not customized.
     * @returns {{colors: Object<string, string>, uiFontFamily: string, chatFontFamily: string}} The settings.
     */
    get settings() {
      const stored = this.#preferences.readJson(STORAGE_KEYS.theme) ?? {};
      const colors = Object.fromEntries(THEME_COLOR_FIELDS.map(field => [field.key, stored.colors?.[field.key] || field.default]));
      return { colors, uiFontFamily: stored.uiFontFamily || '', chatFontFamily: stored.chatFontFamily || '' };
    }

    /**
     * Stores new settings and applies them.
     * @param {{colors: Object<string, string>, uiFontFamily: string, chatFontFamily: string}} settings The settings.
     * @returns {void}
     */
    save(settings) {
      this.#preferences.writeJson(STORAGE_KEYS.theme, settings);
      this.apply();
    }

    /**
     * Clears every customization and reapplies the defaults.
     * @returns {void}
     */
    reset() {
      this.#preferences.remove(STORAGE_KEYS.theme);
      this.apply();
    }

    /**
     * Sets the CSS custom properties the stylesheet reads from the current settings.
     * @returns {void}
     */
    apply() {
      const { colors, uiFontFamily, chatFontFamily } = this.settings;
      const root = document.documentElement.style;
      THEME_COLOR_FIELDS.forEach(field => root.setProperty(field.cssVar, colors[field.key]));
      root.setProperty('--claude-plus-color-inactive-border', Theme.#inactiveBorderColor(colors.background));
      Theme.#setOrClear(root, '--claude-plus-font-family', uiFontFamily);
      Theme.#setOrClear(root, '--claude-plus-message-font-family', chatFontFamily);
    }

    /**
     * A faint border color that reads against the background: white on a dark background, black on
     * a light one, so an inactive chat pane's border stays visible whatever the theme.
     * @param {string} backgroundColor The current background color.
     * @returns {string} The border color.
     */
    static #inactiveBorderColor(backgroundColor) {
      return isDarkColor(backgroundColor) ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.16)';
    }

    /**
     * Sets a custom property to a value, or clears it back to the stylesheet's own default when blank.
     * @param {CSSStyleDeclaration} style The root element's inline style.
     * @param {string} cssVar Custom property name.
     * @param {string} value New value, or an empty string to clear it.
     * @returns {void}
     */
    static #setOrClear(style, cssVar, value) {
      if (value) style.setProperty(cssVar, value);
      else style.removeProperty(cssVar);
    }
  }

  /**
   * Asks for a line of text; the themed replacement of prompt(). Enter confirms.
   */
  class PromptDialog extends ActionDialog {
    /**
     * Label of the confirming button.
     * @type {string}
     */
    #confirmLabel;

    /**
     * The text input.
     * @type {HTMLInputElement}
     */
    #input;

    /**
     * Creates the dialog without showing it.
     * @param {string} message Question to show.
     * @param {string} initialValue Text the input starts with.
     * @param {string} confirmLabel Label of the confirming button.
     */
    constructor(message, initialValue, confirmLabel) {
      super(message);
      this.#confirmLabel = confirmLabel;
      this.#input = createElement('input', { type: 'text', className: 'claude-plus-dialog__input', value: initialValue });
      this.#input.addEventListener('keydown', event => {
        if (event.key === 'Enter') this.close(this.#input.value);
      });
    }

    /**
     * Asks for a line of text and waits for the answer.
     * @param {string} message Question to show.
     * @param {string} initialValue Text the input starts with.
     * @param {string} confirmLabel Label of the confirming button.
     * @returns {Promise<?string>} Resolves with the entered text, or null if cancelled.
     */
    static ask(message, initialValue, confirmLabel) {
      return new PromptDialog(message, initialValue, confirmLabel).show();
    }

    /**
     * A dismissed prompt yields no text.
     * @returns {null} Always null.
     */
    get cancelValue() {
      return null;
    }

    /**
     * Places the text input below the message.
     * @returns {HTMLElement[]} The input.
     */
    createBody() {
      return [this.#input];
    }

    /**
     * Builds the Cancel and confirming buttons.
     * @returns {HTMLButtonElement[]} The buttons.
     */
    createActions() {
      return [
        this.createClosingButton('Cancel', false, () => null),
        this.createClosingButton(this.#confirmLabel, true, () => this.#input.value),
      ];
    }

    /**
     * Focuses the input so typing starts right away.
     * @returns {void}
     */
    afterShow() {
      this.#input.focus();
    }
  }

  /**
   * The list of one hotkey group's commands in the settings: each with its chord, a button that
   * records a new chord from the next key press (Escape cancels, Backspace or Delete clears it),
   * and a button returning it to its default. A chord another command has is refused with a message.
   */
  class HotkeyEditor {
    /**
     * The bindings.
     * @type {Hotkeys}
     */
    #hotkeys;

    /**
     * The group's commands.
     * @type {HotkeyGroup}
     */
    #group;

    /**
     * Element the list is built into.
     * @type {HTMLElement}
     */
    #container;

    /**
     * Id of the command whose chord is being recorded, or null.
     * @type {?string}
     */
    #recordingId = null;

    /**
     * Text explaining why the last change was refused, or an empty string.
     * @type {string}
     */
    #message = '';

    /**
     * Builds the list and follows the bindings.
     * @param {object} parts What the editor works with.
     * @param {HTMLElement} parts.container Element the list is built into.
     * @param {Hotkeys} parts.hotkeys The bindings.
     * @param {HotkeyGroup} parts.group The group whose commands are listed.
     */
    constructor({ container, hotkeys, group }) {
      this.#container = container;
      this.#hotkeys = hotkeys;
      this.#group = group;
      container.addEventListener('click', event => this.#onClick(event));
      this.render();
    }

    /**
     * Shows every command with its chord.
     * @returns {void}
     */
    render() {
      const rows = this.#group.commands.map(command => this.#rowHtml(command)).join('');
      const list = rows || emptyStateHtml(`No ${this.#group.label} hotkeys yet.`);
      this.#container.innerHTML = `${list}<div class="claude-plus-settings-dialog__hotkey-message">${escapeHtml(this.#message)}</div>`;
    }

    /**
     * Stops recording, if a chord is being recorded.
     * @returns {void}
     */
    stopRecording() {
      window.removeEventListener('keydown', this.#onRecordedKey, true);
      this.#hotkeys.setRecording(false);
      this.#recordingId = null;
    }

    /**
     * HTML of one command's row.
     * @param {{id: string, label: string}} command The command.
     * @returns {string} The row.
     */
    #rowHtml(command) {
      const isRecording = this.#recordingId === command.id;
      const chordText = isRecording ? 'Press keys… (Esc cancels, Backspace clears)' : HotkeyChord.format(this.#hotkeys.chordOf(command.id));
      const resetButton = this.#hotkeys.isCustomized(command.id) ? '<button class="claude-plus-toolbar__button" data-action="reset">Reset</button>' : '';
      return `<div class="claude-plus-settings-dialog__layout-row" data-command-id="${escapeHtml(command.id)}">
      <span class="claude-plus-settings-dialog__layout-name">${escapeHtml(command.label)}</span>
      <button class="claude-plus-toolbar__button" data-action="record">${escapeHtml(chordText)}</button>
      ${resetButton}
    </div>`;
    }

    /**
     * Starts recording for, or resets, the command of the clicked row.
     * @param {MouseEvent} event The click in the list.
     * @returns {void}
     */
    #onClick(event) {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const commandId = button.closest('[data-command-id]').dataset.commandId;
      this.stopRecording();
      if (button.dataset.action === 'record') this.#startRecording(commandId);
      else this.#report(this.#hotkeys.reset(commandId));
      this.render();
    }

    /**
     * Records the next key press as the command's chord.
     * @param {string} commandId The command.
     * @returns {void}
     */
    #startRecording(commandId) {
      this.#recordingId = commandId;
      this.#message = '';
      this.#hotkeys.setRecording(true);
      window.addEventListener('keydown', this.#onRecordedKey, true);
    }

    /**
     * Takes the key press as the chord being recorded: Escape cancels, Backspace and Delete leave the
     * command without a chord, a lone modifier key waits for the rest of the chord.
     * @param {KeyboardEvent} event The key press.
     * @returns {void}
     */
    #onRecordedKey = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const chord = HotkeyChord.fromEvent(event);
      if (chord === null) return;
      const commandId = this.#recordingId;
      this.stopRecording();
      if (chord !== 'Escape') this.#report(this.#hotkeys.setChord(commandId, ['Backspace', 'Delete'].includes(chord) ? '' : chord));
      this.render();
    };

    /**
     * Remembers why a change was refused, for the message under the list.
     * @param {?{label: string}} conflict The command that already has the chord, or null when the change was made.
     * @returns {void}
     */
    #report(conflict) {
      this.#message = conflict ? `That key combination is already used by "${conflict.label}".` : '';
    }
  }

  /**
   * Optional categories of a data export: how to detect and count them in a classified result, their
   * count line's noun phrase, the toggle they show when present (null for a category with no opt-out,
   * like Artifacts), and the classified fields an unchecked toggle clears.
   * @type {ReadonlyArray<{isPresent: function(object): boolean, count: function(object): number, countNoun: string, toggleKey: ?string, toggleLabel: ?string, fields: string[]}>}
   */
  const IMPORT_OPTIONAL_CATEGORIES = Object.freeze([
    {
      isPresent: classified => classified.memoriesJsons.length > 0,
      count: classified => classified.memoriesJsons.flatMap(json => json.memory_files).length,
      countNoun: 'memory file(s)', toggleKey: 'memoryFiles', toggleLabel: 'Import memory files', fields: ['memoriesJsons'],
    },
    {
      isPresent: classified => classified.artifacts.length > 0,
      count: classified => classified.artifacts.length,
      countNoun: 'Artifact(s)', toggleKey: null, toggleLabel: null, fields: [],
    },
    {
      isPresent: classified => classified.projectsJsons.length > 0,
      count: classified => classified.projectsJsons.length,
      countNoun: 'Project(s)', toggleKey: 'projects', toggleLabel: 'Import Projects', fields: ['projectsJsons'],
    },
    {
      isPresent: classified => classified.feedbackJsons.length > 0,
      count: classified => classified.feedbackJsons.flatMap(json => json.reflections).length,
      countNoun: 'Feedback period(s)', toggleKey: 'feedbackPeriods', toggleLabel: 'Import Feedback/reflections', fields: ['feedbackJsons'],
    },
    {
      isPresent: classified => Boolean(classified.usersJson) || Boolean(classified.loginHistoryJson),
      count: classified => (classified.loginHistoryJson?.login_events.length ?? 0),
      countNoun: 'login event(s), plus the account profile', toggleKey: 'accountMetadata', toggleLabel: 'Import account profile and login history', fields: ['usersJson', 'loginHistoryJson'],
    },
  ]);

  /**
   * The import screen's opt-out checkboxes, one per optional category found in the export, and the
   * classified files they narrow down to what is actually imported.
   */
  class ImportCategoryToggles {
    /**
     * Element holding the checkboxes.
     * @type {HTMLElement}
     */
    #container;

    /**
     * Creates the toggles in a hidden container.
     * @param {HTMLElement} container Element holding the checkboxes.
     */
    constructor(container) {
      this.#container = container;
    }

    /**
     * Shows one checked toggle per toggleable category found.
     * @param {object} classified The classified files.
     * @returns {void}
     */
    show(classified) {
      this.#container.hidden = false;
      this.#container.innerHTML = IMPORT_OPTIONAL_CATEGORIES
        .filter(category => category.toggleKey && category.isPresent(classified))
        .map(category => `<label class="claude-plus-import-dialog__toggle"><input type="checkbox" data-category-toggle="${category.toggleKey}" checked /> ${escapeHtml(category.toggleLabel)}</label>`)
        .join('');
    }

    /**
     * Hides the toggles.
     * @returns {void}
     */
    hide() {
      this.#container.hidden = true;
    }

    /**
     * The classified files, with any unchecked category's data cleared.
     * @param {object} classified The classified files.
     * @returns {object} The classified files to actually import.
     */
    applyTo(classified) {
      const applied = { ...classified };
      IMPORT_OPTIONAL_CATEGORIES
        .filter(category => category.toggleKey && !this.#isChecked(category.toggleKey))
        .flatMap(category => category.fields)
        .forEach(field => { applied[field] = Array.isArray(applied[field]) ? [] : null; });
      return applied;
    }

    /**
     * Whether a toggle is checked; missing (not shown, since its category wasn't found) counts as
     * checked, since there's nothing for it to exclude.
     * @param {string} toggleKey The toggle's data-category-toggle value.
     * @returns {boolean} True when checked or absent.
     */
    #isChecked(toggleKey) {
      return this.#container.querySelector(`[data-category-toggle="${toggleKey}"]`)?.checked ?? true;
    }
  }

  /**
   * The import screen's file intake: a native multi-file picker behind a button, plus a drop zone
   * accepting the same files dragged in. Either way the files go to one callback.
   */
  class ImportFilePicker {
    /**
     * CSS class marking the drop zone while files are dragged over it.
     * @type {string}
     */
    static #ACTIVE_CLASS = 'claude-plus-import-dialog__drop-zone--active';

    /**
     * Area accepting dropped files.
     * @type {HTMLElement}
     */
    #dropZone;

    /**
     * Button opening the native picker.
     * @type {HTMLElement}
     */
    #chooseButton;

    /**
     * Called with the chosen or dropped files.
     * @type {function(File[]): Promise<void>}
     */
    #onFiles;

    /**
     * Creates the picker without wiring it.
     * @param {object} parts Picker parts.
     * @param {HTMLElement} parts.dropZone Area accepting dropped files.
     * @param {HTMLElement} parts.chooseButton Button opening the native picker.
     * @param {function(File[]): Promise<void>} parts.onFiles Called with the chosen or dropped files.
     */
    constructor({ dropZone, chooseButton, onFiles }) {
      this.#dropZone = dropZone;
      this.#chooseButton = chooseButton;
      this.#onFiles = onFiles;
    }

    /**
     * Wires the choose button and the drop zone.
     * @returns {void}
     */
    install() {
      const dropZone = this.#dropZone;
      this.#chooseButton.addEventListener('click', () => this.#chooseFiles());
      dropZone.addEventListener('dragover', event => ImportFilePicker.#onDragOver(event));
      dropZone.addEventListener('dragenter', () => dropZone.classList.add(ImportFilePicker.#ACTIVE_CLASS));
      dropZone.addEventListener('dragleave', event => this.#onDragLeave(event));
      dropZone.addEventListener('drop', event => this.#onDrop(event));
    }

    /**
     * Allows a drop by preventing the browser's default (opening the file instead of dropping it).
     * @param {DragEvent} event The drag-over.
     * @returns {void}
     */
    static #onDragOver(event) {
      event.preventDefault();
    }

    /**
     * Clears the drop zone's active styling once the drag actually leaves it, ignoring the events
     * fired for merely entering a child element.
     * @param {DragEvent} event The drag-leave.
     * @returns {void}
     */
    #onDragLeave(event) {
      if (!this.#dropZone.contains(event.relatedTarget)) this.#dropZone.classList.remove(ImportFilePicker.#ACTIVE_CLASS);
    }

    /**
     * Hands the files dropped onto the drop zone over, the same as if they'd been chosen.
     * @param {DragEvent} event The drop.
     * @returns {Promise<void>} Resolves once the dropped files are handled.
     */
    #onDrop(event) {
      event.preventDefault();
      this.#dropZone.classList.remove(ImportFilePicker.#ACTIVE_CLASS);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length) return this.#onFiles(files);
      return Promise.resolve();
    }

    /**
     * Opens a native multi-file picker and hands whatever was selected over.
     * @returns {void}
     */
    #chooseFiles() {
      const input = createElement('input', { type: 'file', multiple: true, accept: 'application/json,.json,.html' });
      input.addEventListener('change', () => this.#onFiles([...input.files]));
      input.click();
    }
  }

  /**
   * Label shown for each classification of a previewed conversation.
   * @type {Readonly<Record<string, string>>}
   */
  const CLASSIFICATION_LABELS = Object.freeze({ new: 'New', changed: 'Changed', renamedOnly: 'Renamed', unchanged: 'Unchanged' });

  /**
   * HTML of a classification badge.
   * @param {string} classification The classification.
   * @returns {string} The badge.
   */
  function statusBadgeHtml(classification) {
    const label = CLASSIFICATION_LABELS[classification] ?? classification;
    return `<span class="claude-plus-import-dialog__badge claude-plus-import-dialog__badge--${escapeHtml(classification)}">${escapeHtml(label)}</span>`;
  }

  /**
   * The import review table's columns: a selection checkbox, then name, date, turns and status.
   * @param {function(string): boolean} isSelected Whether a conversation id is currently selected.
   * @returns {TableColumn[]} The columns.
   */
  function importReviewColumns(isSelected) {
    return [
      { id: 'selected', label: '', isAlwaysVisible: true, isNotSortable: true, sortValue: () => 0, cellHtml: row => `<input type="checkbox" data-select-row${isSelected(row.conversationId) ? ' checked' : ''} />` },
      { id: 'name', label: 'Name', isAlwaysVisible: true, filter: 'values', sortValue: row => (row.title || '').toLowerCase(), filterValue: row => row.title || UNTITLED, cellHtml: row => escapeHtml(row.title || UNTITLED) },
      createDateColumn(row => row.updatedAt),
      { id: 'turns', label: 'Turns', isVisibleByDefault: true, sortValue: row => row.promptCount, cellHtml: row => String(row.promptCount) },
      { id: 'status', label: 'Status', isVisibleByDefault: true, filter: 'values', sortValue: row => row.classification, filterValue: row => CLASSIFICATION_LABELS[row.classification], cellHtml: row => statusBadgeHtml(row.classification) },
    ];
  }

  /**
   * The import screen's conversation review table: every previewed conversation, sortable and
   * filterable, each with a checkbox. The selection is kept outside the table itself so it survives
   * re-sorting and re-filtering.
   */
  class ImportReviewTable {
    /**
     * Rows pre-checked by default: every classification except a truly unchanged conversation.
     * @type {ReadonlySet<string>}
     */
    static #DEFAULT_SELECTED_CLASSIFICATIONS = new Set(['new', 'changed', 'renamedOnly']);

    /**
     * Element the table is built in.
     * @type {HTMLElement}
     */
    #host;

    /**
     * Row holding the select all / none buttons.
     * @type {HTMLElement}
     */
    #selectionRow;

    /**
     * Table settings storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Called whenever the selection changes.
     * @type {function(): void}
     */
    #onSelectionChange;

    /**
     * The previewed conversation rows.
     * @type {object[]}
     */
    #rows = [];

    /**
     * Ids of the conversations currently checked for import.
     * @type {Set<string>}
     */
    #selectedIds = new Set();

    /**
     * The table, once shown.
     * @type {?ColumnTable}
     */
    #table = null;

    /**
     * Wires the select all / none buttons; the table itself is built by show().
     * @param {object} parts Table parts.
     * @param {HTMLElement} parts.host Element the table is built in.
     * @param {HTMLElement} parts.selectionRow Row holding the select all / none buttons.
     * @param {HTMLElement} parts.selectAllButton Button selecting every conversation.
     * @param {HTMLElement} parts.selectNoneButton Button deselecting every conversation.
     * @param {Preferences} parts.preferences Table settings storage.
     * @param {function(): void} parts.onSelectionChange Called whenever the selection changes.
     */
    constructor({ host, selectionRow, selectAllButton, selectNoneButton, preferences, onSelectionChange }) {
      this.#host = host;
      this.#selectionRow = selectionRow;
      this.#preferences = preferences;
      this.#onSelectionChange = onSelectionChange;
      selectAllButton.addEventListener('click', () => this.#setAllSelected(true));
      selectNoneButton.addEventListener('click', () => this.#setAllSelected(false));
    }

    /**
     * Ids of the conversations currently checked for import.
     * @returns {Set<string>} The ids.
     */
    get selectedIds() {
      return this.#selectedIds;
    }

    /**
     * Shows the table with a smart default selection.
     * @param {object[]} rows The previewed conversation rows.
     * @returns {void}
     */
    show(rows) {
      this.#rows = rows;
      this.#selectedIds = new Set(rows.filter(row => ImportReviewTable.#DEFAULT_SELECTED_CLASSIFICATIONS.has(row.classification)).map(row => row.conversationId));
      this.#selectionRow.hidden = false;
      this.#host.hidden = false;
      this.#table = this.#createTable();
      this.#table.setRows(rows);
    }

    /**
     * Hides the table and its selection buttons.
     * @returns {void}
     */
    hide() {
      this.#selectionRow.hidden = true;
      this.#host.hidden = true;
    }

    /**
     * Builds the column table and listens to its row checkboxes.
     * @returns {ColumnTable} The table.
     */
    #createTable() {
      const table = new ColumnTable({
        container: this.#host,
        tableId: 'importReview',
        columns: importReviewColumns(conversationId => this.#selectedIds.has(conversationId)),
        preferences: this.#preferences,
        defaultSort: { column: 'date', direction: -1 },
        rowAttributes: row => `data-conversation-id="${escapeHtml(row.conversationId)}"`,
        emptyText: 'No conversations found.',
        maxRenderedRows: 2000,
      });
      table.bodyElement.addEventListener('change', event => this.#onRowCheckboxChange(event));
      return table;
    }

    /**
     * Records a row's checkbox change.
     * @param {Event} event Change of a row checkbox.
     * @returns {void}
     */
    #onRowCheckboxChange(event) {
      const checkbox = event.target.closest('[data-select-row]');
      if (!checkbox) return;
      const conversationId = checkbox.closest('[data-conversation-id]').dataset.conversationId;
      if (checkbox.checked) this.#selectedIds.add(conversationId);
      else this.#selectedIds.delete(conversationId);
      this.#onSelectionChange();
    }

    /**
     * Selects or deselects every previewed conversation, then re-renders the table so its checkboxes
     * reflect the change.
     * @param {boolean} selected Whether every conversation should be selected.
     * @returns {void}
     */
    #setAllSelected(selected) {
      this.#selectedIds = selected ? new Set(this.#rows.map(row => row.conversationId)) : new Set();
      this.#table?.setRows(this.#rows);
      this.#onSelectionChange();
    }
  }

  /**
   * HTML summarizing how many of each category a scanned export holds, plus notes on the
   * conversations left out of the review table.
   * @param {object} preview A previewClassified() result.
   * @param {object[]} preview.conversationRows The previewed conversation rows.
   * @param {object} preview.classified The classified files.
   * @param {number} preview.failedCount Conversations that couldn't be read at all.
   * @param {number} preview.emptySkippedCount Conversations with no readable content, left out on purpose.
   * @returns {string} The summary.
   */
  function importFoundSummaryHtml({ conversationRows, classified, failedCount, emptySkippedCount }) {
    const present = IMPORT_OPTIONAL_CATEGORIES.filter(category => category.isPresent(classified));
    const lines = [`${conversationRows.length} conversation(s)`, ...present.map(category => `${category.count(classified)} ${category.countNoun}`)];
    const emptyLine = emptySkippedCount > 0 ? `<p class="claude-plus-import-dialog__file-count">${emptySkippedCount} conversation(s) with no readable content (deleted, or never really started) aren't shown below.</p>` : '';
    const failedLine = failedCount > 0 ? `<p class="claude-plus-import-dialog__warning">${failedCount} conversation(s) couldn't be read and are not shown below - see the browser console for details.</p>` : '';
    return `<p class="claude-plus-import-dialog__file-count">Found: ${lines.join(', ')}.</p>${emptyLine}${failedLine}`;
  }

  /**
   * HTML summarizing what an import wrote.
   * @param {object} result The orchestrator's apply() result.
   * @returns {string} The summary.
   */
  function importResultHtml(result) {
    const { conversations } = result;
    const lines = [
      `${conversations.new} brand-new conversation(s) saved`,
      `${conversations.changed} already-imported conversation(s) got new messages (a continuation or branch since last time)`,
      `${conversations.renamedOnly} already-imported conversation(s) were only renamed`,
      `${conversations.unchanged} already-imported conversation(s) had nothing new`,
      conversations.failed > 0 ? `${conversations.failed} selected conversation(s) failed to import - see the browser console for details` : null,
      `${result.memoryFiles.written} of ${result.memoryFiles.total} memory file(s) saved`,
      `${result.artifacts.written} of ${result.artifacts.total} Artifact(s) saved`,
      `${result.projects.written} of ${result.projects.total} Project(s) saved`,
      `${result.feedbackPeriods.written} of ${result.feedbackPeriods.total} Feedback period(s) saved`,
      `${result.loginEvents.written} of ${result.loginEvents.total} login event(s) saved`,
      result.accountProfile ? 'Account profile saved' : null,
    ].filter(Boolean);
    return `<p><strong>Import complete.</strong></p><ul class="claude-plus-import-dialog__detection-list">${lines.map(line => `<li>${line}</li>`).join('')}</ul>`;
  }

  var stylesheet$3 = ".claude-plus-import-overlay {\n  position: fixed;\n  inset: 0;\n  z-index: var(--claude-plus-layer-drag-label);\n  background: rgba(0, 0, 0, 0.5);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n\n.claude-plus-import-dialog {\n  background: var(--claude-plus-color-raised);\n  border: 1px solid var(--claude-plus-color-border-strong);\n  border-radius: 8px;\n  padding: 16px;\n  width: 720px;\n  max-width: 90vw;\n  height: 85vh;\n  box-sizing: border-box;\n  font-size: 13px;\n  display: flex;\n  flex-direction: column;\n  gap: 0;\n}\n\n.claude-plus-import-dialog__header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-bottom: 8px;\n  flex-shrink: 0;\n}\n\n.claude-plus-import-dialog__header h2 {\n  margin: 0;\n  font-size: 15px;\n}\n\n.claude-plus-import-dialog__row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin: 12px 0;\n  flex-shrink: 0;\n}\n\n.claude-plus-import-dialog__drop-zone {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 8px;\n  margin: 12px 0;\n  padding: 16px;\n  flex-shrink: 0;\n  border: 1px dashed var(--claude-plus-color-border-strong);\n  border-radius: 8px;\n  color: var(--claude-plus-color-text-muted);\n  font-size: 12px;\n}\n\n.claude-plus-import-dialog__drop-zone--active {\n  border-color: var(--claude-plus-color-accent);\n  background: var(--claude-plus-color-tool-details);\n}\n\n.claude-plus-import-dialog__file-count {\n  color: var(--claude-plus-color-text-muted);\n  margin: 0 0 4px;\n}\n\n.claude-plus-import-dialog__detection-list {\n  margin: 0;\n  padding-left: 18px;\n}\n\n.claude-plus-import-dialog__progress {\n  color: var(--claude-plus-color-text-muted);\n  font-style: italic;\n}\n\n.claude-plus-import-dialog__warning {\n  color: var(--claude-plus-color-danger, #d9534f);\n  margin: 4px 0 0;\n}\n\n.claude-plus-import-dialog__categories {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  flex-shrink: 0;\n  margin-bottom: 4px;\n}\n\n.claude-plus-import-dialog__toggle {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  font-size: 12px;\n  color: var(--claude-plus-color-text-muted);\n  cursor: pointer;\n}\n\n.claude-plus-import-dialog__table-host {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n}\n\n.claude-plus-import-dialog__badge {\n  display: inline-block;\n  padding: 1px 8px;\n  border-radius: 10px;\n  font-size: 11px;\n  white-space: nowrap;\n}\n\n.claude-plus-import-dialog__badge--new {\n  background: var(--claude-plus-color-accent);\n  color: var(--claude-plus-color-on-accent, #fff);\n}\n\n.claude-plus-import-dialog__badge--changed {\n  background: var(--claude-plus-color-tool-details);\n  color: var(--claude-plus-color-text);\n}\n\n.claude-plus-import-dialog__badge--renamedOnly {\n  background: var(--claude-plus-color-bar);\n  color: var(--claude-plus-color-text-muted);\n  border: 1px solid var(--claude-plus-color-border-strong);\n}\n\n.claude-plus-import-dialog__badge--unchanged {\n  background: transparent;\n  color: var(--claude-plus-color-text-faint);\n  border: 1px solid var(--claude-plus-color-border);\n}\n";

  StyleRegistry.register(stylesheet$3);

  /**
   * Imports a claude.ai data export: the user selects the files they extracted (conversations.json
   * is required; memories, Artifact, Project and account files are each independently optional, and
   * detected by content, not filename), reviews every conversation found and the other categories as
   * simple toggles, then imports. Nothing is written until Import is clicked. conversations.json is
   * never read whole into memory: it's classified from a small prefix, previewed and imported by
   * streaming through it (see StreamingJsonArrayReader/ImportOrchestrator), so a real export's file -
   * routinely hundreds of megabytes - never blocks the tab or is held whole either way.
   */
  class ImportDialog extends Dialog {
    /**
     * Runs the import once files are confirmed.
     * @type {ImportOrchestrator}
     */
    #orchestrator;

    /**
     * Table settings storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Called once an import has actually written anything, so the Chats list can refresh.
     * @type {function(): void}
     */
    #onImported;

    /**
     * The dialog's named elements, set once the content is built.
     * @type {?Object<string, HTMLElement>}
     */
    #elements = null;

    /**
     * A previewClassified() result, once scanning has finished.
     * @type {?object}
     */
    #preview = null;

    /**
     * Opt-out checkboxes of the optional categories; set once the content is built.
     * @type {?ImportCategoryToggles}
     */
    #toggles = null;

    /**
     * The conversation review table; set once the content is built.
     * @type {?ImportReviewTable}
     */
    #reviewTable = null;

    /**
     * Creates the dialog without showing it.
     * @param {ImportOrchestrator} orchestrator Runs the import once files are confirmed.
     * @param {Preferences} preferences Table settings storage.
     * @param {function(): void} onImported Called once an import has actually written anything.
     */
    constructor(orchestrator, preferences, onImported) {
      super();
      this.#orchestrator = orchestrator;
      this.#preferences = preferences;
      this.#onImported = onImported;
    }

    /**
     * Opens the import screen.
     * @param {ImportOrchestrator} orchestrator Runs the import once files are confirmed.
     * @param {Preferences} preferences Table settings storage.
     * @param {function(): void} onImported Called once an import has actually written anything.
     * @returns {Promise<void>} Resolves once closed.
     */
    static open(orchestrator, preferences, onImported) {
      return new ImportDialog(orchestrator, preferences, onImported).show();
    }

    /**
     * CSS class of the dimmed overlay centering the screen.
     * @returns {string} The class name.
     */
    get overlayClassName() {
      return 'claude-plus-import-overlay';
    }

    /**
     * Builds the screen and its parts.
     * @returns {HTMLElement[]} The screen.
     */
    createContent() {
      const box = createElement('div', { className: 'claude-plus-import-dialog', innerHTML: ImportDialog.#bodyHtml() });
      const elements = collectNamedElements(box);
      this.#elements = elements;
      this.#toggles = new ImportCategoryToggles(elements.categories);
      this.#reviewTable = new ImportReviewTable({
        host: elements.tableHost, selectionRow: elements.selectionRow, selectAllButton: elements.selectAllButton, selectNoneButton: elements.selectNoneButton,
        preferences: this.#preferences, onSelectionChange: () => this.#refreshImportButton(),
      });
      new ImportFilePicker({ dropZone: elements.dropZone, chooseButton: elements.chooseButton, onFiles: files => this.#onFilesChosen(files) }).install();
      elements.closeButton.addEventListener('click', () => this.close());
      elements.importButton.addEventListener('click', () => this.#runImport());
      return [box];
    }

    /**
     * The screen's static markup.
     * @returns {string} The HTML.
     */
    static #bodyHtml() {
      return `
      <div class="claude-plus-import-dialog__header">
        <h2>Import chat export</h2>
        <button class="claude-plus-toolbar__close-button" data-name="closeButton" title="Close">✕</button>
      </div>
      <p>Select the files you extracted from claude.ai's "Export my data" download: conversations.json is required; memory, Artifact, Project and account files are each optional and detected automatically.</p>
      <div class="claude-plus-import-dialog__drop-zone" data-name="dropZone">
        <button class="claude-plus-toolbar__button" data-name="chooseButton">Choose files…</button>
        <span>or drag and drop them here</span>
      </div>
      <div data-name="status"></div>
      <div class="claude-plus-import-dialog__categories" data-name="categories" hidden></div>
      <div class="claude-plus-import-dialog__row" data-name="selectionRow" hidden>
        <button class="claude-plus-toolbar__button" data-name="selectAllButton">Select all</button>
        <button class="claude-plus-toolbar__button" data-name="selectNoneButton">Select none</button>
      </div>
      <div class="claude-plus-import-dialog__table-host" data-name="tableHost" hidden></div>
      <div class="claude-plus-import-dialog__row">
        <button class="claude-plus-primary-button" data-name="importButton" disabled>Import</button>
      </div>`;
    }

    /**
     * Classifies the chosen files, then previews every conversation found; reports progress as it
     * streams, since a large export can take a while to scan.
     * @param {File[]} files The chosen files.
     * @returns {Promise<void>} Resolves once the review table is shown or a failure is reported.
     */
    async #onFilesChosen(files) {
      this.#elements.importButton.disabled = true;
      this.#showProgress(`Scanning ${files.length} file(s)…`);
      try {
        this.#preview = await this.#orchestrator.previewClassified(files, count => this.#showProgress(`Scanning… ${count} conversation(s) found so far.`));
        this.#showReview();
      } catch (error) {
        this.#showProgress(error.message);
      }
    }

    /**
     * Shows the category summary and toggles and the conversation review table, and enables Import.
     * @returns {void}
     */
    #showReview() {
      this.#elements.status.innerHTML = importFoundSummaryHtml(this.#preview);
      this.#toggles.show(this.#preview.classified);
      this.#reviewTable.show(this.#preview.conversationRows);
      this.#refreshImportButton();
    }

    /**
     * Updates the Import button's label with the current selection count.
     * @returns {void}
     */
    #refreshImportButton() {
      this.#elements.importButton.textContent = `Import selected (${this.#reviewTable.selectedIds.size})`;
      this.#elements.importButton.disabled = false;
    }

    /**
     * Runs the import over the current selection, shows progress while it writes, then the result.
     * @returns {Promise<void>} Resolves once the result is shown or a failure is reported.
     */
    async #runImport() {
      this.#elements.importButton.disabled = true;
      this.#showProgress('Importing…');
      try {
        const classified = this.#toggles.applyTo(this.#preview.classified);
        const result = await this.#orchestrator.apply(classified, this.#preview.artifactRecords, this.#reviewTable.selectedIds, count => this.#showProgress(`Importing… scanned ${count} conversation(s) so far.`));
        this.#showResult(result);
        this.#onImported();
      } catch (error) {
        await AlertDialog.inform(`Import failed: ${error.message}`);
        this.#refreshImportButton();
      }
    }

    /**
     * Replaces the status line with a progress or failure message.
     * @param {string} text The message.
     * @returns {void}
     */
    #showProgress(text) {
      this.#elements.status.innerHTML = `<p class="claude-plus-import-dialog__progress">${escapeHtml(text)}</p>`;
    }

    /**
     * Replaces the screen with the result summary.
     * @param {object} result The orchestrator's apply() result.
     * @returns {void}
     */
    #showResult(result) {
      this.#elements.status.innerHTML = importResultHtml(result);
      this.#toggles.hide();
      this.#reviewTable.hide();
      this.#elements.chooseButton.hidden = true;
      this.#elements.importButton.hidden = true;
    }
  }

  var stylesheet$2 = ".claude-plus-settings-overlay {\n  position: fixed;\n  inset: 0;\n  z-index: var(--claude-plus-layer-drag-label);\n  background: rgba(0, 0, 0, 0.5);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n\n.claude-plus-settings-dialog {\n  background: var(--claude-plus-color-raised);\n  border: 1px solid var(--claude-plus-color-border-strong);\n  border-radius: 8px;\n  padding: 16px;\n  width: 420px;\n  max-width: 90vw;\n  max-height: 85vh;\n  overflow-y: auto;\n  font-size: 13px;\n}\n\n.claude-plus-settings-dialog__header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-bottom: 8px;\n}\n\n.claude-plus-settings-dialog__header h2 {\n  margin: 0;\n  font-size: 15px;\n}\n\n.claude-plus-settings-dialog__tabs {\n  display: flex;\n  gap: 4px;\n  margin-bottom: 8px;\n  border-bottom: 1px solid var(--claude-plus-color-border);\n}\n\n.claude-plus-settings-dialog__tab {\n  background: none;\n  border: none;\n  border-bottom: 2px solid transparent;\n  color: var(--claude-plus-color-text-muted);\n  cursor: pointer;\n  font: inherit;\n  padding: 6px 10px;\n}\n\n.claude-plus-settings-dialog__tab:hover {\n  color: var(--claude-plus-color-text);\n}\n\n.claude-plus-settings-dialog__tab--active {\n  color: var(--claude-plus-color-text);\n  border-bottom-color: var(--claude-plus-color-accent);\n}\n\n.claude-plus-settings-dialog__section {\n  padding: 12px 0;\n  border-top: 1px solid var(--claude-plus-color-border);\n}\n\n.claude-plus-settings-dialog__section:first-of-type {\n  border-top: none;\n}\n\n.claude-plus-settings-dialog__section h3 {\n  margin: 0 0 8px;\n  font-size: 12px;\n  text-transform: uppercase;\n  letter-spacing: 0.04em;\n  color: var(--claude-plus-color-text-muted);\n}\n\n.claude-plus-settings-dialog__row {\n  display: flex;\n  gap: 8px;\n  flex-wrap: wrap;\n}\n\n.claude-plus-settings-dialog__layout-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 6px 0;\n}\n\n.claude-plus-settings-dialog__layout-name {\n  flex: 1;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.claude-plus-settings-dialog__colors {\n  display: flex;\n  gap: 14px;\n  flex-wrap: wrap;\n  margin-bottom: 12px;\n}\n\n.claude-plus-settings-dialog__color-field {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 4px;\n  font-size: 12px;\n  color: var(--claude-plus-color-text-muted);\n}\n\n.claude-plus-settings-dialog__color-field input[type='color'] {\n  width: 36px;\n  height: 28px;\n  padding: 0;\n  border: 1px solid var(--claude-plus-color-border-strong);\n  border-radius: 6px;\n  background: none;\n  cursor: pointer;\n}\n\n.claude-plus-settings-dialog__field {\n  display: block;\n  margin-bottom: 10px;\n  font-size: 12px;\n  color: var(--claude-plus-color-text-muted);\n}\n\n.claude-plus-settings-dialog__field input[type='text'] {\n  display: block;\n  width: 100%;\n  box-sizing: border-box;\n  margin-top: 4px;\n  padding: 6px 8px;\n  background: var(--claude-plus-color-bar);\n  border: 1px solid var(--claude-plus-color-border-strong);\n  border-radius: 6px;\n  color: var(--claude-plus-color-text);\n  font: inherit;\n}\n\n.claude-plus-settings-dialog__hotkey-message {\n  min-height: 1em;\n  color: var(--claude-plus-color-error);\n  font-size: 12px;\n}\n";

  StyleRegistry.register(stylesheet$2);

  /**
   * The Settings screen: saved layouts, settings import/export and a small theming section (key
   * colors and the interface/chat fonts). Theme changes apply live as they're made; there is no
   * separate save step for them.
   */
  class SettingsDialog extends Dialog {
    /**
     * Saved layouts.
     * @type {LayoutLibrary}
     */
    #layoutLibrary;

    /**
     * Settings export and import.
     * @type {SettingsTransfer}
     */
    #settingsTransfer;

    /**
     * Colors and fonts.
     * @type {Theme}
     */
    #theme;

    /**
     * Runs a data-export import.
     * @type {ImportOrchestrator}
     */
    #importOrchestrator;

    /**
     * Import review table settings storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Called once an import has actually written anything.
     * @type {function(): void}
     */
    #onImported;

    /**
     * Hotkey bindings.
     * @type {Hotkeys}
     */
    #hotkeys;

    /**
     * The hotkey lists, one per group, set once the content is built.
     * @type {HotkeyEditor[]}
     */
    #hotkeyEditors = [];

    /**
     * The dialog's named elements, set once the content is built.
     * @type {?Object<string, HTMLElement>}
     */
    #elements = null;

    /**
     * Creates the dialog without showing it.
     * @param {object} services What the dialog works with.
     * @param {LayoutLibrary} services.layoutLibrary Saved layouts.
     * @param {SettingsTransfer} services.settingsTransfer Settings export and import.
     * @param {Theme} services.theme Colors and fonts.
     * @param {ImportOrchestrator} services.importOrchestrator Runs a data-export import.
     * @param {Preferences} services.preferences Import review table settings storage.
     * @param {Hotkeys} services.hotkeys Hotkey bindings.
     * @param {function(): void} services.onImported Called once an import has actually written anything.
     */
    constructor({ layoutLibrary, settingsTransfer, theme, importOrchestrator, preferences, hotkeys, onImported }) {
      super();
      this.#layoutLibrary = layoutLibrary;
      this.#settingsTransfer = settingsTransfer;
      this.#theme = theme;
      this.#importOrchestrator = importOrchestrator;
      this.#preferences = preferences;
      this.#hotkeys = hotkeys;
      this.#onImported = onImported;
    }

    /**
     * Opens the Settings screen.
     * @param {object} services What the dialog works with; see the constructor.
     * @returns {Promise<void>} Resolves once closed.
     */
    static open(services) {
      return new SettingsDialog(services).show();
    }

    /**
     * Ends any hotkey recording and removes the dialog.
     * @param {*} result Result of the dialog.
     * @returns {void}
     */
    close(result) {
      this.#hotkeyEditors.forEach(editor => editor.stopRecording());
      super.close(result);
    }

    /**
     * CSS class of the dimmed overlay centering the screen.
     * @returns {string} The class name.
     */
    get overlayClassName() {
      return 'claude-plus-settings-overlay';
    }

    /**
     * Builds the screen: layout, import/export and theming sections.
     * @returns {HTMLElement[]} The screen.
     */
    createContent() {
      const box = createElement('div', { className: 'claude-plus-settings-dialog', innerHTML: SettingsDialog.#bodyHtml() });
      this.#elements = collectNamedElements(box);
      this.#bindEvents();
      this.#renderLayouts();
      this.#renderThemeFields();
      this.#hotkeyEditors = this.#hotkeys.groups.map(group => new HotkeyEditor({ container: this.#elements[`${group.id}Hotkeys`], hotkeys: this.#hotkeys, group }));
      return [box];
    }

    /**
     * The screen's static markup: a tab bar switching between the app-wide tab and one tab per
     * vendor - just Anthropic today, holding the import that's coupled to its export format.
     * @returns {string} The HTML.
     */
    static #bodyHtml() {
      return `
      <div class="claude-plus-settings-dialog__header">
        <h2>Settings</h2>
        <button class="claude-plus-toolbar__close-button" data-name="closeButton" title="Close">✕</button>
      </div>
      <div class="claude-plus-settings-dialog__tabs">
        <button class="claude-plus-settings-dialog__tab claude-plus-settings-dialog__tab--active" data-name="appTabButton">App</button>
        <button class="claude-plus-settings-dialog__tab" data-name="anthropicTabButton">Anthropic</button>
      </div>
      <div data-name="appPane">${SettingsDialog.#appPaneHtml()}</div>
      <div data-name="anthropicPane" hidden>${SettingsDialog.#anthropicPaneHtml()}</div>`;
    }

    /**
     * Markup of the App tab: saved layouts, generic settings import/export and theming.
     * @returns {string} The HTML.
     */
    static #appPaneHtml() {
      return `
      <section class="claude-plus-settings-dialog__section">
        <h3>Layout</h3>
        <div class="claude-plus-settings-dialog__row">
          <button class="claude-plus-toolbar__button" data-name="saveLayoutButton">Save current layout…</button>
        </div>
        <div data-name="layoutList"></div>
      </section>
      <section class="claude-plus-settings-dialog__section">
        <h3>Import / export</h3>
        <div class="claude-plus-settings-dialog__row">
          <button class="claude-plus-toolbar__button" data-name="exportButton">Export settings (JSON)</button>
          <button class="claude-plus-toolbar__button" data-name="importButton">Import settings…</button>
        </div>
      </section>
      <section class="claude-plus-settings-dialog__section">
        <h3>Hotkeys</h3>
        <div data-name="appHotkeys"></div>
      </section>
      <section class="claude-plus-settings-dialog__section">
        <h3>Theme</h3>
        <div class="claude-plus-settings-dialog__colors" data-name="colorFields"></div>
        <label class="claude-plus-settings-dialog__field">Interface font<input type="text" data-name="uiFontInput" placeholder="System default"></label>
        <label class="claude-plus-settings-dialog__field">Chat font<input type="text" data-name="chatFontInput" placeholder="Same as interface"></label>
        <div class="claude-plus-settings-dialog__row">
          <button class="claude-plus-toolbar__button" data-name="resetThemeButton">Reset to defaults</button>
        </div>
      </section>`;
    }

    /**
     * Markup of the Anthropic tab: importing a claude.ai data export, coupled to its own file format.
     * @returns {string} The HTML.
     */
    static #anthropicPaneHtml() {
      return `
      <section class="claude-plus-settings-dialog__section">
        <h3>Import</h3>
        <div class="claude-plus-settings-dialog__row">
          <button class="claude-plus-toolbar__button" data-name="importChatExportButton">Import chat export…</button>
        </div>
      </section>
      <section class="claude-plus-settings-dialog__section">
        <h3>Hotkeys</h3>
        <div data-name="anthropicHotkeys"></div>
      </section>`;
    }

    /**
     * Wires every control. The saved-layouts list uses one delegated listener since its rows change.
     * @returns {void}
     */
    #bindEvents() {
      const elements = this.#elements;
      elements.closeButton.addEventListener('click', () => this.close());
      elements.appTabButton.addEventListener('click', () => this.#showTab('app'));
      elements.anthropicTabButton.addEventListener('click', () => this.#showTab('anthropic'));
      elements.saveLayoutButton.addEventListener('click', () => this.#saveLayout());
      elements.layoutList.addEventListener('click', event => this.#onLayoutListClick(event));
      elements.exportButton.addEventListener('click', () => this.#settingsTransfer.exportSettings());
      elements.importButton.addEventListener('click', () => this.#settingsTransfer.chooseFileAndImport());
      elements.importChatExportButton.addEventListener('click', () => ImportDialog.open(this.#importOrchestrator, this.#preferences, this.#onImported));
      elements.uiFontInput.addEventListener('input', () => this.#saveThemeFromFields());
      elements.chatFontInput.addEventListener('input', () => this.#saveThemeFromFields());
      elements.resetThemeButton.addEventListener('click', () => this.#resetTheme());
    }

    /**
     * Shows one tab's pane and hides the other, marking the clicked tab button active.
     * @param {'app'|'anthropic'} tabName Tab to show.
     * @returns {void}
     */
    #showTab(tabName) {
      const isApp = tabName === 'app';
      this.#elements.appPane.hidden = !isApp;
      this.#elements.anthropicPane.hidden = isApp;
      this.#elements.appTabButton.classList.toggle('claude-plus-settings-dialog__tab--active', isApp);
      this.#elements.anthropicTabButton.classList.toggle('claude-plus-settings-dialog__tab--active', !isApp);
    }

    /**
     * Asks for a layout name and saves the current layout under it; a blank name cancels.
     * @returns {Promise<void>} Resolves once saved or cancelled.
     */
    async #saveLayout() {
      const name = await PromptDialog.ask('Name of this layout:', '', 'Save');
      if (!name || !name.trim()) return;
      this.#layoutLibrary.save(name.trim());
      this.#renderLayouts();
    }

    /**
     * Loads or deletes the layout of a row whose button was clicked.
     * @param {MouseEvent} event The click.
     * @returns {void}
     */
    #onLayoutListClick(event) {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const name = button.closest('[data-layout-name]').dataset.layoutName;
      if (button.dataset.action === 'load') {
        this.#layoutLibrary.load(name);
        this.close();
      } else {
        this.#layoutLibrary.remove(name);
        this.#renderLayouts();
      }
    }

    /**
     * Lists every saved layout with Load and Delete buttons.
     * @returns {void}
     */
    #renderLayouts() {
      const names = this.#layoutLibrary.names();
      this.#elements.layoutList.innerHTML = names.length ? names.map(SettingsDialog.#layoutRowHtml).join('') : emptyStateHtml('No saved layouts yet.');
    }

    /**
     * HTML of one saved layout's row.
     * @param {string} name Layout name.
     * @returns {string} The row.
     */
    static #layoutRowHtml(name) {
      const escapedName = escapeHtml(name);
      return `<div class="claude-plus-settings-dialog__layout-row" data-layout-name="${escapedName}">
      <span class="claude-plus-settings-dialog__layout-name">${escapedName}</span>
      <button class="claude-plus-toolbar__button" data-action="load">Load</button>
      <button class="claude-plus-toolbar__button" data-action="delete">Delete</button>
    </div>`;
    }

    /**
     * Shows the current theme in the color swatches and font fields.
     * @returns {void}
     */
    #renderThemeFields() {
      const { colors, uiFontFamily, chatFontFamily } = this.#theme.settings;
      this.#elements.colorFields.innerHTML = THEME_COLOR_FIELDS.map(field => SettingsDialog.#colorFieldHtml(field, colors[field.key])).join('');
      this.#elements.colorFields.querySelectorAll('input[type="color"]').forEach(input => input.addEventListener('input', () => this.#saveThemeFromFields()));
      this.#elements.uiFontInput.value = uiFontFamily;
      this.#elements.chatFontInput.value = chatFontFamily;
    }

    /**
     * HTML of one color swatch field.
     * @param {{key: string, label: string}} field The color field.
     * @param {string} value Its current hex value.
     * @returns {string} The field.
     */
    static #colorFieldHtml(field, value) {
      return `<label class="claude-plus-settings-dialog__color-field">
      <input type="color" data-color-key="${field.key}" value="${escapeHtml(value)}">
      <span>${escapeHtml(field.label)}</span>
    </label>`;
    }

    /**
     * Saves and applies the theme from the current field values.
     * @returns {void}
     */
    #saveThemeFromFields() {
      const colorInputs = [...this.#elements.colorFields.querySelectorAll('input[type="color"]')];
      const colors = Object.fromEntries(colorInputs.map(input => [input.dataset.colorKey, input.value]));
      this.#theme.save({ colors, uiFontFamily: this.#elements.uiFontInput.value.trim(), chatFontFamily: this.#elements.chatFontInput.value.trim() });
    }

    /**
     * Clears every theme customization and refreshes the fields to show the defaults.
     * @returns {void}
     */
    #resetTheme() {
      this.#theme.reset();
      this.#renderThemeFields();
    }
  }

  var stylesheet$1 = ".claude-plus-toolbar {\r\n  position: fixed;\r\n  top: 0;\r\n  left: 0;\r\n  right: 0;\r\n  height: var(--claude-plus-toolbar-height);\r\n  z-index: var(--claude-plus-layer-toolbar);\r\n  background: var(--claude-plus-color-bar);\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 14px;\r\n  padding: 0 10px;\r\n  font-size: 12px;\r\n  box-sizing: border-box;\r\n}\r\n\r\n.claude-plus-toolbar__title {\r\n  font-weight: 600;\r\n}\r\n\r\n.claude-plus-toolbar__button {\r\n  background: var(--claude-plus-color-button);\r\n  border: none;\r\n  color: var(--claude-plus-color-text);\r\n  padding: 5px 10px;\r\n  border-radius: 6px;\r\n  cursor: pointer;\r\n  font-size: 12px;\r\n}\r\n\r\n.claude-plus-toolbar__button:hover {\r\n  background: var(--claude-plus-color-button-hover);\r\n}\r\n\r\n.claude-plus-toolbar__button:disabled {\r\n  opacity: 0.5;\r\n  cursor: default;\r\n}\r\n\r\n.claude-plus-toolbar__font-size {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 6px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-toolbar__font-size input[type=range] {\r\n  width: 100px;\r\n}\r\n\r\n.claude-plus-toolbar__close-button {\r\n  background: var(--claude-plus-color-error);\r\n  border: none;\r\n  color: #fff;\r\n  width: 22px;\r\n  height: 22px;\r\n  padding: 0;\r\n  border-radius: 50%;\r\n  cursor: pointer;\r\n  font-size: 12px;\r\n  line-height: 1;\r\n}\r\n\r\n.claude-plus-toolbar__close-button:hover {\r\n  filter: brightness(1.15);\r\n}\r\n";

  StyleRegistry.register(stylesheet$1);

  /**
   * Top bar with the title, the message font size slider, the layout menu, the settings menu and
   * layout reset.
   */
  class Toolbar {
    /**
     * Allowed and default font sizes in pixels.
     * @type {Readonly<{minimum: number, maximum: number, fallback: number}>}
     */
    static #FONT_SIZE = Object.freeze({ minimum: 11, maximum: 24, fallback: 14 });

    /**
     * Font size storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Workspace to reset.
     * @type {DockWorkspace}
     */
    #workspace;

    /**
     * Saved layouts.
     * @type {LayoutLibrary}
     */
    #layoutLibrary;

    /**
     * Settings export and import.
     * @type {SettingsTransfer}
     */
    #settingsTransfer;

    /**
     * Colors and fonts.
     * @type {Theme}
     */
    #theme;

    /**
     * Runs a data-export import.
     * @type {ImportOrchestrator}
     */
    #importOrchestrator;

    /**
     * Hotkey bindings, edited in the settings.
     * @type {Hotkeys}
     */
    #hotkeys;

    /**
     * Called once an import has actually written anything.
     * @type {function(): void}
     */
    #onImported;

    /**
     * Called when the hide button is clicked.
     * @type {function(): void}
     */
    #onHide;

    /**
     * The layout and settings menus.
     * @type {PopupMenu}
     */
    #menu = new PopupMenu();

    /**
     * Message font size in pixels.
     * @type {number}
     */
    #messageFontSize;

    /**
     * Creates the toolbar with the stored font size, limited to the allowed range.
     * @param {object} services Toolbar dependencies.
     * @param {Preferences} services.preferences Font size storage.
     * @param {DockWorkspace} services.workspace Workspace to reset.
     * @param {LayoutLibrary} services.layoutLibrary Saved layouts.
     * @param {SettingsTransfer} services.settingsTransfer Settings export and import.
     * @param {Theme} services.theme Colors and fonts.
     * @param {ImportOrchestrator} services.importOrchestrator Runs a data-export import.
     * @param {Hotkeys} services.hotkeys Hotkey bindings, edited in the settings.
     * @param {function(): void} services.onImported Called once an import has actually written anything.
     * @param {function(): void} services.onHide Called when the hide button is clicked.
     */
    constructor({ preferences, workspace, layoutLibrary, settingsTransfer, theme, importOrchestrator, hotkeys, onImported, onHide }) {
      this.#preferences = preferences;
      this.#workspace = workspace;
      this.#layoutLibrary = layoutLibrary;
      this.#settingsTransfer = settingsTransfer;
      this.#theme = theme;
      this.#importOrchestrator = importOrchestrator;
      this.#hotkeys = hotkeys;
      this.#onImported = onImported;
      this.#onHide = onHide;
      const storedSize = Number.parseFloat(preferences.read(STORAGE_KEYS.messageFontSize));
      const { minimum, maximum, fallback } = Toolbar.#FONT_SIZE;
      this.#messageFontSize = Number.isFinite(storedSize) ? clamp(storedSize, minimum, maximum) : fallback;
    }

    /**
     * Adds the toolbar to the page and applies the font size.
     * @returns {void}
     */
    mount() {
      const toolbar = createElement('div', { className: 'claude-plus-themed claude-plus-toolbar', innerHTML: this.#markupHtml() });
      const elements = collectNamedElements(toolbar);
      elements.fontSizeSlider.addEventListener('input', () => this.#changeFontSize(Number.parseFloat(elements.fontSizeSlider.value), elements.fontSizeLabel));
      elements.layoutsButton.addEventListener('click', () => this.#showLayoutsMenu(elements.layoutsButton));
      elements.settingsButton.addEventListener('click', () => SettingsDialog.open({ layoutLibrary: this.#layoutLibrary, settingsTransfer: this.#settingsTransfer, theme: this.#theme, importOrchestrator: this.#importOrchestrator, preferences: this.#preferences, hotkeys: this.#hotkeys, onImported: this.#onImported }));
      elements.resetLayoutButton.addEventListener('click', () => this.#workspace.resetLayout());
      elements.hideButton.addEventListener('click', () => this.#onHide());
      this.#applyFontSize(elements.fontSizeLabel);
      document.body.append(toolbar);
    }

    /**
     * The toolbar's markup: title, message font size slider, layout, settings and reset buttons,
     * and the hide button.
     * @returns {string} The HTML.
     */
    #markupHtml() {
      const { minimum, maximum } = Toolbar.#FONT_SIZE;
      return `
      <div class="claude-plus-toolbar__title">ClaudePlus</div>
      <label class="claude-plus-toolbar__font-size">
        <span>Aa</span>
        <input type="range" data-name="fontSizeSlider" min="${minimum}" max="${maximum}" step="1" value="${this.#messageFontSize}">
        <span data-name="fontSizeLabel"></span>
      </label>
      <div class="claude-plus-fill-remaining"></div>
      <button class="claude-plus-toolbar__button" data-name="layoutsButton">Layouts ▾</button>
      <button class="claude-plus-toolbar__button" data-name="settingsButton">Settings</button>
      <button class="claude-plus-toolbar__button" data-name="resetLayoutButton">Reset layout</button>
      <button class="claude-plus-toolbar__close-button" data-name="hideButton" title="Hide ClaudePlus (nothing is lost, click the lightbulb to bring it back)">✕</button>`;
    }

    /**
     * Opens the layout menu: save, then load and delete entries per saved layout.
     * @param {HTMLElement} button The layouts button.
     * @returns {void}
     */
    #showLayoutsMenu(button) {
      const names = this.#layoutLibrary.names();
      this.#openMenuBelow(button, [
        { id: 'save:', label: 'Save current layout…' },
        ...names.map(name => ({ id: `load:${name}`, label: `Load "${name}"` })),
        ...names.map(name => ({ id: `delete:${name}`, label: `Delete "${name}"` })),
      ], entryId => this.#onLayoutsMenuSelect(entryId));
    }

    /**
     * Runs a layout menu entry.
     * @param {string} entryId "save:", "load:<name>" or "delete:<name>".
     * @returns {void}
     */
    #onLayoutsMenuSelect(entryId) {
      const separator = entryId.indexOf(':');
      const action = entryId.slice(0, separator);
      const name = entryId.slice(separator + 1);
      const actions = {
        save: () => this.#askNameAndSave(),
        load: () => this.#layoutLibrary.load(name),
        delete: () => this.#layoutLibrary.remove(name),
      };
      actions[action]();
    }

    /**
     * Asks for a layout name and saves the current layout under it; a blank name cancels.
     * @returns {Promise<void>} Resolves once saved or cancelled.
     */
    async #askNameAndSave() {
      const name = await PromptDialog.ask('Name of this layout:', '', 'Save');
      if (name && name.trim()) this.#layoutLibrary.save(name.trim());
    }

    /**
     * Opens the toolbar menu below a button.
     * @param {HTMLElement} button The button.
     * @param {ChoiceOption[]} entries Menu entries.
     * @param {function(string): void} onSelect Called with the chosen entry's id.
     * @returns {void}
     */
    #openMenuBelow(button, entries, onSelect) {
      const bounds = button.getBoundingClientRect();
      this.#menu.open({ left: bounds.left, top: bounds.bottom + 4, entries, onSelect });
    }

    /**
     * Changes and stores the font size.
     * @param {number} fontSize New size in pixels.
     * @param {HTMLElement} fontSizeLabel Element showing the size.
     * @returns {void}
     */
    #changeFontSize(fontSize, fontSizeLabel) {
      this.#messageFontSize = fontSize;
      this.#preferences.write(STORAGE_KEYS.messageFontSize, fontSize);
      this.#applyFontSize(fontSizeLabel);
    }

    /**
     * Applies the font size to the messages and shows it.
     * @param {HTMLElement} fontSizeLabel Element showing the size.
     * @returns {void}
     */
    #applyFontSize(fontSizeLabel) {
      document.documentElement.style.setProperty('--claude-plus-message-font-size', `${this.#messageFontSize}px`);
      fontSizeLabel.textContent = `${this.#messageFontSize}px`;
    }
  }

  /**
   * Runs at most a fixed number of async tasks at once, queuing the rest to start as slots free up.
   */
  class ConcurrencyLimiter {
    /**
     * Tasks allowed to run at once.
     * @type {number}
     */
    #maxConcurrent;

    /**
     * Tasks currently running.
     * @type {number}
     */
    #activeCount = 0;

    /**
     * Callbacks waiting for a free slot, in arrival order.
     * @type {Array<function(): void>}
     */
    #waiters = [];

    /**
     * Creates the limiter.
     * @param {number} maxConcurrent Tasks allowed to run at once.
     */
    constructor(maxConcurrent) {
      this.#maxConcurrent = maxConcurrent;
    }

    /**
     * Runs a task once a slot is free, releasing the slot once it settles either way.
     * @param {function(): Promise<*>} task The task.
     * @returns {Promise<*>} The task's result.
     */
    async run(task) {
      await this.#acquire();
      try {
        return await task();
      } finally {
        this.#release();
      }
    }

    /**
     * Reserves a slot, waiting in line if none are free.
     * @returns {Promise<void>} Resolves once a slot is reserved.
     */
    #acquire() {
      if (this.#activeCount < this.#maxConcurrent) {
        this.#activeCount += 1;
        return Promise.resolve();
      }
      return new Promise(resolve => this.#waiters.push(resolve));
    }

    /**
     * Frees a slot, handing it straight to the next waiter if one is queued.
     * @returns {void}
     */
    #release() {
      const nextWaiter = this.#waiters.shift();
      if (nextWaiter) nextWaiter();
      else this.#activeCount -= 1;
    }
  }

  /**
   * Derives a stable cache key for a widget call from its tool name and data, so identical widgets
   * (even across different conversations) share one cached, already-extracted card.
   */
  class WidgetHash {
    /**
     * A hex-encoded SHA-256 hash of a widget's tool name and data.
     * @param {string} toolName The widget tool's name.
     * @param {object} data The widget's data.
     * @returns {Promise<string>} The hash.
     */
    static async hashOf(toolName, data) {
      const text = `${toolName}:${JSON.stringify(data)}`;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
  }

  /**
   * Extracts a widget's real rendered card straight from claude.ai's own React app, run fresh and
   * self-contained in a hidden same-origin iframe: no widget-specific rendering code of our own, no
   * touching the page's own native app instance. The iframe loads the conversation, React renders
   * the widget exactly as it normally would (its own hooks, its own context, all real). claude.ai
   * only mounts messages near the current scroll position, so a widget far from where the
   * conversation opens (by default, near the bottom) needs to be scrolled into view first; several
   * scroll positions across the conversation are tried in turn. Once found by matching its own data
   * (every widget wrapper mirrors its tool call's input back as a prop, unlike its tool call id,
   * which isn't consistently exposed across widget types), the finished card's HTML and stylesheet
   * URLs are read off and the iframe is torn down.
   */
  class WidgetIframeSource {
    /**
     * Overall time budget across every scroll position before giving up.
     * @type {number}
     */
    static #TIMEOUT_MS = 45000;

    /**
     * Time budget at each scroll position before moving to the next.
     * @type {number}
     */
    static #STEP_TIMEOUT_MS = 6000;

    /**
     * Fractions of the conversation's scroll range to try in turn; null tries wherever it opens by
     * default (usually the bottom) before scrolling anywhere.
     * @type {ReadonlyArray<?number>}
     */
    static #SCROLL_FRACTIONS = Object.freeze([null, 0, 0.25, 0.5, 0.75, 1]);

    /**
     * Extracts a widget's rendered card.
     * @param {string} conversationId Conversation the widget's message belongs to.
     * @param {object} data The widget's own data (its tool call's input), to match against. The
     * rendered widget's own input prop can carry more than this (some widgets enrich it client-side,
     * e.g. with unit conversions or fetched images), so a fiber matches when this data is a subset
     * of its input, not only on an exact match.
     * @returns {Promise<{html: string, cssHrefs: string[]}>} The card's outer HTML and the
     * stylesheet URLs it depends on.
     * @throws {Error} When the widget doesn't appear within the timeout.
     */
    static async extract(conversationId, data) {
      const iframe = WidgetIframeSource.#createHiddenIframe(conversationId);
      document.body.append(iframe);
      try {
        return await WidgetIframeSource.#searchAllPositions(iframe, data);
      } finally {
        iframe.remove();
      }
    }

    /**
     * Creates a hidden iframe pointed at a conversation, ready to append.
     * @param {string} conversationId Conversation to load.
     * @returns {HTMLIFrameElement} The iframe.
     */
    static #createHiddenIframe(conversationId) {
      return createElement('iframe', {
        src: `https://claude.ai/chat/${conversationId}`,
        style: 'position:fixed; top:-9999px; left:-9999px; width:900px; height:3000px; border:0;',
      });
    }

    /**
     * Tries each scroll position in turn until the widget is found or the overall timeout elapses.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @param {object} expectedData The widget's own data, to match against.
     * @returns {Promise<{html: string, cssHrefs: string[]}>} The extracted card.
     * @throws {Error} When the widget doesn't appear within the timeout.
     */
    static async #searchAllPositions(iframe, expectedData) {
      const deadline = Date.now() + WidgetIframeSource.#TIMEOUT_MS;
      for (const fraction of WidgetIframeSource.#SCROLL_FRACTIONS) {
        if (Date.now() >= deadline) break;
        if (fraction !== null) WidgetIframeSource.#scrollTo(iframe, fraction);
        const stepDeadline = Math.min(deadline, Date.now() + WidgetIframeSource.#STEP_TIMEOUT_MS);
        const found = await WidgetIframeSource.#pollUntil(iframe, expectedData, stepDeadline);
        if (found) return found;
      }
      throw new Error('widget did not render within the timeout');
    }

    /**
     * Polls the current scroll position until the widget appears or its step deadline elapses.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @param {object} expectedData The widget's own data, to match against.
     * @param {number} stepDeadline Epoch ms after which to stop trying this position.
     * @returns {Promise<?{html: string, cssHrefs: string[]}>} The extracted card, or null when this
     * position never showed it.
     */
    static #pollUntil(iframe, expectedData, stepDeadline) {
      return new Promise(resolve => {
        const poll = () => WidgetIframeSource.#pollOnce(iframe, expectedData, stepDeadline, poll, resolve);
        poll();
      });
    }

    /**
     * One poll attempt: resolves with the card if found, with null past the step deadline, else
     * schedules another attempt.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @param {object} expectedData The widget's own data, to match against.
     * @param {number} stepDeadline Epoch ms after which to stop trying this position.
     * @param {function(): void} poll This function, to schedule the next attempt.
     * @param {function(?{html: string, cssHrefs: string[]}): void} resolve Resolves this position's search.
     * @returns {void}
     */
    static #pollOnce(iframe, expectedData, stepDeadline, poll, resolve) {
      const found = WidgetIframeSource.#tryFind(iframe, expectedData);
      if (found) resolve(found);
      else if (Date.now() > stepDeadline) resolve(null);
      else setTimeout(poll, TIMING.widgetExtractPollMs);
    }

    /**
     * Scrolls the conversation to a fraction of its scrollable range, so messages near there mount.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @param {number} fraction 0 (top) to 1 (bottom).
     * @returns {void}
     */
    static #scrollTo(iframe, fraction) {
      const scrollable = WidgetIframeSource.#scrollableElementOf(iframe);
      if (scrollable) scrollable.scrollTop = fraction * (scrollable.scrollHeight - scrollable.clientHeight);
    }

    /**
     * The conversation's main scrollable element, if the iframe has loaded far enough to have one.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @returns {?HTMLElement} The element, or null.
     */
    static #scrollableElementOf(iframe) {
      const documentInFrame = WidgetIframeSource.#documentOf(iframe);
      if (!documentInFrame) return null;
      return [...documentInFrame.querySelectorAll('*')].find(element => WidgetIframeSource.#isMainScrollable(element)) ?? null;
    }

    /**
     * Whether an element looks like the conversation's own scroll container, rather than some
     * smaller scrollable widget inside it.
     * @param {HTMLElement} element The element.
     * @returns {boolean} True when it scrolls vertically and has substantial extra height to scroll.
     */
    static #isMainScrollable(element) {
      const style = getComputedStyle(element);
      const scrollsVertically = style.overflowY === 'auto' || style.overflowY === 'scroll';
      return scrollsVertically && element.scrollHeight > element.clientHeight + 50;
    }

    /**
     * Looks for the widget in the iframe's current document, if it has loaded far enough to have one.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @param {object} expectedData The widget's own data, to match against.
     * @returns {?{html: string, cssHrefs: string[]}} The extracted card, or null when not found yet.
     */
    static #tryFind(iframe, expectedData) {
      const documentInFrame = WidgetIframeSource.#documentOf(iframe);
      const rootElement = documentInFrame?.getElementById('root');
      const rootFiber = rootElement ? WidgetIframeSource.#fiberOf(rootElement) : null;
      if (!rootFiber) return null;
      const hostElement = WidgetIframeSource.#findWidgetElement(rootFiber, expectedData);
      if (!hostElement) return null;
      const cssHrefs = [...documentInFrame.querySelectorAll('link[rel="stylesheet"]')].map(link => link.href);
      return { html: hostElement.outerHTML, cssHrefs };
    }

    /**
     * The iframe's document, or null while it can't be read (not yet navigated, still loading).
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @returns {?Document} The document, or null.
     */
    static #documentOf(iframe) {
      try {
        return iframe.contentDocument;
      } catch {
        return null;
      }
    }

    /**
     * React's internal fiber for a DOM node, if it manages one.
     * @param {HTMLElement} element The element.
     * @returns {?object} The fiber, or null.
     */
    static #fiberOf(element) {
      const fiberKey = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactFiber') || name.startsWith('__reactContainer'));
      return fiberKey ? element[fiberKey] : null;
    }

    /**
     * The rendered DOM element of the widget whose data matches, searching the whole fiber tree
     * generically (works for every widget type: every widget wrapper mirrors its tool call's input
     * back as a prop, so matching on that needs no per-type layout knowledge). A logical widget
     * commonly has several fiber layers (an outer wrapper, a memoized copy, an inner component) that
     * all carry the same matching props, so a match without a resolvable DOM element yet (still
     * behind a Suspense boundary) doesn't stop the search - it continues into that fiber's own
     * descendants, where a fully-rendered layer is found.
     * @param {object} rootFiber Root fiber to search from.
     * @param {object} expectedData The widget's own data, to match against.
     * @returns {?HTMLElement} The widget's outermost rendered element, or null when not found.
     */
    static #findWidgetElement(rootFiber, expectedData) {
      return WidgetIframeSource.#searchForHostElement(rootFiber, new Set(), expectedData);
    }

    /**
     * Depth-first search of the fiber tree for a matching node with a resolvable DOM element.
     * @param {?object} fiber Fiber to check, or null past the end of a branch.
     * @param {Set<object>} visited Fibers already checked, since child/sibling links can cross-reference.
     * @param {object} expectedData The widget's own data, to match against.
     * @returns {?HTMLElement} The element, or null.
     */
    static #searchForHostElement(fiber, visited, expectedData) {
      if (!fiber || visited.has(fiber)) return null;
      visited.add(fiber);
      return WidgetIframeSource.#ownHostElement(fiber, expectedData)
        || WidgetIframeSource.#searchForHostElement(fiber.child, visited, expectedData)
        || WidgetIframeSource.#searchForHostElement(fiber.sibling, visited, expectedData);
    }

    /**
     * A fiber's own resolvable DOM element, if it matches the target data and renders one.
     * @param {object} fiber The fiber.
     * @param {object} expectedData The widget's own data, to match against.
     * @returns {?HTMLElement} The element, or null.
     */
    static #ownHostElement(fiber, expectedData) {
      return WidgetIframeSource.#isWidgetFiber(fiber, expectedData) ? WidgetIframeSource.#firstHostElement(fiber) : null;
    }

    /**
     * Whether a fiber's props identify it as the widget with matching data: its input prop carries
     * expectedData as a subset (not necessarily an exact match, since some widgets enrich their
     * input client-side beyond what their tool call originally requested).
     * @param {object} fiber The fiber.
     * @param {object} expectedData The widget's own data, to match against.
     * @returns {boolean} True when its input prop is a superset of expectedData.
     */
    static #isWidgetFiber(fiber, expectedData) {
      const props = fiber.memoizedProps;
      return Boolean(props) && typeof props === 'object' && 'input' in props && WidgetIframeSource.#isSubset(expectedData, props.input);
    }

    /**
     * Whether expected is contained within actual: every array holds the same-length, pairwise
     * matching elements; every object's keys all have a matching value in actual, extra keys in
     * actual are ignored; anything else compares with strict equality.
     * @param {*} expected The data we already know about the widget.
     * @param {*} actual The candidate value found in the iframe.
     * @returns {boolean} True when expected is a subset of actual.
     */
    static #isSubset(expected, actual) {
      if (Array.isArray(expected)) return WidgetIframeSource.#isArraySubset(expected, actual);
      if (expected && typeof expected === 'object') return WidgetIframeSource.#isObjectSubset(expected, actual);
      return expected === actual;
    }

    /**
     * Whether every element of an expected array matches its counterpart in a same-length actual array.
     * @param {Array} expected The expected array.
     * @param {*} actual The candidate value.
     * @returns {boolean} True when it's a same-length array whose elements all match pairwise.
     */
    static #isArraySubset(expected, actual) {
      return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => WidgetIframeSource.#isSubset(item, actual[index]));
    }

    /**
     * Whether every key of an expected object has a matching value in an actual object, ignoring
     * any extra keys actual has.
     * @param {object} expected The expected object.
     * @param {*} actual The candidate value.
     * @returns {boolean} True when actual is an object carrying at least expected's own keys, matching.
     */
    static #isObjectSubset(expected, actual) {
      return Boolean(actual) && typeof actual === 'object' && Object.keys(expected).every(key => WidgetIframeSource.#isSubset(expected[key], actual[key]));
    }

    /**
     * The first real DOM element a fiber (or its descendants) renders to.
     * @param {object} fiber The fiber.
     * @returns {?HTMLElement} The element, or null when it renders nothing yet.
     */
    static #firstHostElement(fiber) {
      let node = fiber;
      while (node) {
        if (WidgetIframeSource.#isElementNode(node.stateNode)) return node.stateNode;
        node = node.child;
      }
      return null;
    }

    /**
     * Whether a value is a DOM element, checked by nodeType rather than instanceof HTMLElement,
     * since the latter fails across realms: the iframe's elements are instances of ITS OWN
     * HTMLElement constructor, a different object from this script's, even though same-origin.
     * @param {*} value The value.
     * @returns {boolean} True for an element node.
     */
    static #isElementNode(value) {
      return Boolean(value) && value.nodeType === 1;
    }
  }

  var stylesheet = ".claude-plus-widget-slot {\n  min-height: 48px;\n  margin: 6px 0;\n  padding: 10px 12px;\n  border-radius: 8px;\n  background: var(--claude-plus-color-tool-details);\n  color: var(--claude-plus-color-text-faint);\n  font-size: 12px;\n}\n\n.claude-plus-widget-slot__message {\n  color: var(--claude-plus-color-text-faint);\n  font-size: 12px;\n}\n\n.claude-plus-widget-card {\n  display: block;\n}\n";

  StyleRegistry.register(stylesheet);

  /**
   * Mounts an extracted widget card into a container via a shadow root, so claude.ai's own
   * stylesheet (which resets bare tag selectors) only ever applies inside the card, never leaking
   * out to the rest of ClaudePlus, and none of ClaudePlus's own styles leak in.
   */
  class WidgetMount {
    /**
     * Replaces a container's content with an isolated widget card.
     * @param {HTMLElement} container Element to mount into; its existing content is replaced.
     * @param {{html: string, css: string}} card The extracted card.
     * @returns {void}
     */
    static show(container, card) {
      container.textContent = '';
      const shadow = container.attachShadow({ mode: 'open' });
      shadow.append(createElement('style', { textContent: card.css }));
      shadow.append(createElement('div', { className: 'claude-plus-widget-card', innerHTML: card.html }));
    }

    /**
     * Shows a message in place of a widget that couldn't be extracted.
     * @param {HTMLElement} container Element to show the message in.
     * @param {string} text The message.
     * @returns {void}
     */
    static showUnavailable(container, text) {
      container.textContent = '';
      container.append(createElement('div', { className: 'claude-plus-widget-slot__message', textContent: text }));
    }
  }

  /**
   * Renders a widget tool call's real card into a slot element: a cached copy if this exact widget
   * (by tool name and data) was extracted before, or a fresh extraction from a hidden iframe
   * otherwise. Stylesheets are fetched once per session and reused across every widget. Extractions
   * are capped at a few concurrent iframe loads, since a message-heavy chat can have many widgets
   * and loading claude.ai's whole app in each of them at once would starve every one of them.
   */
  class WidgetExtractor {
    /**
     * Iframe extractions allowed to run at once.
     * @type {number}
     */
    static #MAX_CONCURRENT_EXTRACTIONS = 1;

    /**
     * A stylesheet URL's already-started fetch, kept for the page's lifetime so every widget shares it.
     * @type {Map<string, Promise<string>>}
     */
    #cssPromisesByHref = new Map();

    /**
     * Persisted extracted-card cache.
     * @type {IndexedDbStore}
     */
    #database;

    /**
     * Limits how many iframe extractions run at once.
     * @type {ConcurrencyLimiter}
     */
    #extractionLimiter = new ConcurrencyLimiter(WidgetExtractor.#MAX_CONCURRENT_EXTRACTIONS);

    /**
     * Creates the extractor on top of a persisted cache.
     * @param {IndexedDbStore} database Persisted extracted-card cache.
     */
    constructor(database) {
      this.#database = database;
    }

    /**
     * Fills a slot element with a widget's real card, from cache or by extracting it fresh.
     * @param {HTMLElement} container Slot element to fill.
     * @param {?string} conversationId Conversation the widget's message belongs to; null for an
     * unsaved local message, which can't be extracted.
     * @param {{toolName: string, data: object, toolUseId: string}} job The widget to render.
     * @returns {Promise<void>} Resolves once the slot has been filled, with the card or a failure message.
     */
    async render(container, conversationId, job) {
      try {
        const card = await this.#cardFor(conversationId, job);
        WidgetMount.show(container, card);
      } catch (error) {
        WidgetMount.showUnavailable(container, `Couldn't render this widget (${job.toolName}).`);
        console.warn(LOG_PREFIX, 'widget extraction failed', error);
      }
    }

    /**
     * A widget's card, from the persisted cache if present, else freshly extracted and cached.
     * @param {?string} conversationId Conversation the widget's message belongs to.
     * @param {{toolName: string, data: object, toolUseId: string}} job The widget to render.
     * @returns {Promise<{html: string, css: string}>} The card.
     * @throws {Error} When there is no conversation to extract from, or extraction fails.
     */
    async #cardFor(conversationId, job) {
      const hash = await WidgetHash.hashOf(job.toolName, job.data);
      const cached = await this.#database.read(DATABASE.stores.widgetCards, hash);
      if (cached) return cached;
      if (!conversationId) throw new Error('no conversation to extract this widget from');
      const card = await this.#extract(conversationId, job.data);
      await this.#database.write(DATABASE.stores.widgetCards, { hash, ...card });
      return card;
    }

    /**
     * Extracts a widget's card and its stylesheets' combined text, queued behind the concurrency limit.
     * @param {string} conversationId Conversation the widget's message belongs to.
     * @param {object} data The widget's own data, to match against.
     * @returns {Promise<{html: string, css: string}>} The card.
     */
    #extract(conversationId, data) {
      return this.#extractionLimiter.run(async () => {
        const extracted = await WidgetIframeSource.extract(conversationId, data);
        const cssParts = await Promise.all(extracted.cssHrefs.map(href => this.#cssTextOf(href)));
        return { html: extracted.html, css: cssParts.join('\n') };
      });
    }

    /**
     * A stylesheet's text, fetched once per URL and reused for every widget that needs it.
     * @param {string} href Stylesheet URL.
     * @returns {Promise<string>} Its text, or an empty string when it couldn't be fetched.
     */
    #cssTextOf(href) {
      if (!this.#cssPromisesByHref.has(href)) this.#cssPromisesByHref.set(href, WidgetExtractor.#fetchText(href));
      return this.#cssPromisesByHref.get(href);
    }

    /**
     * Fetches a URL's text, failing soft to an empty string.
     * @param {string} href URL to fetch.
     * @returns {Promise<string>} Its text, or an empty string on failure.
     */
    static async #fetchText(href) {
      try {
        const response = await fetch(href);
        return response.ok ? await response.text() : '';
      } catch {
        return '';
      }
    }
  }

  var nativeAppHidingStylesheet = "#root,\r\n#portal-root {\r\n  display: none !important;\r\n}\r\n";

  var themeStylesheet = ":root {\r\n  --claude-plus-color-background: #1a1918;\r\n  --claude-plus-color-bar: #1c1b1a;\r\n  --claude-plus-color-raised: #262523;\r\n  --claude-plus-color-raised-hover: #3a3937;\r\n  --claude-plus-color-tool-details: #232221;\r\n  --claude-plus-color-code-block: #101010;\r\n  --claude-plus-color-button: #333;\r\n  --claude-plus-color-button-hover: #444;\r\n  --claude-plus-color-text: #ececec;\r\n  --claude-plus-color-text-muted: #b8b6b3;\r\n  --claude-plus-color-text-faint: #8a8886;\r\n  --claude-plus-color-accent: #d97757;\r\n  --claude-plus-color-accent-soft: rgba(217, 119, 87, 0.18);\r\n  --claude-plus-color-accent-overlay: rgba(217, 119, 87, 0.35);\r\n  --claude-plus-color-message-human-bg: rgba(255, 255, 255, 0.07);\r\n  --claude-plus-color-error: #e57373;\r\n  --claude-plus-color-active-chat: rgba(94, 200, 120, 0.55);\r\n  --claude-plus-color-border-faint: rgba(255, 255, 255, 0.05);\r\n  --claude-plus-color-border: rgba(255, 255, 255, 0.08);\r\n  --claude-plus-color-border-strong: rgba(255, 255, 255, 0.12);\r\n  --claude-plus-color-hover: rgba(255, 255, 255, 0.06);\r\n  --claude-plus-font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;\r\n  --claude-plus-layer-zone-chrome: 2147480000;\r\n  --claude-plus-layer-panel: 2147480500;\r\n  --claude-plus-layer-divider: 2147480600;\r\n  --claude-plus-layer-toolbar: 2147483000;\r\n  --claude-plus-layer-popup-menu: 2147483001;\r\n  --claude-plus-layer-drop-highlight: 2147483646;\r\n  --claude-plus-layer-drag-label: 2147483647;\r\n}\r\n\r\n.claude-plus-themed {\r\n  font-family: var(--claude-plus-font-family);\r\n  color: var(--claude-plus-color-text);\r\n  color-scheme: dark;\r\n}\r\n\r\n.claude-plus-themed [hidden],\r\n.claude-plus-themed[hidden] {\r\n  display: none !important;\r\n}\r\n";

  /**
   * Composes every part of the UI and starts it, only once the launcher button is clicked.
   */
  class ClaudePlusApp {
    /**
     * Whether the one-time heavy boot (services, panels, data) has already run.
     * @type {boolean}
     */
    #isStarted = false;

    /**
     * The stylesheet hiding claude.ai's native app; toggled (not removed) so hiding ClaudePlus
     * again never loses any state.
     * @type {?HTMLStyleElement}
     */
    #nativeHidingStyle = null;

    /**
     * The always-on-top button that starts or re-shows the app; shown only over the native UI,
     * never while the workspace itself is showing.
     * @type {ClaudePlusLauncher}
     */
    #launcher;

    /**
     * Creates the app.
     * @param {ClaudePlusLauncher} launcher The launcher button, shown only over the native UI.
     */
    constructor(launcher) {
      this.#launcher = launcher;
    }

    /**
     * Shows the interface: runs the one-time heavy boot on the first call, or just reveals it
     * again with all state intact on a later one.
     * @returns {Promise<void>} Resolves once shown.
     */
    async launch() {
      if (this.#isStarted) {
        this.show();
        return;
      }
      await this.start();
      this.#isStarted = Boolean(this.#nativeHidingStyle);
      if (this.#isStarted) this.#launcher.hide();
    }

    /**
     * Reveals the interface and hides claude.ai's native app again.
     * @returns {void}
     */
    show() {
      if (this.#nativeHidingStyle) this.#nativeHidingStyle.disabled = false;
      ClaudePlusApp.#setInterfaceVisible(true);
      this.#launcher.hide();
    }

    /**
     * Hides the interface and reveals claude.ai's native app, without unmounting anything.
     * @returns {void}
     */
    hide() {
      if (this.#nativeHidingStyle) this.#nativeHidingStyle.disabled = true;
      ClaudePlusApp.#setInterfaceVisible(false);
      this.#launcher.show();
    }

    /**
     * Shows or hides every element this script added, other than the launcher button, which stays
     * on top regardless.
     * @param {boolean} visible Whether to show them.
     * @returns {void}
     */
    static #setInterfaceVisible(visible) {
      document.querySelectorAll('body > [class*="claude-plus-"]:not(.claude-plus-launcher)').forEach((element) => {
        element.style.display = visible ? '' : 'none';
      });
    }

    /**
     * Creates the object stores that don't exist yet.
     * @param {IDBDatabase} database Database being upgraded.
     * @returns {void}
     */
    static #createMissingStores(database) {
      for (const [storeKey, storeName] of Object.entries(DATABASE.stores)) {
        if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: DATABASE.keyPaths[storeKey] });
      }
    }

    /**
     * The stylesheet of the whole UI: the theme variables, the toolbar and tab strip heights from
     * the layout configuration, then the stylesheets every component registered.
     * @returns {string} The stylesheet text.
     */
    static #interfaceStylesheet() {
      const layoutVariables = `:root { --claude-plus-toolbar-height: ${LAYOUT.toolbarHeight}px; --claude-plus-tab-strip-height: ${LAYOUT.tabStripHeight}px; }`;
      return [themeStylesheet, layoutVariables, StyleRegistry.combinedCss].join('\n');
    }

    /**
     * Mounts the UI, then hides claude.ai and loads the data. If mounting fails, everything this
     * script added is removed again, so claude.ai stays usable instead of turning into a blank page.
     * @returns {Promise<void>} Resolves once the first conversation is shown, or after a failed mount.
     */
    async start() {
      const mounted = this.#mountOrRestore();
      if (!mounted) return;
      this.#nativeHidingStyle = mounted.nativeHidingStyle;
      await ClaudePlusApp.#loadData(mounted.services);
    }

    /**
     * Mounts the UI and hides the native app, or undoes everything when mounting throws.
     * @returns {?{services: object, nativeHidingStyle: HTMLStyleElement}} The services needing data
     * (directory, router, paneManager, stats, activity, rateLimits) and the native-hiding
     * stylesheet, or null after a failure.
     */
    #mountOrRestore() {
      try {
        const services = this.#mountInterface();
        const nativeHidingStyle = createElement('style', { className: 'claude-plus-styles', textContent: nativeAppHidingStylesheet });
        document.head.append(nativeHidingStyle);
        return { services, nativeHidingStyle };
      } catch (error) {
        ClaudePlusApp.#removeInterface();
        console.error(LOG_PREFIX, 'failed to start; claude.ai was left unchanged', error);
        return null;
      }
    }

    /**
     * Injects the styles, builds every service and mounts the toolbar and the workspace.
     * @returns {object} Every service, including those needing data: directory, router, paneManager, stats, activity and rateLimits.
     * @throws {Error} When any part fails to build or mount.
     */
    #mountInterface() {
      document.head.append(createElement('style', { className: 'claude-plus-styles', textContent: ClaudePlusApp.#interfaceStylesheet() }));
      const services = ClaudePlusApp.#createServices();
      ClaudePlusApp.#connectServices(services);
      services.paneManager.restorePanes(conversationIdFromPath(location.pathname));
      this.#mountWorkspace(services);
      return services;
    }

    /**
     * Creates the storage, API and data services the interface is built on.
     * @returns {object} The services: preferences, theme, api, database, modelCatalog, settings, importedConversations, directory, stats, activity, rateLimits, paneManager and router.
     */
    static #createServices() {
      const preferences = new Preferences();
      const theme = new Theme(preferences);
      const api = new ClaudeApi();
      const database = new IndexedDbStore({ name: DATABASE.name, version: DATABASE.version, upgrade: ClaudePlusApp.#createMissingStores });
      const modelCatalog = new ModelCatalog(preferences);
      modelCatalog.refresh();
      const settings = new ComposerSettings(preferences, modelCatalog);
      const importedConversations = new ImportedConversationStore(database);
      const directory = new CombinedConversationDirectory(new ConversationDirectory(api), importedConversations);
      const stats = new StatsIndex(api, database);
      const activity = new ActivityTracker(database);
      const rateLimits = new RateLimitMonitor(api);
      const widgetExtractor = new WidgetExtractor(database);
      const paneManager = new ChatPaneManager({ api, settings, directory, preferences, stats, widgetExtractor, importedConversations });
      return { preferences, theme, api, database, modelCatalog, settings, importedConversations, directory, stats, activity, rateLimits, paneManager, router: new Router(paneManager) };
    }

    /**
     * Builds the panels, the workspace and the toolbar, mounts them and installs the shortcuts.
     * @param {object} services The services from #createServices.
     * @returns {void}
     */
    #mountWorkspace(services) {
      const { preferences, theme, api, database, modelCatalog, settings, importedConversations, directory, stats, activity, rateLimits, paneManager, router } = services;
      const panelFactory = new PanelFactory({ directory, router, paneManager, stats, activity, rateLimits, preferences });
      const composer = new ComposerPanel({ paneManager, settings, stats, exporter: new ConversationExporter(api, paneManager), modelCatalog });
      const workspace = ClaudePlusApp.#createWorkspace({ preferences, paneManager, panelFactory, composer });
      paneManager.attachWorkspace(workspace);
      panelFactory.attachWorkspace(workspace);
      const layoutLibrary = new LayoutLibrary({ preferences, workspace, paneManager, panelFactory });
      const importOrchestrator = new ImportOrchestrator(database, importedConversations, stats);
      const onImported = async () => { await directory.refreshImported(); ClaudePlusApp.#reindexImported(services); };
      const hotkeys = new Hotkeys(preferences, ClaudePlusApp.#hotkeyGroups());
      new Toolbar({ preferences, workspace, layoutLibrary, settingsTransfer: new SettingsTransfer(preferences), theme, importOrchestrator, hotkeys, onImported, onHide: () => this.hide() }).mount();
      workspace.mount();
      ClaudePlusApp.#refreshTabTitlesOnChange(workspace, directory, paneManager);
      new KeyboardShortcuts(hotkeys, new HotkeyActions({ workspace, panelFactory, paneManager }).toMap()).install();
    }

    /**
     * The hotkey command groups: the app's own, then each vendor's.
     * @returns {HotkeyGroup[]} The groups.
     */
    static #hotkeyGroups() {
      return [
        { id: 'app', label: 'App', commands: HOTKEY_COMMANDS },
        { id: 'anthropic', label: 'Anthropic', commands: ANTHROPIC_HOTKEY_COMMANDS },
      ];
    }

    /**
     * Creates the workspace with the chat panes, the composer and the view panels of the stored
     * layout (or the default view panels when no layout is stored).
     * @param {object} parts Workspace parts.
     * @param {Preferences} parts.preferences Layout storage.
     * @param {ChatPaneManager} parts.paneManager Chat panes.
     * @param {PanelFactory} parts.panelFactory Creates view panels.
     * @param {ComposerPanel} parts.composer The composer.
     * @returns {DockWorkspace} The workspace, not yet mounted.
     */
    static #createWorkspace({ preferences, paneManager, panelFactory, composer }) {
      const storedPanelIds = DockTree.collectPanelIds(preferences.readJson(STORAGE_KEYS.dockLayout));
      const viewPanelIds = storedPanelIds.size ? [...storedPanelIds].filter(panelId => panelFactory.isViewPanelId(panelId)) : PanelFactory.defaultPanelIds;
      const panels = new Map([...paneManager.panelEntries(), ['composer', composer], ...viewPanelIds.map(panelId => [panelId, panelFactory.create(panelId)])]);
      const workspace = new DockWorkspace({
        panels,
        paneManager,
        preferences,
        createDefaultTree: () => DockTree.createDefault(paneManager.paneIds),
        requiredPanelIds: () => [...paneManager.paneIds, 'composer'],
        placeMissingPanel: ClaudePlusApp.#placeMissingPanel,
        addPanelMenu: {
          entries: () => panelFactory.addMenuEntries(),
          onSelect: (entryId, leafId) => ClaudePlusApp.#addFromMenu({ entryId, leafId, paneManager, panelFactory, workspace }),
        },
        onLayout: visiblePanelIds => paneManager.updateVisiblePanels(visiblePanelIds),
      });
      return workspace;
    }

    /**
     * Docks a required panel missing from the layout: the composer along the bottom edge, anything
     * else as a tab of the first zone.
     * @param {DockTree} tree The layout.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    static #placeMissingPanel(tree, panelId) {
      if (panelId === 'composer') tree.dockPanelAtEdge(panelId, 'bottom');
      else tree.dockPanel(panelId, tree.firstLeaf().id, 'center');
    }

    /**
     * Runs a "+" menu entry: a new empty chat, or a new instance of a view panel, as a tab of the zone.
     * @param {object} choice The chosen entry and context.
     * @param {string} choice.entryId "chat" or a view panel type.
     * @param {string} choice.leafId Zone whose "+" was clicked.
     * @param {ChatPaneManager} choice.paneManager Chat panes.
     * @param {PanelFactory} choice.panelFactory Creates view panels.
     * @param {DockWorkspace} choice.workspace The workspace.
     * @returns {void}
     */
    static #addFromMenu({ entryId, leafId, paneManager, panelFactory, workspace }) {
      if (entryId === 'chat') {
        paneManager.openPaneInZone(leafId);
        return;
      }
      const { panelId, panel } = panelFactory.createInstance(entryId);
      workspace.addPanelToZone(panelId, panel, leafId);
    }

    /**
     * Feeds loaded and deleted conversations to the stats and streamed usage windows to the monitor.
     * @param {object} services Services to connect.
     * @param {CombinedConversationDirectory} services.directory Shared conversation list.
     * @param {ChatPaneManager} services.paneManager Chat panes.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {RateLimitMonitor} services.rateLimits Usage windows.
     * @returns {void}
     */
    static #connectServices({ directory, paneManager, stats, rateLimits }) {
      paneManager.subscribe('conversationLoaded', ({ conversation, isImported }) => stats.indexConversation(conversation, isImported));
      paneManager.subscribe('rateLimits', limits => rateLimits.setLimits(limits));
      directory.subscribe('conversationDeleted', conversationId => stats.removeConversation(conversationId));
    }

    /**
     * Redraws the tab strips when a chat pane's title can have changed.
     * @param {DockWorkspace} workspace The workspace.
     * @param {CombinedConversationDirectory} directory Shared conversation list, whose titles the chat tabs show.
     * @param {ChatPaneManager} paneManager Chat panes.
     * @returns {void}
     */
    static #refreshTabTitlesOnChange(workspace, directory, paneManager) {
      directory.subscribe('conversations', () => workspace.layout());
      paneManager.subscribe('paneConversations', () => workspace.layout());
    }

    /**
     * Removes every element and stylesheet this script added, other than the launcher button, so a
     * failed mount can still be retried.
     * @returns {void}
     */
    static #removeInterface() {
      document.querySelectorAll('.claude-plus-styles, body > [class*="claude-plus-"]:not(.claude-plus-launcher)').forEach(element => element.remove());
    }

    /**
     * Starts polling, loads stats, activity and the conversation list, opens the URL's conversation
     * in the focused pane and reopens the other panes' conversations.
     * @param {object} services Services created by #mountInterface.
     * @param {CombinedConversationDirectory} services.directory Shared conversation list.
     * @param {Router} services.router Navigation.
     * @param {ChatPaneManager} services.paneManager Chat panes.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {ActivityTracker} services.activity Active-time tracking.
     * @param {RateLimitMonitor} services.rateLimits Usage windows.
     * @param {ImportedConversationStore} services.importedConversations Imported conversations.
     * @returns {Promise<void>} Resolves once the focused pane's conversation is shown.
     */
    static async #loadData(services) {
      const { directory, router, paneManager, stats, activity, rateLimits } = services;
      rateLimits.start();
      await Promise.all([stats.refreshAggregate(), activity.start(), directory.refresh(), directory.refreshImported()]);
      ClaudePlusApp.#reindexImported(services);
      paneManager.openRestoredConversations();
      await router.start();
    }

    /**
     * Indexes, in the background, every imported conversation whose statistics are missing or
     * outdated, so imported chats are searchable however they got stored.
     * @param {object} services Services created by #mountInterface.
     * @param {CombinedConversationDirectory} services.directory Shared conversation list.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {ImportedConversationStore} services.importedConversations Imported conversations.
     * @returns {void}
     */
    static #reindexImported({ directory, stats, importedConversations }) {
      const listings = directory.conversations.filter(listing => ConversationListingFields.isImported(listing));
      stats.reindexImported(listings, conversationId => importedConversations.get(conversationId));
    }
  }

  /**
   * The always-on-top button that starts (or re-shows) ClaudePlus. It exists independently of the
   * rest of the app and carries its own inline styling, so it works before ClaudePlus's own
   * stylesheet is injected - which, until the first click, it never is: nothing else about
   * ClaudePlus loads until this is clicked, so a page nobody interacts with (such as the hidden
   * iframes the widget extractor briefly opens) never pays for it.
   */
  class ClaudePlusLauncher {
    /**
     * The button element.
     * @type {HTMLElement}
     */
    #button;

    /**
     * Creates the launcher.
     * @param {function(): void} onActivate Called when the button is clicked.
     */
    constructor(onActivate) {
      this.#button = createElement('button', {
        className: 'claude-plus-launcher',
        textContent: '💡',
        title: 'Open ClaudePlus',
        style: ClaudePlusLauncher.#style(),
      });
      this.#button.addEventListener('click', onActivate);
    }

    /**
     * Adds the button to the page.
     * @returns {void}
     */
    mount() {
      document.body.append(this.#button);
    }

    /**
     * Shows the button; only the native claude.ai UI should have it visible.
     * @returns {void}
     */
    show() {
      this.#button.style.display = '';
    }

    /**
     * Hides the button while ClaudePlus's own workspace is showing.
     * @returns {void}
     */
    hide() {
      this.#button.style.display = 'none';
    }

    /**
     * The button's inline styling, self-contained so it renders correctly before ClaudePlus's own
     * stylesheet exists.
     * @returns {string} The CSS text.
     */
    static #style() {
      return [
        'position:fixed', 'right:16px', 'bottom:16px', 'width:44px', 'height:44px', 'border-radius:50%',
        'border:none', 'background:#1a1918', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)', 'font-size:20px',
        'line-height:44px', 'text-align:center', 'padding:0', 'cursor:pointer', 'z-index:2147483647',
      ].join(';');
    }
  }

  /**
   * The launcher button; app.launch() is only referenced once app exists below, but this closure
   * isn't called until the button is clicked, well after that.
   * @type {ClaudePlusLauncher}
   */
  const launcher = new ClaudePlusLauncher(() => app.launch().catch(error => console.error(LOG_PREFIX, 'failed to start', error)));

  /**
   * The app, not started until the launcher button is clicked.
   * @type {ClaudePlusApp}
   */
  const app = new ClaudePlusApp(launcher);

  launcher.mount();

})();
