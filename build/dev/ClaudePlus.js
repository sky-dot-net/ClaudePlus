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
   * and extracted widget cards keyed by a hash of their tool name and data. Each store maps to its
   * key path.
   * @type {Readonly<{name: string, version: number, stores: Readonly<Record<string, string>>, keyPaths: Readonly<Record<string, string>>}>}
   */
  const DATABASE = Object.freeze({
    name: 'claudePlus',
    version: 2,
    stores: Object.freeze({ conversationSummaries: 'conversationSummaries', activity: 'activity', widgetCards: 'widgetCards' }),
    keyPaths: Object.freeze({ conversationSummaries: 'conversationId', activity: 'day', widgetCards: 'hash' }),
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
    tablePrefix: 'claudePlus.table.',
  });

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
   * Result limits. sidebarPageSize / backfillPageSize: conversations requested per API page.
   * listedSources: web sources listed at once. rankedOutlets: outlets in the ranking.
   * toolResultCharacters: characters of a tool result shown. provisionalTitleLength: characters of
   * the first prompt used as a new conversation's title. backfillRefreshInterval: conversations
   * stored between aggregate refreshes during a backfill. followOutputDistance: distance from the
   * bottom, in pixels, within which the chat keeps following new output. exportFileNameLength:
   * characters of the conversation title used in an export file name. comboboxEntries: values listed
   * by a filter typeahead. searchResults: results shown by the search panel.
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

  /**
   * Creates an element and assigns properties to it.
   * @param {string} tagName Tag name.
   * @param {object} properties Element properties to set, e.g. className, textContent, innerHTML, title, hidden.
   * @returns {HTMLElement} The new element.
   */
  function createElement(tagName, properties) {
    return Object.assign(document.createElement(tagName), properties);
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

  var stylesheet$n = ".claude-plus-empty-state {\r\n  color: var(--claude-plus-color-text-faint);\r\n  font-style: italic;\r\n  padding: 6px 0;\r\n}\r\n\r\n.claude-plus-empty-state--padded {\r\n  padding: 24px;\r\n}\r\n";

  StyleRegistry.register(stylesheet$n);

  /**
   * HTML for an empty-state message.
   * @param {string} message The message.
   * @returns {string} A div with the message.
   */
  function emptyStateHtml(message) {
    return `<div class="claude-plus-empty-state">${escapeHtml(message)}</div>`;
  }

  var stylesheet$m = ".claude-plus-value-combobox {\r\n  position: fixed;\r\n  z-index: var(--claude-plus-layer-popup-menu);\r\n  max-height: 240px;\r\n  overflow-y: auto;\r\n  background: var(--claude-plus-color-raised);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  padding: 4px;\r\n  font-size: 12px;\r\n}\r\n\r\n.claude-plus-value-combobox__entry {\r\n  padding: 4px 8px;\r\n  border-radius: 4px;\r\n  cursor: pointer;\r\n  white-space: nowrap;\r\n}\r\n\r\n.claude-plus-value-combobox__entry:hover {\r\n  background: var(--claude-plus-color-raised-hover);\r\n}\r\n";

  StyleRegistry.register(stylesheet$m);

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
   * Collects every descendant marked with a data-name attribute, keyed by that name.
   * @param {HTMLElement} root Element to search.
   * @returns {Object<string, HTMLElement>} The marked elements by name.
   */
  function collectNamedElements(root) {
    return Object.fromEntries([...root.querySelectorAll('[data-name]')].map(element => [element.dataset.name, element]));
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

  var stylesheet$l = ".claude-plus-column-table__column-picker {\r\n  flex-shrink: 0;\r\n  font-size: 11px;\r\n  color: var(--claude-plus-color-text-muted);\r\n}\r\n\r\ndetails.claude-plus-column-table__column-picker summary {\r\n  padding: 0;\r\n}\r\n\r\n.claude-plus-column-table__column-toggle {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  gap: 4px;\r\n  margin: 2px 10px 2px 0;\r\n  cursor: pointer;\r\n}\r\n\r\n.claude-plus-column-table__table {\r\n  width: 100%;\r\n  border-collapse: collapse;\r\n  font-size: 12px;\r\n}\r\n\r\n.claude-plus-column-table__table th {\r\n  text-align: left;\r\n  padding: 4px 6px;\r\n  color: var(--claude-plus-color-text-muted);\r\n  background: var(--claude-plus-color-raised);\r\n  position: sticky;\r\n  z-index: 1;\r\n  white-space: nowrap;\r\n  font-weight: 600;\r\n}\r\n\r\n.claude-plus-column-table__table thead tr:first-child th {\r\n  top: 0;\r\n}\r\n\r\n.claude-plus-column-table__filter-row th {\r\n  top: 24px;\r\n  padding-top: 0;\r\n  border-bottom: 1px solid var(--claude-plus-color-border-strong);\r\n  font-weight: normal;\r\n}\r\n\r\n.claude-plus-column-table__sortable {\r\n  cursor: pointer;\r\n  user-select: none;\r\n}\r\n\r\n.claude-plus-column-table__sortable:hover {\r\n  color: var(--claude-plus-color-text);\r\n}\r\n\r\n.claude-plus-panel .claude-plus-column-table__filter-input {\r\n  display: block;\r\n  width: 100%;\r\n  min-width: 40px;\r\n  box-sizing: border-box;\r\n  padding: 2px 4px;\r\n  font-size: 11px;\r\n}\r\n\r\n.claude-plus-panel input[type=date].claude-plus-column-table__filter-input {\r\n  min-width: 0;\r\n  max-width: 112px;\r\n  padding: 1px 2px;\r\n  font-size: 10px;\r\n}\r\n\r\n.claude-plus-panel input[type=date].claude-plus-column-table__filter-input + input[type=date] {\r\n  margin-top: 2px;\r\n}\r\n\r\n.claude-plus-column-table__cell {\r\n  padding: 4px 6px;\r\n  border-bottom: 1px solid var(--claude-plus-color-border-faint);\r\n  vertical-align: top;\r\n}\r\n\r\n.claude-plus-column-table__cell--name,\r\n.claude-plus-column-table__cell--title,\r\n.claude-plus-column-table__cell--match {\r\n  width: 100%;\r\n  max-width: 1px;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.claude-plus-column-table__cell a {\r\n  color: var(--claude-plus-color-accent);\r\n  text-decoration: none;\r\n}\r\n\r\n.claude-plus-column-table__cell a:hover {\r\n  text-decoration: underline;\r\n}\r\n";

  StyleRegistry.register(stylesheet$l);

  /**
   * A reusable table with toggleable columns, sorting by clicking a header (clicking again reverses
   * it), and per-column filters under the headers: typeahead wildcard filters for text columns and
   * date ranges for timestamp columns. Column visibility and sort order persist per table id.
   */
  class ColumnTable {
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
     * Most rows rendered at once, after filtering and sorting.
     * @type {number}
     */
    #maxRenderedRows;

    /**
     * Current rows, unfiltered.
     * @type {object[]}
     */
    #rows = [];

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
     * @param {number} [options.maxRenderedRows] Most rows rendered at once; unlimited by default.
     */
    constructor({ container, tableId, columns, preferences, defaultSort, rowAttributes, emptyText, maxRenderedRows = Infinity }) {
      this.#storageKey = `${STORAGE_KEYS.tablePrefix}${tableId}`;
      this.#columns = columns;
      this.#preferences = preferences;
      this.#rowAttributes = rowAttributes;
      this.#emptyText = emptyText;
      this.#maxRenderedRows = maxRenderedRows;
      const stored = preferences.readJson(this.#storageKey) ?? {};
      this.#visibility = new ColumnVisibility(columns, stored.visibleColumnIds);
      this.#sortOrder = new SortOrder(columns, stored.sortOrder, defaultSort);
      this.#filters = new RowFilterSet(columns);
      container.innerHTML = ColumnTable.#skeletonHtml(columns);
      this.#elements = collectNamedElements(container);
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
      return `${picker}<div class="claude-plus-scrollable claude-plus-fill-remaining claude-plus-column-table"><table class="claude-plus-column-table__table"><thead><tr data-name="headerRow"></tr><tr class="claude-plus-column-table__filter-row" data-name="filterRow"></tr></thead><tbody data-name="tableBody"></tbody></table></div>`;
    }

    /**
     * Wires sorting, column toggles and filters.
     * @returns {void}
     */
    #bindEvents() {
      this.#elements.headerRow.addEventListener('click', event => this.#onHeaderClick(event));
      this.#elements.filterRow.addEventListener('input', event => this.#onFilterInput(event));
      if (this.#elements.columnToggles) this.#elements.columnToggles.addEventListener('change', event => this.#onColumnToggle(event));
    }

    /**
     * Sorts by the clicked header's column.
     * @param {MouseEvent} event Click in the header row.
     * @returns {void}
     */
    #onHeaderClick(event) {
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
     * Stores column visibility and sort order.
     * @returns {void}
     */
    #saveSettings() {
      this.#preferences.writeJson(this.#storageKey, { visibleColumnIds: this.#visibility.visibleColumnIds, sortOrder: this.#sortOrder });
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
     * HTML of one header cell.
     * @param {TableColumn} column The column.
     * @returns {string} The cell; sortable columns carry data-sort-column and show ▲ or ▼ while sorted.
     */
    #headerCellHtml(column) {
      if (column.isNotSortable) return `<th>${escapeHtml(column.label)}</th>`;
      return `<th class="claude-plus-column-table__sortable" data-sort-column="${column.id}">${escapeHtml(column.label)}${this.#sortOrder.indicatorFor(column.id)}</th>`;
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
     * Renders the rows passing the filters, sorted and limited.
     * @returns {void}
     */
    #renderBody() {
      const visibleColumns = this.#visibility.visibleColumns;
      const rows = this.#sortOrder.sort(this.#filters.apply(this.#rows, this.#visibility)).slice(0, this.#maxRenderedRows);
      this.#elements.tableBody.innerHTML = rows.map(row => this.#rowHtml(row, visibleColumns)).join('')
        || `<tr><td colspan="${visibleColumns.length}" class="claude-plus-empty-state">${escapeHtml(this.#emptyText)}</td></tr>`;
    }

    /**
     * HTML of one row.
     * @param {object} row The row.
     * @param {TableColumn[]} visibleColumns Columns to render.
     * @returns {string} The tr element.
     */
    #rowHtml(row, visibleColumns) {
      const cells = visibleColumns.map(column => `<td class="claude-plus-column-table__cell claude-plus-column-table__cell--${column.id}">${column.cellHtml(row)}</td>`);
      return `<tr ${this.#rowAttributes(row)}>${cells.join('')}</tr>`;
    }
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

  var stylesheet$k = ".claude-plus-subpane {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 4px;\r\n  min-height: 0;\r\n  flex: 1;\r\n  padding: 6px;\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  background: var(--claude-plus-color-bar);\r\n}\r\n\r\n.claude-plus-subpane__header {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 2px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-subpane__title {\r\n  flex: 1;\r\n  min-width: 0;\r\n  font-size: 12px;\r\n  font-weight: 600;\r\n  white-space: nowrap;\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n}\r\n\r\n.claude-plus-subpane__button {\r\n  background: none;\r\n  border: none;\r\n  color: var(--claude-plus-color-text-faint);\r\n  cursor: pointer;\r\n  padding: 2px 5px;\r\n  border-radius: 4px;\r\n}\r\n\r\n.claude-plus-subpane__button:hover {\r\n  background: var(--claude-plus-color-hover);\r\n  color: var(--claude-plus-color-text);\r\n}\r\n";

  StyleRegistry.register(stylesheet$k);

  /**
   * A sub-pane inside a chat pane listing the web sources or files of that pane's conversation.
   * It can be docked to the pane's left, top or right edge and closed.
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
     */
    constructor({ kind, session, stats, preferences, onClose, onMove }) {
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
        rowAttributes: () => '',
        emptyText: 'Nothing recorded for this chat yet.',
      });
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

  var stylesheet$j = ".claude-plus-image-viewer-overlay {\r\n  position: fixed;\r\n  inset: 0;\r\n  z-index: var(--claude-plus-layer-drag-label);\r\n  background: rgba(0, 0, 0, 0.8);\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: center;\r\n  justify-content: center;\r\n  gap: 12px;\r\n}\r\n\r\n.claude-plus-image-viewer__frame {\r\n  max-width: 90vw;\r\n  max-height: 90vh;\r\n  overflow: hidden;\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n}\r\n\r\n.claude-plus-image-viewer__image {\r\n  max-width: 90vw;\r\n  max-height: 90vh;\r\n  width: auto;\r\n  height: auto;\r\n  cursor: grab;\r\n  user-select: none;\r\n}\r\n\r\n.claude-plus-image-viewer__open-button {\r\n  flex-shrink: 0;\r\n}\r\n";

  StyleRegistry.register(stylesheet$j);

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
   * Groups a message's thinking and ordinary tool-call content blocks into a chronological list of
   * steps — each tool call paired with its result — so a message's "thinking and tool calls"
   * sub-pane can list what happened without that ever appearing in the chat log itself. A widget
   * tool call (see WIDGET_TOOL_NAMES) is excluded here since it renders inline in the message
   * instead (see MessageContent), not hidden in this sub-pane.
   */
  class MessageToolSteps {
    /**
     * Steps of a message, in the order they happened.
     * @param {?ApiMessage} apiMessage The message; null or content-less for a local-only message.
     * @returns {Array<{kind: 'thinking', block: ContentBlock}|{kind: 'tool', useBlock: ContentBlock, resultBlock: ?ContentBlock}>}
     * The steps; empty when the message has none.
     */
    static stepsOf(apiMessage) {
      const blocks = apiMessage?.content ?? [];
      const steps = [];
      const stepByToolUseId = new Map();
      blocks.forEach(block => MessageToolSteps.#addBlock(block, steps, stepByToolUseId));
      return steps;
    }

    /**
     * Folds one content block into the steps being built.
     * @param {ContentBlock} block The block.
     * @param {Array<object>} steps Steps accumulated so far.
     * @param {Map<string, object>} stepByToolUseId Tool steps by their call's id, to attach a matching result.
     * @returns {void}
     */
    static #addBlock(block, steps, stepByToolUseId) {
      if (block.type === 'thinking') steps.push({ kind: 'thinking', block });
      else if (block.type === 'tool_use' && !WIDGET_TOOL_NAMES.includes(block.name)) MessageToolSteps.#addToolUse(block, steps, stepByToolUseId);
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

  var stylesheet$i = ".claude-plus-message-list {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  padding: 4px 2px;\n}\n\n.claude-plus-message {\n  max-width: 78%;\n}\n\n.claude-plus-message--human {\n  align-self: flex-end;\n  text-align: right;\n}\n\n.claude-plus-message--human:not(.claude-plus-message--editing) {\n  display: flex;\n  flex-direction: column;\n  align-items: flex-end;\n}\n\n.claude-plus-message--human .claude-plus-message__actions {\n  justify-content: flex-end;\n}\n\n.claude-plus-message--assistant {\n  align-self: stretch;\n  max-width: 100%;\n}\n\n.claude-plus-message--editing {\n  max-width: 92%;\n}\n\n.claude-plus-message__attachments {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  margin-bottom: 6px;\n}\n\n.claude-plus-message--human .claude-plus-message__bubble {\n  background: var(--claude-plus-color-message-human-bg);\n  border-radius: 14px;\n  padding: 8px 12px;\n}\n\n.claude-plus-message__body {\n  font-size: var(--claude-plus-message-font-size, 14px);\n  line-height: 1.55;\n  overflow-wrap: break-word;\n}\n\n.claude-plus-message--assistant .claude-plus-message__body {\n  font-size: calc(var(--claude-plus-message-font-size, 14px) + 2px);\n}\n\n.claude-plus-message__actions {\n  display: flex;\n  align-items: center;\n  gap: 2px;\n  margin-top: 6px;\n  flex-wrap: wrap;\n}\n\n.claude-plus-message__action-button {\n  background: none;\n  border: none;\n  color: var(--claude-plus-color-text-muted);\n  cursor: pointer;\n  font-size: 13px;\n  line-height: 1.4;\n  padding: 4px 6px;\n  border-radius: 20px;\n}\n\n.claude-plus-message__action-button:hover {\n  background: var(--claude-plus-color-border-strong);\n  color: var(--claude-plus-color-text);\n}\n\n.claude-plus-message__action-button--primary {\n  background: var(--claude-plus-color-accent);\n  color: #fff;\n}\n\n.claude-plus-message__action-button--primary:hover {\n  background: var(--claude-plus-color-accent);\n  filter: brightness(1.1);\n}\n\n.claude-plus-message__branch-nav {\n  display: inline-flex;\n  align-items: center;\n  gap: 2px;\n  margin-right: 4px;\n  font-size: 12px;\n  color: var(--claude-plus-color-text-faint);\n}\n\n.claude-plus-message__branch-nav-button {\n  background: none;\n  border: none;\n  color: inherit;\n  cursor: pointer;\n  font-size: 15px;\n  line-height: 1;\n  padding: 4px 6px;\n  border-radius: 20px;\n}\n\n.claude-plus-message__branch-nav-button:hover:not(:disabled) {\n  background: var(--claude-plus-color-border-strong);\n  color: var(--claude-plus-color-text);\n}\n\n.claude-plus-message__branch-nav-button:disabled {\n  opacity: 0.35;\n  cursor: default;\n}\n\n.claude-plus-message__branch-nav-count {\n  min-width: 28px;\n  text-align: center;\n}\n\n.claude-plus-message__edit-input {\n  width: 100%;\n  box-sizing: border-box;\n  resize: vertical;\n  min-height: 60px;\n  border-radius: 10px;\n  padding: 8px 10px;\n  font: inherit;\n  font-size: var(--claude-plus-message-font-size, 14px);\n  line-height: 1.5;\n  text-align: left;\n  background: var(--claude-plus-color-bar);\n  border: 1px solid var(--claude-plus-color-border-strong);\n  color: var(--claude-plus-color-text);\n}\n\n.claude-plus-message-error {\n  color: var(--claude-plus-color-error);\n  margin-top: 6px;\n}\n\n.claude-plus-streaming-cursor {\n  animation: claude-plus-blink 1s step-start infinite;\n}\n\n@keyframes claude-plus-blink {\n  50% {\n    opacity: 0;\n  }\n}\n";

  StyleRegistry.register(stylesheet$i);

  /**
   * The messages of a chat session: copy, retry, branch navigation between a message's edits and
   * retries, and double-click (or the edit button) to edit a human message, which sends the new text
   * as a sibling branch. Streaming updates re-render only the affected message, at most once per
   * animation frame.
   */
  class MessageListView {
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
      listElement.addEventListener('click', event => this.#onClick(event));
      listElement.addEventListener('dblclick', event => this.#onDoubleClick(event));
      listElement.addEventListener('keydown', event => this.#onEditKeydown(event));
      ownerPanel.listenTo(session, 'messages', () => this.render());
      ownerPanel.listenTo(session, 'sending', () => this.render());
      ownerPanel.listenTo(session, 'messageContent', message => this.#scheduleMessageUpdate(message));
    }

    /**
     * Re-renders every message, keeping the view at the bottom if it was there.
     * @returns {void}
     */
    render() {
      this.#changedMessages.clear();
      this.#updateScheduler.cancel();
      const wasAtBottom = this.#isScrolledToBottom();
      const messages = this.#session.messages;
      const retryableIndex = this.#session.isSending ? -1 : messages.findLastIndex(message => message.sender === 'assistant');
      this.#listElement.innerHTML = messages.map((message, index) => this.#messageHtml(message, index, index === retryableIndex)).join('')
        || '<div class="claude-plus-empty-state claude-plus-empty-state--padded">Start a conversation using the message box below.</div>';
      this.#scrollToBottomIf(wasAtBottom);
      this.#focusEditInputIfEditing();
      this.#fillWidgetSlots();
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
      const wasAtBottom = this.#isScrolledToBottom();
      this.#changedMessages.forEach(message => this.#renderMessageBody(message));
      this.#changedMessages.clear();
      this.#scrollToBottomIf(wasAtBottom);
    }

    /**
     * Re-renders one message's body, if it is still shown.
     * @param {ChatMessage} message The message.
     * @returns {void}
     */
    #renderMessageBody(message) {
      const index = this.#session.messages.indexOf(message);
      const container = this.#listElement.querySelector(`[data-message-index="${index}"]`);
      const body = container ? container.querySelector('.claude-plus-message__body') : null;
      if (body) body.innerHTML = MessageListView.#messageBodyHtml(message);
      if (container) this.#fillWidgetSlotsIn(container, message);
    }

    /**
     * Starts filling every currently rendered message's widget slots with their real cards.
     * @returns {void}
     */
    #fillWidgetSlots() {
      this.#session.messages.forEach((message, index) => {
        const container = this.#listElement.querySelector(`[data-message-index="${index}"]`);
        if (container) this.#fillWidgetSlotsIn(container, message);
      });
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
      const editButton = sender === 'human' && message.isPersisted
        ? '<button class="claude-plus-message__action-button" data-action="startEdit" title="Edit and branch from here">✎</button>' : '';
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
     * Starts editing the human message double-clicked on, unless it hasn't been persisted yet.
     * @param {MouseEvent} event Double-click inside the list.
     * @returns {void}
     */
    #onDoubleClick(event) {
      if (event.target.closest('[data-action], .claude-plus-message__edit-input')) return;
      const container = event.target.closest('.claude-plus-message--human');
      if (!container) return;
      const index = MessageListView.#indexOf(container);
      if (this.#session.messages[index]?.isPersisted) this.#startEdit(index);
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

    /**
     * Whether the list is scrolled to (or near) the bottom.
     * @returns {boolean} True within LIMITS.followOutputDistance of the bottom.
     */
    #isScrolledToBottom() {
      const list = this.#listElement;
      return list.scrollHeight - list.scrollTop - list.clientHeight < LIMITS.followOutputDistance;
    }

    /**
     * Scrolls to the bottom if the list was there before an update.
     * @param {boolean} wasAtBottom Whether the list was at the bottom.
     * @returns {void}
     */
    #scrollToBottomIf(wasAtBottom) {
      if (wasAtBottom) this.#listElement.scrollTop = this.#listElement.scrollHeight;
    }
  }

  var stylesheet$h = ".claude-plus-tool-steps {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 2px;\n}\n\n.claude-plus-tool-step {\n  background: var(--claude-plus-color-tool-details);\n  border-radius: 6px;\n  padding: 6px 8px;\n  font-size: 12px;\n}\n\n.claude-plus-tool-step--error {\n  box-shadow: inset 2px 0 0 var(--claude-plus-color-error);\n}\n\n.claude-plus-tool-step summary {\n  cursor: pointer;\n  font-weight: 600;\n}\n\n.claude-plus-tool-step__summaries {\n  margin: 6px 0 0;\n  padding-left: 18px;\n  color: var(--claude-plus-color-text-muted);\n}\n\n.claude-plus-tool-step__field-label {\n  margin-top: 8px;\n  font-size: 11px;\n  font-weight: 600;\n  color: var(--claude-plus-color-text-faint);\n  text-transform: uppercase;\n  letter-spacing: 0.03em;\n}\n\n.claude-plus-tool-step__pre {\n  margin: 2px 0 0;\n  white-space: pre-wrap;\n  overflow-wrap: break-word;\n  font-size: 11px;\n  color: var(--claude-plus-color-text-muted);\n}\n\n.claude-plus-tool-step__result-status {\n  margin-top: 8px;\n  font-weight: 600;\n}\n";

  StyleRegistry.register(stylesheet$h);

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
      return step.kind === 'thinking' ? MessageToolStepsPane.#thinkingStepHtml(step) : MessageToolStepsPane.#toolStepHtml(step);
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

  var stylesheet$g = ".claude-plus-panel {\r\n  position: fixed;\r\n  z-index: var(--claude-plus-layer-panel);\r\n  box-sizing: border-box;\r\n  padding: 10px 12px;\r\n  overflow-y: auto;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  font-size: 13px;\r\n  background: var(--claude-plus-color-background);\r\n}\r\n\r\n.claude-plus-panel summary {\r\n  cursor: pointer;\r\n  padding: 4px 0;\r\n}\r\n\r\n.claude-plus-panel select,\r\n.claude-plus-panel input[type=text],\r\n.claude-plus-panel input[type=date],\r\n.claude-plus-panel textarea {\r\n  background: var(--claude-plus-color-bar);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  color: var(--claude-plus-color-text);\r\n  font-size: 12px;\r\n  font-family: inherit;\r\n}\r\n\r\n.claude-plus-panel__section {\r\n  padding: 8px 0;\r\n  border-bottom: 1px solid var(--claude-plus-color-hover);\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-panel__section:last-child {\r\n  border-bottom: none;\r\n}\r\n\r\n.claude-plus-spaced-above {\r\n  margin-top: 6px;\r\n}\r\n\r\n.claude-plus-hint {\r\n  color: var(--claude-plus-color-text-faint);\r\n  font-size: 11px;\r\n  margin-top: 4px;\r\n}\r\n\r\n.claude-plus-scrollable {\r\n  overflow-y: auto;\r\n}\r\n\r\n.claude-plus-fill-remaining {\r\n  flex: 1;\r\n  min-height: 0;\r\n}\r\n\r\n.claude-plus-pending {\r\n  opacity: 0.4;\r\n  pointer-events: none;\r\n}\r\n\r\n.claude-plus-primary-button {\r\n  padding: 8px;\r\n  background: var(--claude-plus-color-accent);\r\n  border: none;\r\n  border-radius: 6px;\r\n  color: #fff;\r\n  font-size: 13px;\r\n  cursor: pointer;\r\n  font-weight: 600;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-primary-button:disabled {\r\n  opacity: 0.6;\r\n  cursor: default;\r\n}\r\n\r\n.claude-plus-full-width {\r\n  width: 100%;\r\n}\r\n\r\n.claude-plus-search-input {\r\n  flex-shrink: 0;\r\n  padding: 6px 8px;\r\n}\r\n";

  StyleRegistry.register(stylesheet$g);

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

  var stylesheet$f = ".claude-plus-panel--active-among-several {\r\n  box-shadow: inset 0 0 0 1px var(--claude-plus-color-active-chat);\r\n}\r\n\r\n.claude-plus-chat-layout {\r\n  display: flex;\r\n  gap: 8px;\r\n  flex: 1;\r\n  min-height: 0;\r\n}\r\n\r\n.claude-plus-chat-layout__center {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  flex: 1;\r\n  min-width: 0;\r\n}\r\n\r\n.claude-plus-chat-layout__side {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  width: 300px;\r\n  flex-shrink: 0;\r\n  min-height: 0;\r\n}\r\n\r\n.claude-plus-chat-layout__top {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-chat-layout__side:empty,\r\n.claude-plus-chat-layout__top:empty {\r\n  display: none;\r\n}\r\n\r\n.claude-plus-chat-layout__top .claude-plus-subpane {\r\n  height: 200px;\r\n  flex: none;\r\n}\r\n";

  StyleRegistry.register(stylesheet$f);

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
     * @type {ConversationDirectory}
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
     * Open sub-panes by kind: 'files' and 'sources' are ConversationSubPane, 'toolSteps' (a
     * message's thinking and tool-call steps) is a MessageToolStepsPane.
     * @type {Map<string, ConversationSubPane|MessageToolStepsPane>}
     */
    #subPanes = new Map();

    /**
     * Creates the pane's panel.
     * @param {object} services Panel dependencies.
     * @param {string} services.paneId Pane id.
     * @param {ChatSession} services.session Session shown in this pane.
     * @param {ConversationDirectory} services.directory Shared conversation list, for the tab title.
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
     * Opens a sub-pane on the right edge, or closes it if one of that kind is already open.
     * @param {string} kind 'files' or 'sources'.
     * @returns {void}
     */
    openSubPane(kind) {
      if (this.#subPanes.has(kind)) {
        this.#closeSubPane(kind);
        return;
      }
      const subPane = new ConversationSubPane({
        kind,
        session: this.#session,
        stats: this.#stats,
        preferences: this.#preferences,
        onClose: closedKind => this.#closeSubPane(closedKind),
        onMove: (movedKind, edge) => this.#dockSubPane(movedKind, edge),
      });
      this.#subPanes.set(kind, subPane);
      this.#dockSubPane(kind, this.#storedSubPaneEdge(kind));
    }

    /**
     * Disposes the sub-panes and ends the subscriptions.
     * @returns {void}
     */
    dispose() {
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
     * Marks the pane while it is the active chat, and shows the green border only while more than
     * one chat pane is visible.
     * @returns {void}
     */
    #renderFocus() {
      const isActive = this.#paneManager.focusedPaneId === this.#paneId;
      this.element.classList.toggle('claude-plus-panel--focused', isActive);
      this.element.classList.toggle('claude-plus-panel--active-among-several', isActive && this.#paneManager.hasSeveralVisiblePanes);
    }
  }

  /**
   * Upload fields that may hold a display name, in order of preference.
   * @type {ReadonlyArray<string>}
   */
  const ATTACHMENT_NAME_FIELDS = Object.freeze(['file_name', 'name', 'filename', 'title']);

  var stylesheet$e = ".claude-plus-code-block {\r\n  background: var(--claude-plus-color-code-block);\r\n  padding: 8px;\r\n  border-radius: 6px;\r\n  overflow-x: auto;\r\n  font-size: 12px;\r\n}\r\n";

  StyleRegistry.register(stylesheet$e);

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

  var stylesheet$d = ".claude-plus-message-text {\r\n  white-space: normal;\r\n}\r\n\r\n.claude-plus-message-text a {\r\n  color: var(--claude-plus-color-accent);\r\n}\r\n\r\n.claude-plus-message-attachment {\r\n  color: var(--claude-plus-color-text-muted);\r\n  font-size: 12px;\r\n  margin-bottom: 4px;\r\n}\r\n\r\n.claude-plus-message-images {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  gap: 6px;\r\n  margin-bottom: 6px;\r\n}\r\n\r\n.claude-plus-message--human .claude-plus-message-images {\r\n  justify-content: flex-end;\r\n}\r\n\r\n.claude-plus-message-image {\r\n  display: block;\r\n  max-height: 300px;\r\n  max-width: 100%;\r\n  border-radius: 8px;\r\n  cursor: zoom-in;\r\n}\r\n\r\n";

  StyleRegistry.register(stylesheet$d);

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
      const rendered = blocks.map(block => MessageContent.#bodyBlock(block));
      const blocksHtml = rendered.map(item => item.html).join('');
      const bodyHtml = blocksHtml || MessageContent.textHtml(apiMessage.text);
      const widgets = rendered.map(item => item.widget).filter(Boolean);
      return { attachmentsHtml, bodyHtml: bodyHtml || (attachmentsHtml ? '' : MessageContent.#NO_CONTENT_HTML), widgets };
    }

    /**
     * HTML (and, for a widget, the extraction job) of one content block.
     * @param {ContentBlock} block The block.
     * @returns {{html: string, widget: ?{toolName: string, data: object, toolUseId: string}}} The
     * block's HTML, and its widget job if it is one.
     */
    static #bodyBlock(block) {
      if (block.type === 'text' && block.text) return { html: MessageContent.textHtml(block.text), widget: null };
      if (block.type === 'tool_use' && WIDGET_TOOL_NAMES.includes(block.name)) return MessageContent.#widgetBlock(block);
      return { html: '', widget: null };
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
     * HTML of a non-image upload, shown as a plain named chip.
     * @param {object} upload The upload.
     * @returns {string} The HTML.
     */
    static #fileAttachmentHtml(upload) {
      return `<div class="claude-plus-message-attachment">📎 ${escapeHtml(MessageContent.uploadName(upload))}</div>`;
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
     * @param {AbortController} fields.abortController Aborts the request.
     */
    constructor({ conversationId, isNewConversation, prompt, promptMessage, files, abortController }) {
      this.conversationId = conversationId;
      this.isNewConversation = isNewConversation;
      this.prompt = prompt;
      this.promptMessage = promptMessage;
      this.files = files;
      this.abortController = abortController;
      this.replyMessage = null;
      this.hasFailed = false;
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
   * Chat messages of a conversation's current branch.
   * @param {ApiConversation} conversation The conversation.
   * @returns {ChatMessage[]} The messages, oldest first.
   */
  function currentBranchMessages(conversation) {
    return ConversationTree.currentBranch(conversation).map(apiMessage => ChatMessage.fromApi(apiMessage));
  }

  /**
   * One chat: the conversation open in a chat pane, its messages and the prompt being sent. Every
   * chat pane has its own session, so several conversations can be open and streaming at once.
   * @fires ChatSession#openConversation The open conversation changed.
   * @fires ChatSession#messages The message list changed.
   * @fires ChatSession#messageContent One message's content changed; payload is the ChatMessage.
   * @fires ChatSession#sending Sending started or ended.
   * @fires ChatSession#conversationLoaded A conversation was fetched; payload is the ApiConversation.
   * @fires ChatSession#rateLimits Usage windows arrived in a stream; payload is RateLimits.
   */
  class ChatSession extends EventEmitter {
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
     * Shared conversation list, updated when this session creates or reloads a conversation.
     * @type {ConversationDirectory}
     */
    #directory;

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
     * Whether a prompt is being sent.
     * @type {boolean}
     */
    #isSending = false;

    /**
     * Aborts the prompt being sent.
     * @type {?AbortController}
     */
    #abortController = null;

    /**
     * Numbers navigations, so late responses for an old one are dropped.
     * @type {NavigationCounter}
     */
    #navigations = new NavigationCounter();

    /**
     * Applies completion stream events to the turn being sent.
     * @type {StreamEventApplier}
     */
    #streamEvents = new StreamEventApplier({
      appendMessage: message => this.#setMessages([...this.#messages, message]),
      registerNewConversation: (conversationId, prompt) => this.#registerNewConversation(conversationId, prompt),
      publish: (eventName, payload) => this.publish(eventName, payload),
    });

    /**
     * Creates an empty session showing a new chat.
     * @param {ClaudeApi} api API client.
     * @param {ComposerSettings} settings Model options for new prompts.
     * @param {ConversationDirectory} directory Shared conversation list.
     */
    constructor(api, settings, directory) {
      super();
      this.#api = api;
      this.#settings = settings;
      this.#directory = directory;
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
     * Uploads a file to the conversation a prompt sent right now would use.
     * @param {File} file File to upload.
     * @returns {Promise<UploadedFile>} The server's record of the upload.
     * @throws {ApiError} When the request fails.
     */
    uploadFile(file) {
      return this.#api.uploadFile(this.targetConversationId, file);
    }

    /**
     * Position of a message among its siblings (its other edits or retries), for a branch-switch
     * control. Null when it has no siblings besides itself, or before the conversation has loaded.
     * @param {string} messageId Message id.
     * @returns {?{index: number, count: number}} Its zero-based position and the sibling count, or null.
     */
    branchInfoFor(messageId) {
      if (!this.#conversation) return null;
      const siblings = ConversationTree.siblingsOf(this.#conversation, messageId);
      if (siblings.length <= 1) return null;
      return { index: siblings.findIndex(sibling => sibling.uuid === messageId), count: siblings.length };
    }

    /**
     * Switches to a sibling version of a message (an edit or a retried reply), landing on that
     * version's latest leaf, and persists the choice server-side. Ignored while sending, before the
     * conversation has loaded, or when there is no sibling in that direction.
     * @param {string} messageId Message id.
     * @param {number} step -1 for the previous version, +1 for the next.
     * @returns {Promise<void>} Resolves once switched.
     */
    async switchBranch(messageId, step) {
      if (this.#isSending || !this.#conversation) return;
      const siblings = ConversationTree.siblingsOf(this.#conversation, messageId);
      const target = siblings[siblings.findIndex(sibling => sibling.uuid === messageId) + step];
      if (!target) return;
      const leafId = ConversationTree.latestLeafFrom(this.#conversation, target.uuid);
      await this.#api.setCurrentLeafMessage(this.#openConversationId, leafId);
      this.#conversation = { ...this.#conversation, current_leaf_message_uuid: leafId };
      this.#setMessages(currentBranchMessages(this.#conversation));
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
      const message = this.#messages[index];
      if (this.#isSending || !newText.trim() || !ChatSession.#isEditableHumanMessage(message)) return Promise.resolve();
      this.#setMessages(this.#messages.slice(0, index));
      return this.#sendPromptAfter(newText, message.parentId, []);
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
    async openConversation(conversationId) {
      const navigation = this.#beginNavigation(conversationId);
      try {
        const conversation = await this.#api.getConversation(conversationId);
        if (this.#navigations.isLatest(navigation)) this.#showConversation(conversation);
      } catch (error) {
        this.#showLoadError(navigation, error);
      }
    }

    /**
     * Switches to an empty new chat, stopping any reply in progress.
     * @returns {void}
     */
    startNewConversation() {
      this.#beginNavigation(null);
    }

    /**
     * Aborts the reply in progress, keeping the text received so far.
     * @returns {void}
     */
    stopReply() {
      if (this.#abortController) this.#abortController.abort();
    }

    /**
     * Sends a prompt as a reply to the last persisted message. Ignored while sending or for blank prompts.
     * @param {string} prompt Prompt text.
     * @param {UploadedFile[]} [files] Files uploaded beforehand to attach.
     * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
     */
    sendPrompt(prompt, files = []) {
      return this.#sendPromptAfter(prompt, this.#lastPersistedMessageIdBefore(this.#messages.length), files);
    }

    /**
     * Asks the last prompt again as a new branch from the same parent, replacing the answer shown.
     * Ignored while sending.
     * @returns {void}
     */
    retryLastPrompt() {
      if (this.#isSending) return;
      const promptIndex = this.#messages.findLastIndex(message => message.sender === 'human');
      if (promptIndex === -1) return;
      const promptMessage = this.#messages[promptIndex];
      this.#setMessages(this.#messages.slice(0, promptIndex));
      this.#sendPromptAfter(promptMessage.text, promptMessage.parentId ?? this.#lastPersistedMessageIdBefore(promptIndex), []);
    }

    /**
     * Stops any reply, clears the messages and makes a conversation (or a new chat) open.
     * @param {?string} conversationId Conversation to open, or null for a new chat.
     * @returns {number} Number identifying this navigation.
     */
    #beginNavigation(conversationId) {
      this.stopReply();
      const navigation = this.#navigations.begin();
      this.#setOpenConversation(conversationId);
      this.#conversation = null;
      this.#setMessages([]);
      return navigation;
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
      this.#setMessages([createErrorNotice(`Could not load this conversation (${error.message}).`)]);
    }

    /**
     * Sends a prompt as a reply to a given message and streams the answer into the chat.
     * @param {string} prompt Prompt text; ignored if blank.
     * @param {?string} parentMessageId Message to reply to; null for the conversation root.
     * @param {UploadedFile[]} files Files uploaded beforehand to attach.
     * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
     */
    async #sendPromptAfter(prompt, parentMessageId, files) {
      if (!prompt.trim() || this.#isSending) return;
      const turn = this.#beginTurn(prompt, parentMessageId, files);
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
     * @returns {Turn} The new turn.
     */
    #beginTurn(prompt, parentMessageId, files) {
      const promptMessage = new ChatMessage({
        id: createLocalMessageId(), parentId: parentMessageId, sender: 'human', text: prompt, isPersisted: false,
        apiMessage: files.length ? { text: prompt, attachments: [], files, content: [] } : null,
      });
      const turn = new Turn({
        conversationId: this.targetConversationId,
        isNewConversation: this.#openConversationId === null,
        prompt,
        promptMessage,
        files,
        abortController: new AbortController(),
      });
      this.#abortController = turn.abortController;
      this.#setMessages([...this.#messages, promptMessage]);
      this.#setSending(true);
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
        fileUuids: turn.files.map(file => file.file_uuid),
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
      else this.#messages.push(createErrorNotice(error.message));
    }

    /**
     * Ends sending and, if the server accepted the prompt, reloads the conversation from the server.
     * @param {Turn} turn The turn.
     * @returns {void}
     */
    #finishTurn(turn) {
      if (turn.replyMessage) turn.replyMessage.isStreaming = false;
      if (this.#abortController === turn.abortController) this.#abortController = null;
      this.#setSending(false);
      this.publish('messages');
      if (turn.promptMessage.isPersisted) this.#reloadAfterSend(turn.conversationId, !turn.hasFailed);
    }

    /**
     * Fetches the conversation after a send to update the list and the stats, and replaces the
     * optimistic messages with the server's copy (real tool blocks and parent ids).
     * @param {string} conversationId Conversation id.
     * @param {boolean} replaceMessages False after a failure, so the error stays on screen.
     * @returns {Promise<void>} Resolves once done; failures are logged.
     */
    async #reloadAfterSend(conversationId, replaceMessages) {
      try {
        const conversation = await this.#api.getConversation(conversationId);
        this.#directory.updateListing(conversation);
        this.publish('conversationLoaded', conversation);
        if (replaceMessages && this.#isOpenAndIdle(conversationId)) {
          this.#conversation = conversation;
          this.#setMessages(currentBranchMessages(conversation));
        }
      } catch (error) {
        console.warn(LOG_PREFIX, 'refreshing conversation failed', error);
      }
    }

    /**
     * Whether a conversation is open here and not sending.
     * @param {string} conversationId Conversation id.
     * @returns {boolean} True when its messages can be replaced safely.
     */
    #isOpenAndIdle(conversationId) {
      return this.#openConversationId === conversationId && !this.#isSending;
    }

    /**
     * Shows a fetched conversation's current branch and publishes it for the stats.
     * @param {ApiConversation} conversation The conversation.
     * @returns {void}
     */
    #showConversation(conversation) {
      this.#conversation = conversation;
      this.#setMessages(currentBranchMessages(conversation));
      this.publish('conversationLoaded', conversation);
    }

    /**
     * Lists a just-created conversation and makes it the open one.
     * @param {string} conversationId Conversation id.
     * @param {string} prompt First prompt, used as a provisional title.
     * @returns {void}
     */
    #registerNewConversation(conversationId, prompt) {
      this.#directory.registerNewConversation(conversationId, prompt);
      this.#setOpenConversation(conversationId);
    }

    /**
     * Id of the last persisted message before a position.
     * @param {number} index Position to search backwards from (exclusive).
     * @returns {?string} The id, or null when there is none.
     */
    #lastPersistedMessageIdBefore(index) {
      const message = this.#messages.slice(0, index).findLast(candidate => candidate.isPersisted);
      return message ? message.id : null;
    }

    /**
     * Changes the open conversation.
     * @param {?string} conversationId Conversation id, or null for a new chat.
     * @returns {void}
     */
    #setOpenConversation(conversationId) {
      if (this.#openConversationId === conversationId) return;
      this.#openConversationId = conversationId;
      this.#draftConversationId = null;
      this.publish('openConversation');
    }

    /**
     * Replaces the message list.
     * @param {ChatMessage[]} messages New list.
     * @returns {void}
     */
    #setMessages(messages) {
      this.#messages = messages;
      this.publish('messages');
    }

    /**
     * Changes the sending state.
     * @param {boolean} isSending Whether a prompt is being sent.
     * @returns {void}
     */
    #setSending(isSending) {
      this.#isSending = isSending;
      this.publish('sending');
    }
  }

  /**
   * Owns the chat panes: creates, restores, focuses and closes them, and remembers which
   * conversation each one shows. The focused pane is the one the sidebar, the URL and the export act on.
   * @fires ChatPaneManager#focus The focused pane changed.
   * @fires ChatPaneManager#paneConversations A pane opened another conversation; payload is the pane id.
   * @fires ChatPaneManager#conversationLoaded A pane fetched a conversation; payload is the ApiConversation.
   * @fires ChatPaneManager#rateLimits A pane received usage windows; payload is RateLimits.
   * @fires ChatPaneManager#visiblePanes Whether more than one chat pane is visible changed.
   */
  class ChatPaneManager extends EventEmitter {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Shared model options.
     * @type {ComposerSettings}
     */
    #settings;

    /**
     * Shared conversation list.
     * @type {ConversationDirectory}
     */
    #directory;

    /**
     * Storage for the open panes.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Conversation statistics, for the panes' sub-panes.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Fills a widget's placeholder slot with its real, extracted card.
     * @type {WidgetExtractor}
     */
    #widgetExtractor;

    /**
     * Whether more than one chat pane is visible at the moment.
     * @type {boolean}
     */
    #hasSeveralVisiblePanes = false;

    /**
     * Session and panel of every pane, by pane id, in creation order.
     * @type {Map<string, {session: ChatSession, panel: ChatPanel}>}
     */
    #panes = new Map();

    /**
     * Conversations to reopen in restored panes once the data has loaded, by pane id.
     * @type {Map<string, string>}
     */
    #conversationsToRestore = new Map();

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
     * Creates the manager without any pane.
     * @param {object} services Shared services.
     * @param {ClaudeApi} services.api API client.
     * @param {ComposerSettings} services.settings Shared model options.
     * @param {ConversationDirectory} services.directory Shared conversation list.
     * @param {Preferences} services.preferences Storage for the open panes and table settings.
     * @param {StatsIndex} services.stats Conversation statistics, for the panes' sub-panes.
     * @param {WidgetExtractor} services.widgetExtractor Fills a widget's placeholder slot with its real, extracted card.
     */
    constructor({ api, settings, directory, preferences, stats, widgetExtractor }) {
      super();
      this.#api = api;
      this.#settings = settings;
      this.#directory = directory;
      this.#preferences = preferences;
      this.#stats = stats;
      this.#widgetExtractor = widgetExtractor;
      directory.subscribe('conversationDeleted', conversationId => this.#closeDeletedConversation(conversationId));
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
     * Whether more than one chat pane is visible at the moment.
     * @returns {boolean} True with two or more visible chat panes.
     */
    get hasSeveralVisiblePanes() {
      return this.#hasSeveralVisiblePanes;
    }

    /**
     * Whether an id belongs to a chat pane.
     * @param {string} panelId Panel id.
     * @returns {boolean} True for ids starting with "chat-".
     */
    static isPaneId(panelId) {
      return String(panelId).startsWith('chat-');
    }

    /**
     * Records which panels are visible after a layout and announces when the "several chat panes
     * visible" state changes.
     * @param {Set<string>} visiblePanelIds Ids of the visible panels.
     * @returns {void}
     */
    updateVisiblePanels(visiblePanelIds) {
      const hasSeveral = this.paneIds.filter(paneId => visiblePanelIds.has(paneId)).length > 1;
      if (hasSeveral === this.#hasSeveralVisiblePanes) return;
      this.#hasSeveralVisiblePanes = hasSeveral;
      this.publish('visiblePanes');
    }

    /**
     * Opens a new, empty chat as a tab of a zone and focuses it.
     * @param {string} leafId Zone id.
     * @returns {void}
     */
    openPaneInZone(leafId) {
      const paneId = ChatPaneManager.#createPaneId();
      const pane = this.#createPane(paneId);
      this.#workspace.addPanelToZone(paneId, pane.panel, leafId);
      this.focusPane(paneId);
      this.#savePanes();
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
     * Recreates the panes stored by the last visit, or one empty pane. Focuses the pane that showed
     * the preferred conversation, otherwise the first one. Their conversations are reopened later by
     * openRestoredConversations.
     * @param {?string} preferredConversationId Conversation in the URL, or null.
     * @returns {void}
     */
    restorePanes(preferredConversationId) {
      const storedPanes = ChatPaneManager.#validStoredPanes(this.#preferences.readJson(STORAGE_KEYS.chatPanes));
      const panes = storedPanes.length ? storedPanes : [{ paneId: ChatPaneManager.#createPaneId(), conversationId: null }];
      panes.forEach(pane => this.#restorePane(pane));
      const preferredPane = panes.find(pane => pane.conversationId !== null && pane.conversationId === preferredConversationId);
      this.#focusedPaneId = (preferredPane || panes[0]).paneId;
    }

    /**
     * The panel of every pane, for docking.
     * @returns {Array<[string, ChatPanel]>} [pane id, panel] pairs.
     */
    panelEntries() {
      return [...this.#panes].map(([paneId, pane]) => [paneId, pane.panel]);
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
     * Reopens the stored conversations of every restored pane except the focused one, whose
     * conversation comes from the URL.
     * @returns {void}
     */
    openRestoredConversations() {
      this.#conversationsToRestore.delete(this.#focusedPaneId);
      this.#conversationsToRestore.forEach((conversationId, paneId) => this.#panes.get(paneId).session.openConversation(conversationId));
      this.#conversationsToRestore.clear();
    }

    /**
     * Opens a new pane next to the focused one and focuses it.
     * @param {?string} conversationId Conversation to show, or null for a new chat.
     * @returns {void}
     */
    openPane(conversationId) {
      const paneId = ChatPaneManager.#createPaneId();
      const pane = this.#createPane(paneId);
      this.#workspace.addPanel(paneId, pane.panel, this.#focusedPaneId);
      this.focusPane(paneId);
      if (conversationId) pane.session.openConversation(conversationId);
      this.#savePanes();
    }

    /**
     * Opens a conversation as a new pane docked exactly where a drag was released, instead of always
     * beside the focused pane. Used to compose several chats side by side without switching between
     * them or mixing their context.
     * @param {string} conversationId Conversation to show.
     * @param {DropTarget} dropTarget Where to dock the new pane.
     * @returns {void}
     */
    openPaneAt(conversationId, dropTarget) {
      const paneId = ChatPaneManager.#createPaneId();
      const pane = this.#createPane(paneId);
      this.#workspace.addPanelAt(paneId, pane.panel, dropTarget);
      this.focusPane(paneId);
      pane.session.openConversation(conversationId);
      this.#savePanes();
    }

    /**
     * Starts dragging a conversation out of the sidebar; releasing over a valid drop target opens it
     * as a new pane docked there.
     * @param {MouseEvent} startEvent The mousedown that starts the drag.
     * @param {string} conversationId Conversation to open on drop.
     * @param {string} label Text shown in the floating drag label.
     * @returns {void}
     */
    beginDragToOpenPane(startEvent, conversationId, label) {
      this.#workspace.beginExternalDrag(startEvent, label, dropTarget => this.openPaneAt(conversationId, dropTarget));
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
      return this.focusedSession.openConversation(conversationId);
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
     * Creates a pane from its stored state, remembering its conversation for later.
     * @param {{paneId: string, conversationId: ?string}} storedPane Stored pane.
     * @returns {void}
     */
    #restorePane({ paneId, conversationId }) {
      this.#createPane(paneId);
      if (conversationId) this.#conversationsToRestore.set(paneId, conversationId);
    }

    /**
     * Creates a pane's session and panel and forwards the session's events.
     * @param {string} paneId Pane id.
     * @returns {{session: ChatSession, panel: ChatPanel}} The pane.
     */
    #createPane(paneId) {
      const session = new ChatSession(this.#api, this.#settings, this.#directory);
      const panel = new ChatPanel({
        paneId, session, directory: this.#directory, paneManager: this, stats: this.#stats, preferences: this.#preferences, widgetExtractor: this.#widgetExtractor,
      });
      session.subscribe('openConversation', () => this.#onPaneConversationChanged(paneId));
      session.subscribe('conversationLoaded', conversation => this.publish('conversationLoaded', conversation));
      session.subscribe('rateLimits', limits => this.publish('rateLimits', limits));
      const pane = { session, panel };
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
      for (const pane of this.#panes.values()) {
        if (pane.session.openConversationId === conversationId) pane.session.startNewConversation();
      }
    }

    /**
     * Stores every pane and its conversation.
     * @returns {void}
     */
    #savePanes() {
      this.#preferences.writeJson(STORAGE_KEYS.chatPanes, this.storedPanes());
    }

    /**
     * Creates a unique pane id.
     * @returns {string} An id starting with "chat-".
     */
    static #createPaneId() {
      return `chat-${crypto.randomUUID()}`;
    }

    /**
     * The well-formed entries of a stored pane list.
     * @param {*} storedPanes Parsed stored value.
     * @returns {Array<{paneId: string, conversationId: ?string}>} Valid panes; empty when nothing valid is stored.
     */
    static #validStoredPanes(storedPanes) {
      return Array.isArray(storedPanes) ? storedPanes.filter(ChatPaneManager.#isValidStoredPane) : [];
    }

    /**
     * Whether a stored pane entry is well formed.
     * @param {*} storedPane Stored entry.
     * @returns {boolean} True for an object with a "chat-" pane id and a string or null conversation id.
     */
    static #isValidStoredPane(storedPane) {
      return Boolean(storedPane) && String(storedPane.paneId).startsWith('chat-') && (storedPane.conversationId === null || typeof storedPane.conversationId === 'string');
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
     * @param {AbortSignal} request.signal Aborts the request and the stream.
     * @yields {StreamEvent} The start event, then each server-sent event.
     * @returns {AsyncGenerator<StreamEvent, void, void>} The events in order.
     * @throws {ApiError} When the server rejects the request.
     * @throws {DOMException} An AbortError when aborted.
     */
    async *streamCompletion({ conversationId, prompt, parentMessageId, isNew, settings, fileUuids, signal }) {
      const body = ClaudeApi.#buildCompletionBody({ prompt, parentMessageId, isNew, settings, fileUuids });
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
     * @returns {object} The body, with conversation-creation parameters or a parent message id.
     */
    static #buildCompletionBody({ prompt, parentMessageId, isNew, settings, fileUuids }) {
      const body = {
        prompt,
        timezone: currentTimezone(),
        locale: resolveLocale(),
        model: settings.model,
        effort: settings.effort,
        thinking_mode: settings.thinkingMode,
        tools: [],
        turn_message_uuids: { human_message_uuid: crypto.randomUUID(), assistant_message_uuid: crypto.randomUUID() },
        attachments: [],
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
     * Shows the current shared options in the controls.
     * @returns {void}
     */
    showSettings() {
      this.#modelSelect.value = this.#settings.model;
      this.#effortSelect.value = this.#settings.effort;
      this.#thinkingCheckbox.checked = this.#settings.thinkingMode === THINKING_MODES.extended;
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
    { id: 'extra', label: 'Extra effort' },
    { id: 'max', label: 'Max effort' },
  ]);

  var stylesheet$c = ".claude-plus-dialog-overlay {\r\n  position: fixed;\r\n  inset: 0;\r\n  z-index: var(--claude-plus-layer-drag-label);\r\n  background: rgba(0, 0, 0, 0.5);\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n}\r\n\r\n.claude-plus-dialog {\r\n  background: var(--claude-plus-color-raised);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 8px;\r\n  padding: 16px;\r\n  max-width: 360px;\r\n  font-size: 13px;\r\n}\r\n\r\n.claude-plus-dialog__message {\r\n  margin: 0 0 14px;\r\n  line-height: 1.4;\r\n}\r\n\r\n.claude-plus-dialog__input {\r\n  width: 100%;\r\n  box-sizing: border-box;\r\n  margin: 0 0 14px;\r\n  padding: 6px 8px;\r\n  background: var(--claude-plus-color-bar);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  color: var(--claude-plus-color-text);\r\n  font: inherit;\r\n}\r\n\r\n.claude-plus-dialog__actions {\r\n  display: flex;\r\n  justify-content: flex-end;\r\n  gap: 8px;\r\n}\r\n";

  StyleRegistry.register(stylesheet$c);

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

  var stylesheet$b = ".claude-plus-popup-menu {\r\n  position: fixed;\r\n  z-index: var(--claude-plus-layer-popup-menu);\r\n  background: var(--claude-plus-color-raised);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  padding: 4px;\r\n  min-width: 140px;\r\n  font-size: 12px;\r\n}\r\n\r\n.claude-plus-popup-menu__entry {\r\n  padding: 6px 10px;\r\n  cursor: pointer;\r\n  border-radius: 4px;\r\n}\r\n\r\n.claude-plus-popup-menu__entry:hover {\r\n  background: var(--claude-plus-color-raised-hover);\r\n}\r\n";

  StyleRegistry.register(stylesheet$b);

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

  var stylesheet$a = ".claude-plus-staged-files {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  gap: 6px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-staged-file {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  gap: 4px;\r\n  background: var(--claude-plus-color-bar);\r\n  border: 1px solid var(--claude-plus-color-border-strong);\r\n  border-radius: 6px;\r\n  padding: 3px 4px 3px 3px;\r\n  font-size: 12px;\r\n  max-width: 200px;\r\n}\r\n\r\n.claude-plus-staged-file--uploading {\r\n  opacity: 0.6;\r\n}\r\n\r\n.claude-plus-staged-file__thumb {\r\n  width: 20px;\r\n  height: 20px;\r\n  border-radius: 4px;\r\n  object-fit: cover;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-staged-file__icon {\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-staged-file__name {\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.claude-plus-staged-file__remove {\r\n  background: none;\r\n  border: none;\r\n  color: var(--claude-plus-color-text-faint);\r\n  cursor: pointer;\r\n  padding: 0 2px;\r\n  border-radius: 4px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-staged-file__remove:hover {\r\n  background: var(--claude-plus-color-hover);\r\n  color: var(--claude-plus-color-text);\r\n}\r\n";

  StyleRegistry.register(stylesheet$a);

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

  /**
   * HTML for the options of a select element.
   * @param {ReadonlyArray<ChoiceOption>} options The options.
   * @param {string} selectedId Value of the option to preselect.
   * @returns {string} The option elements.
   */
  function optionsHtml(options, selectedId) {
    return options.map(option => `<option value="${escapeHtml(option.id)}"${option.id === selectedId ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
  }

  var stylesheet$9 = ".claude-plus-composer__options {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  gap: 8px;\r\n  align-items: center;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-composer__options select {\r\n  padding: 4px 6px;\r\n}\r\n\r\n.claude-plus-composer__thinking-toggle {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 4px;\r\n  font-size: 12px;\r\n  color: var(--claude-plus-color-text-muted);\r\n  cursor: pointer;\r\n}\r\n\r\n.claude-plus-panel .claude-plus-composer__input {\r\n  flex: 1;\r\n  resize: none;\r\n  min-height: 40px;\r\n  border-radius: 8px;\r\n  padding: 8px;\r\n  font-size: 14px;\r\n}\r\n\r\n.claude-plus-primary-button.claude-plus-composer__stop-button {\r\n  flex-shrink: 0;\r\n  background: var(--claude-plus-color-button-hover);\r\n}\r\n";

  StyleRegistry.register(stylesheet$9);

  /**
   * The single message composer. It always targets the active chat (the focused chat pane) and can
   * be docked anywhere. Enter sends and Shift+Enter inserts a line break; there is no send button,
   * only a Stop button while a reply streams. Files pasted or dropped in are uploaded and attached
   * to the next prompt. Its toolbar holds the model options, buttons opening the active chat's files
   * and sources sub-panes, and the chat export.
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
     */
    constructor({ paneManager, settings, stats, exporter }) {
      super('Message');
      this.#paneManager = paneManager;
      this.#settings = settings;
      this.#stats = stats;
      this.#exporter = exporter;
    }

    /**
     * HTML of the panel body.
     * @returns {string} Toolbar, prompt input and Stop button.
     */
    createBodyHtml() {
      return `
      <div class="claude-plus-composer__options">
        <select data-name="modelSelect">${optionsHtml(MODELS, '')}</select>
        <select data-name="effortSelect">${optionsHtml(EFFORTS, '')}</select>
        <label class="claude-plus-composer__thinking-toggle"><input type="checkbox" data-name="thinkingCheckbox" /> Extended thinking</label>
        <div class="claude-plus-fill-remaining"></div>
        <button class="claude-plus-toolbar__button" data-name="filesButton" title="Files in the active chat">📁</button>
        <button class="claude-plus-toolbar__button" data-name="sourcesButton" title="Web sources of the active chat">🌐</button>
        <button class="claude-plus-toolbar__button" data-name="exportButton" title="Export the active chat">Export ▾</button>
      </div>
      <div class="claude-plus-staged-files" data-name="stagedFiles" hidden></div>
      <textarea class="claude-plus-composer__input" data-name="promptInput" placeholder="Message Claude… (Enter sends, Shift+Enter adds a line — paste or drop files to attach them)" rows="3"></textarea>
      <button class="claude-plus-primary-button claude-plus-composer__stop-button" data-name="stopButton" hidden>Stop</button>`;
    }

    /**
     * Creates the controls' views, wires the prompt input and follows the settings and the active chat.
     * @returns {void}
     */
    bindEvents() {
      const { promptInput, stopButton, filesButton, sourcesButton, exportButton, stagedFiles } = this.elements;
      this.#optionsView = new ComposerOptionsView(this.elements, this.#settings);
      this.#exportButton = new ExportMenuButton(exportButton, this.#exporter);
      this.#stagedFiles = new StagedFileList(stagedFiles, file => this.#paneManager.focusedSession.uploadFile(file));
      promptInput.addEventListener('keydown', event => this.#onPromptKeydown(event));
      promptInput.addEventListener('paste', event => this.#onPaste(event));
      this.element.addEventListener('dragover', event => event.preventDefault());
      this.element.addEventListener('drop', event => this.#onDrop(event));
      stopButton.addEventListener('click', () => this.#paneManager.focusedSession.stopReply());
      filesButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('files'));
      sourcesButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('sources'));
      this.listenTo(this.#settings, 'settings', () => this.#optionsView.showSettings());
      this.listenTo(this.#paneManager, 'focus', () => this.#followActiveChat());
      this.listenTo(this.#paneManager, 'paneConversations', () => this.render());
      this.listenTo(this.#stats, 'aggregate', () => this.render());
      this.#followActiveChat();
    }

    /**
     * Shows Stop only while the active chat streams a reply, enables export only for a saved
     * conversation, and shows the files/sources buttons only when the active chat has any.
     * @returns {void}
     */
    render() {
      const session = this.#paneManager.focusedSession;
      this.elements.stopButton.hidden = !session.isSending;
      this.#exportButton.setEnabled(Boolean(session.openConversationId));
      this.elements.filesButton.hidden = !this.#activeChatHas('folders');
      this.elements.sourcesButton.hidden = !this.#activeChatHas('sources');
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
     * Subscribes to the newly active chat's sending state and drops the files staged for the previous one.
     * @returns {void}
     */
    #followActiveChat() {
      this.#unsubscribeFromSession();
      this.#sessionUnsubscribers = [this.#paneManager.focusedSession.subscribe('sending', () => this.render())];
      this.#stagedFiles.clear();
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
     * Sends the typed prompt and the staged files to the active chat, then clears both; ignored for
     * blank input, while the active chat is sending, or while a file is still uploading.
     * @returns {void}
     */
    #sendTypedPrompt() {
      const { promptInput } = this.elements;
      const session = this.#paneManager.focusedSession;
      if (!promptInput.value.trim() || session.isSending || this.#stagedFiles.isUploading) return;
      const prompt = promptInput.value;
      promptInput.value = '';
      session.sendPrompt(prompt, this.#stagedFiles.takeUploads());
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
     * Creates the settings on top of a preference store.
     * @param {Preferences} preferences Backing storage.
     */
    constructor(preferences) {
      super();
      this.#preferences = preferences;
    }

    /**
     * Selected model id.
     * @returns {string} An id from MODELS.
     */
    get model() {
      return this.#readAllowed(STORAGE_KEYS.model, MODELS.map(option => option.id));
    }

    /**
     * Selects a model; ids not in MODELS are ignored.
     * @param {string} modelId Model id.
     */
    set model(modelId) {
      this.#writeIfAllowed(STORAGE_KEYS.model, modelId, MODELS.map(option => option.id));
    }

    /**
     * Selected effort level.
     * @returns {string} An id from EFFORTS.
     */
    get effort() {
      return this.#readAllowed(STORAGE_KEYS.effort, EFFORTS.map(option => option.id));
    }

    /**
     * Selects an effort level; ids not in EFFORTS are ignored.
     * @param {string} effortId Effort id.
     */
    set effort(effortId) {
      this.#writeIfAllowed(STORAGE_KEYS.effort, effortId, EFFORTS.map(option => option.id));
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

  var stylesheet$8 = "html.claude-plus-resizing-horizontally,\r\nhtml.claude-plus-resizing-horizontally * {\r\n  cursor: col-resize !important;\r\n  user-select: none;\r\n}\r\n\r\nhtml.claude-plus-resizing-vertically,\r\nhtml.claude-plus-resizing-vertically * {\r\n  cursor: row-resize !important;\r\n  user-select: none;\r\n}\r\n\r\n.claude-plus-divider-layer {\r\n  position: fixed;\r\n  inset: 0;\r\n  pointer-events: none;\r\n  z-index: var(--claude-plus-layer-divider);\r\n}\r\n\r\n.claude-plus-divider {\r\n  position: fixed;\r\n  pointer-events: auto;\r\n  background: transparent;\r\n}\r\n\r\n.claude-plus-divider--vertical {\r\n  cursor: col-resize;\r\n}\r\n\r\n.claude-plus-divider--horizontal {\r\n  cursor: row-resize;\r\n}\r\n\r\n.claude-plus-divider:hover {\r\n  background: var(--claude-plus-color-accent);\r\n}\r\n";

  StyleRegistry.register(stylesheet$8);

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

  var stylesheet$7 = ".claude-plus-drop-highlight[hidden] {\r\n  display: none !important;\r\n}\r\n\r\n.claude-plus-drag-label {\r\n  position: fixed;\r\n  z-index: var(--claude-plus-layer-drag-label);\r\n  background: var(--claude-plus-color-accent);\r\n  color: #fff;\r\n  padding: 4px 10px;\r\n  border-radius: 6px;\r\n  font-size: 12px;\r\n  pointer-events: none;\r\n}\r\n\r\n.claude-plus-drop-highlight {\r\n  position: fixed;\r\n  z-index: var(--claude-plus-layer-drop-highlight);\r\n  background: var(--claude-plus-color-accent-overlay);\r\n  border: 2px solid var(--claude-plus-color-accent);\r\n  pointer-events: none;\r\n  box-sizing: border-box;\r\n}\r\n";

  StyleRegistry.register(stylesheet$7);

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

  var stylesheet$6 = ".claude-plus-zone-chrome-layer {\r\n  position: fixed;\r\n  inset: 0;\r\n  pointer-events: none;\r\n  z-index: var(--claude-plus-layer-zone-chrome);\r\n}\r\n\r\n.claude-plus-zone-frame {\r\n  position: fixed;\r\n  background: var(--claude-plus-color-background);\r\n  border: 1px solid var(--claude-plus-color-border);\r\n  box-sizing: border-box;\r\n}\r\n\r\n.claude-plus-tab-strip {\r\n  position: fixed;\r\n  display: flex;\r\n  align-items: center;\r\n  background: var(--claude-plus-color-bar);\r\n  border-bottom: 1px solid var(--claude-plus-color-border);\r\n  overflow-x: auto;\r\n  box-sizing: border-box;\r\n  pointer-events: auto;\r\n}\r\n\r\n.claude-plus-tab {\r\n  padding: 5px 12px;\r\n  font-size: 12px;\r\n  color: var(--claude-plus-color-text-muted);\r\n  cursor: pointer;\r\n  white-space: nowrap;\r\n  border-right: 1px solid var(--claude-plus-color-border-faint);\r\n  user-select: none;\r\n}\r\n\r\n.claude-plus-tab--active {\r\n  color: var(--claude-plus-color-text);\r\n  border-bottom: 2px solid var(--claude-plus-color-accent);\r\n}\r\n\r\n.claude-plus-tab {\r\n  display: flex;\r\n  align-items: center;\r\n  min-width: 0;\r\n  max-width: 220px;\r\n}\r\n\r\n.claude-plus-tab__label {\r\n  overflow: hidden;\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.claude-plus-tab__close-button {\r\n  flex-shrink: 0;\r\n  margin-left: 8px;\r\n  padding: 0 3px;\r\n  border-radius: 3px;\r\n  color: var(--claude-plus-color-text-faint);\r\n}\r\n\r\n.claude-plus-tab__close-button:hover {\r\n  background: var(--claude-plus-color-hover);\r\n  color: var(--claude-plus-color-text);\r\n}\r\n\r\n.claude-plus-tab-strip__add-button {\r\n  padding: 5px 10px;\r\n  cursor: pointer;\r\n  color: var(--claude-plus-color-text-faint);\r\n  user-select: none;\r\n}\r\n\r\n.claude-plus-tab-strip__add-button:hover {\r\n  color: var(--claude-plus-color-text);\r\n}\r\n\r\n.claude-plus-table-host {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 4px;\r\n  flex: 1;\r\n  min-height: 0;\r\n}\r\n";

  StyleRegistry.register(stylesheet$6);

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
      const frame = createElement('div', { className: 'claude-plus-zone-frame' });
      const tabStrip = createElement('div', { className: 'claude-plus-tab-strip' });
      placeElement(frame, rect);
      placeElement(tabStrip, { ...rect, height: LAYOUT.tabStripHeight });
      tabStrip.append(...leaf.tabs.map(panelId => this.#createTab(leaf, panelId)), this.#createAddPanelButton(leaf.id));
      this.#layer.append(frame, tabStrip);
    }

    /**
     * Creates a tab that reports presses and clicks.
     * @param {LeafNode} leaf Zone of the tab.
     * @param {string} panelId Panel id.
     * @returns {HTMLElement} The tab.
     */
    #createTab(leaf, panelId) {
      const title = this.#callbacks.titleOf(panelId);
      const className = panelId === leaf.activeTab ? 'claude-plus-tab claude-plus-tab--active' : 'claude-plus-tab';
      const tab = createElement('div', { className, title });
      tab.append(createElement('span', { className: 'claude-plus-tab__label', textContent: title }));
      tab.addEventListener('mousedown', event => this.#callbacks.onTabPress(event, panelId));
      tab.addEventListener('click', () => this.#callbacks.onTabActivate(leaf.id, panelId));
      if (this.#callbacks.canClose(panelId)) tab.append(this.#createCloseButton(panelId));
      return tab;
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
     * @returns {HTMLElement} The button.
     */
    #createAddPanelButton(leafId) {
      const button = createElement('div', { className: 'claude-plus-tab-strip__add-button', textContent: '+', title: 'Add a chat or panel to this zone' });
      button.addEventListener('click', event => this.#callbacks.onAddClick(event, leafId));
      return button;
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
     * @param {Preferences} options.preferences Layout storage.
     * @param {function(): DockTree} options.createDefaultTree Creates the default layout.
     * @param {function(): string[]} options.requiredPanelIds Ids of the panels that must always be docked.
     * @param {function(DockTree, string): void} options.placeMissingPanel Docks a required panel the layout lacks.
     * @param {{entries: function(): ChoiceOption[], onSelect: function(string, string): void}} options.addPanelMenu Entries of the zones' "+" menu, and a callback receiving the chosen entry id and the zone id.
     * @param {function(Set<string>): void} options.onLayout Called after every layout with the ids of the visible panels.
     */
    constructor({ panels, preferences, createDefaultTree, requiredPanelIds, placeMissingPanel, addPanelMenu, onLayout }) {
      this.#panels = new PanelHost(panels);
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

  var stylesheet$5 = ".claude-plus-conversation:hover .claude-plus-conversation__action-button {\r\n  visibility: visible;\r\n}\r\n\r\n.claude-plus-conversation {\r\n  cursor: pointer;\r\n}\r\n\r\n.claude-plus-conversation:hover > td {\r\n  background: var(--claude-plus-color-hover);\r\n}\r\n\r\n.claude-plus-conversation--active > td {\r\n  background: var(--claude-plus-color-accent-soft);\r\n}\r\n\r\n.claude-plus-conversation--open-elsewhere > td:first-child {\r\n  box-shadow: inset 2px 0 0 var(--claude-plus-color-accent);\r\n}\r\n\r\n.claude-plus-conversation__actions {\r\n  display: inline-flex;\r\n  white-space: nowrap;\r\n}\r\n\r\n.claude-plus-conversation__action-button {\r\n  visibility: hidden;\r\n  background: none;\r\n  border: none;\r\n  cursor: pointer;\r\n  font-size: 12px;\r\n  padding: 4px;\r\n  border-radius: 4px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-conversation__action-button:hover {\r\n  background: rgba(255, 255, 255, 0.1);\r\n}\r\n";

  StyleRegistry.register(stylesheet$5);

  /**
   * Conversation list as a column table, with a quick title search, open in a new pane, delete, and
   * dragging an entry out to open it as a new pane docked where it is dropped. Clicking a
   * conversation opens it in the focused chat pane.
   */
  class ConversationListPanel extends Panel {
    /**
     * Shared conversation list.
     * @type {ConversationDirectory}
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
     * @param {ConversationDirectory} services.directory Shared conversation list.
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
        { id: 'name', label: 'Name', isAlwaysVisible: true, filter: 'values', sortValue: conversation => (conversation.name || '').toLowerCase(), filterValue: conversation => conversation.name || UNTITLED, cellHtml: conversation => `<span class="claude-plus-conversation__title">${escapeHtml(conversation.name || UNTITLED)}</span>` },
        { id: 'date', label: 'Date', isVisibleByDefault: true, filter: 'date', sortValue: conversation => toEpochMs(conversation.updated_at), filterValue: conversation => conversation.updated_at, cellHtml: conversation => escapeHtml(formatDay(conversation.updated_at)) },
        { id: 'turns', label: 'Turns', sortValue: conversation => this.#indexedCount(conversation, 'promptCount'), cellHtml: conversation => this.#indexedCountHtml(conversation, 'promptCount') },
        { id: 'files', label: 'Files', sortValue: conversation => this.#indexedCount(conversation, 'fileCount'), cellHtml: conversation => this.#indexedCountHtml(conversation, 'fileCount') },
        { id: 'actions', label: '', isAlwaysVisible: true, isNotSortable: true, sortValue: () => 0, cellHtml: () => ConversationListPanel.#actionButtonsHtml() },
      ];
    }

    /**
     * A per-conversation count from the stats index.
     * @param {ConversationListing} conversation The conversation.
     * @param {string} field 'promptCount' or 'fileCount'.
     * @returns {number} The count, or -1 while the conversation isn't indexed, so unindexed ones sort together.
     */
    #indexedCount(conversation, field) {
      const counts = this.#stats.aggregate.perConversation.get(conversation.uuid);
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
      const modifier = ConversationListPanel.#stateModifier(conversation.uuid, this.#paneManager.focusedSession.openConversationId, this.#paneManager.openConversationIds());
      return `class="claude-plus-conversation${modifier}" data-conversation-id="${escapeHtml(conversation.uuid)}"`;
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
      return (conversation.name || '').toLowerCase().includes(this.#searchText);
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
   * Global keyboard shortcuts. Cmd+K (Ctrl+K elsewhere) reveals a conversation list and focuses
   * its search. Shortcuts are handled in the capture phase and stopped there, so claude.ai's own
   * hidden app never reacts to them.
   */
  class KeyboardShortcuts {
    /**
     * Workspace used to reveal panels.
     * @type {DockWorkspace}
     */
    #workspace;

    /**
     * Creates the shortcuts.
     * @param {DockWorkspace} workspace Workspace used to find and reveal panels.
     */
    constructor(workspace) {
      this.#workspace = workspace;
    }

    /**
     * Starts listening for the shortcuts.
     * @returns {void}
     */
    install() {
      window.addEventListener('keydown', this.#handleKeydown, true);
    }

    /**
     * Runs the shortcut matching a key press.
     * @param {KeyboardEvent} event The key press.
     * @returns {void}
     */
    #handleKeydown = (event) => {
      if (!KeyboardShortcuts.#isSearchShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      this.#focusConversationSearch();
    };

    /**
     * Whether a key press is the search shortcut.
     * @param {KeyboardEvent} event The key press.
     * @returns {boolean} True for Cmd+K or Ctrl+K without Shift or Alt.
     */
    static #isSearchShortcut(event) {
      return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k';
    }

    /**
     * Shows the first docked conversation list and focuses its search box; does nothing when none is docked.
     * @returns {void}
     */
    #focusConversationSearch() {
      const docked = this.#workspace.findDockedPanel(panel => panel instanceof ConversationListPanel);
      if (docked && this.#workspace.revealPanel(docked.panelId)) docked.panel.focusSearch();
    }
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

  var stylesheet$4 = ".claude-plus-folder {\r\n  cursor: pointer;\r\n}\r\n\r\n.claude-plus-folder:hover > td {\r\n  background: var(--claude-plus-color-hover);\r\n}\r\n\r\n.claude-plus-breadcrumb {\r\n  font-size: 12px;\r\n  color: var(--claude-plus-color-text-muted);\r\n  margin-bottom: 6px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-breadcrumb__back-link {\r\n  color: var(--claude-plus-color-accent);\r\n  cursor: pointer;\r\n}\r\n";

  StyleRegistry.register(stylesheet$4);

  /**
   * Uploaded and produced files: a table of conversations with files, and per conversation a table
   * of its files; both with configurable columns, sorting and filters.
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
     */
    constructor({ stats, preferences }) {
      super('Files');
      this.#stats = stats;
      this.#preferences = preferences;
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
        rowAttributes: () => '',
        emptyText: 'No files here.',
      });
      this.#folderTable.bodyElement.addEventListener('click', event => this.#onFolderClick(event));
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

  var stylesheet$3 = ".claude-plus-search-result {\r\n  cursor: pointer;\r\n}\r\n\r\n.claude-plus-search-result:hover > td {\r\n  background: var(--claude-plus-color-hover);\r\n}\r\n";

  StyleRegistry.register(stylesheet$3);

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
     * @type {ConversationDirectory}
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
     * @param {ConversationDirectory} services.directory Shared conversation list.
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
        rowAttributes: item => `class="claude-plus-search-result" data-conversation-id="${escapeHtml(item.conversationId)}"`,
        emptyText: 'No results.',
        maxRenderedRows: LIMITS.searchResults,
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
        { id: 'conversation', label: 'Chat', isVisibleByDefault: true, filter: 'values', sortValue: item => item.conversationTitle.toLowerCase(), filterValue: item => item.conversationTitle, cellHtml: item => escapeHtml(item.conversationTitle) },
        { id: 'date', label: 'Date', isVisibleByDefault: true, filter: 'date', sortValue: item => toEpochMs(item.timestamp), filterValue: item => item.timestamp, cellHtml: item => escapeHtml(formatTimestamp(item.timestamp)) },
        { id: 'reason', label: 'Why', isVisibleByDefault: true, sortValue: item => item.reason, cellHtml: item => escapeHtml(item.reason) },
      ];
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
     * Opens the clicked result's conversation in the active chat.
     * @param {MouseEvent} event Click in the results body.
     * @returns {void}
     */
    #onResultClick(event) {
      const row = event.target.closest('[data-conversation-id]');
      if (row) this.#router.openConversation(row.dataset.conversationId);
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

  /**
   * Formats a usage window's utilization as a percentage rounded to two decimals.
   * @param {?UsageWindow} usageWindow The window, or null when unknown.
   * @returns {string} The percentage, or "–" when unknown.
   */
  function formatUtilization(usageWindow) {
    if (!usageWindow) return '–';
    return `${Math.round((usageWindow.utilization || 0) * 100) / 100}%`;
  }

  var stylesheet$2 = ".claude-plus-value-row {\r\n  display: flex;\r\n  justify-content: space-between;\r\n  padding: 2px 0;\r\n  gap: 8px;\r\n}\r\n\r\n.claude-plus-value-row span {\r\n  color: var(--claude-plus-color-text-muted);\r\n}\r\n";

  StyleRegistry.register(stylesheet$2);

  /**
   * HTML for a label/value row.
   * @param {string} label Row label.
   * @param {string|number} value Row value.
   * @returns {string} The row.
   */
  function valueRowHtml(label, value) {
    return `<div class="claude-plus-value-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
  }

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
      <div class="claude-plus-panel__section">${row('Turns (all chats)', 'promptCount')}${row('Avg response time', 'averageResponseTime')}</div>
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
     * Shows the totals and the tool call ranking.
     * @returns {void}
     */
    #renderAggregate() {
      const aggregate = this.#stats.aggregate;
      const toolRanking = entriesByDescendingCount(aggregate.toolCallCounts);
      const responseTimes = aggregate.responseTimesMs;
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
   * outlet ranking.
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
     * The sources table; created with the DOM.
     * @type {?ColumnTable}
     */
    #table = null;

    /**
     * Creates the panel.
     * @param {object} services Panel dependencies.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {Preferences} services.preferences Table settings storage.
     */
    constructor({ stats, preferences }) {
      super('Web Sources');
      this.#stats = stats;
      this.#preferences = preferences;
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
        rowAttributes: () => '',
        emptyText: 'No web sources match these filters.',
        maxRenderedRows: LIMITS.listedSources,
      });
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
     * @param {ConversationDirectory} services.directory Shared conversation list.
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
     */
    constructor(conversation) {
      this.#summary = {
        conversationId: conversation.uuid,
        title: conversation.name || UNTITLED,
        updatedAt: conversation.updated_at,
        promptCount: 0,
        toolCallCounts: Object.create(null),
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
     * @returns {ConversationSummary} The summary.
     */
    static summarize(conversation) {
      const summarizer = new ConversationSummarizer(conversation);
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
     * Counts a prompt, its estimated tokens and its uploads.
     * @param {ApiMessage} message A human message.
     * @returns {void}
     */
    #addPrompt(message) {
      this.#summary.promptCount += 1;
      this.#summary.estimatedTokensIn += estimateTokens(MessageContent.plainText(message));
      this.#unansweredPromptTime = message.created_at;
      for (const upload of MessageContent.uploads(message)) {
        const name = MessageContent.uploadName(upload);
        this.#summary.files.push({ path: name, title: name, timestamp: upload.created_at || message.created_at, source: 'user' });
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
      for (const block of message.content ?? []) this.#addContentBlock(block, block.stop_timestamp || message.created_at, producedFilesByPath);
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
     * @param {Map<string, FileEntry>} producedFilesByPath Files produced by the reply, keyed by path; the last write wins.
     * @returns {void}
     */
    #addContentBlock(block, blockTime, producedFilesByPath) {
      if (block.type === 'tool_use') this.#addToolCall(block, blockTime, producedFilesByPath);
      else if (block.type === 'tool_result') this.#addToolResult(block, blockTime);
    }

    /**
     * Counts a tool call and records the file it produced, if any.
     * @param {ContentBlock} block A tool_use block.
     * @param {string} blockTime Timestamp of the block.
     * @param {Map<string, FileEntry>} producedFilesByPath Files produced by the reply, keyed by path.
     * @returns {void}
     */
    #addToolCall(block, blockTime, producedFilesByPath) {
      const toolName = block.name || 'unknown_tool';
      addToCount(this.#summary.toolCallCounts, toolName, 1);
      const describeFile = ConversationSummarizer.#FILE_PRODUCING_TOOLS.get(toolName);
      if (!describeFile || !block.input) return;
      const { path, title } = describeFile(block.input);
      producedFilesByPath.set(path, { path, title: title || lastPathSegment(path), timestamp: blockTime, source: 'claude' });
    }

    /**
     * Records the web sources a tool result cites.
     * @param {ContentBlock} block A tool_result block.
     * @param {string} blockTime Timestamp of the block.
     * @returns {void}
     */
    #addToolResult(block, blockTime) {
      const items = Array.isArray(block.content) ? block.content : [];
      for (const item of items.filter(ConversationSummarizer.#isWebSource)) {
        this.#summary.sources.push({ title: item.title, url: item.url, ...hostParts(item.url), timestamp: blockTime });
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
       * @type {Map<string, {title: string, updatedAt: string, promptCount: number, fileCount: number, toolNames: string[]}>}
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
      const origin = { conversationTitle: summary.title, conversationId: summary.conversationId };
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
        promptCount: summary.promptCount,
        fileCount: summary.files.length,
        toolNames: Object.keys(summary.toolCallCounts),
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
   * Waits for a given time.
   * @param {number} durationMs Milliseconds to wait.
   * @returns {Promise<void>} Resolves after the delay.
   */
  function wait(durationMs) {
    return new Promise(resolve => setTimeout(resolve, durationMs));
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
     * Current totals.
     * @type {StatsAggregate}
     */
    #aggregate = new StatsAggregate();

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
     * Current totals.
     * @returns {StatsAggregate} The aggregate.
     */
    get aggregate() {
      return this.#aggregate;
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
        const summaries = records.filter(record => SummaryValidator.isValid(record));
        this.#aggregate = StatsAggregate.fromSummaries(summaries);
        this.#aggregate.skippedRecordCount = records.length - summaries.length;
        this.publish('aggregate');
      } catch (error) {
        console.warn(LOG_PREFIX, 'reading stats failed', error);
      }
    }

    /**
     * Stores a conversation's summary if it changed, then recomputes the aggregate. Failures are logged.
     * @param {ApiConversation} conversation The conversation.
     * @returns {Promise<void>} Resolves once done.
     */
    async indexConversation(conversation) {
      try {
        if (await this.#storeSummaryIfOutdated(conversation)) await this.refreshAggregate();
      } catch (error) {
        console.warn(LOG_PREFIX, 'indexing conversation failed', error);
      }
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
      if (!(await this.#isOutdated(listing.uuid, listing.updated_at))) return;
      await this.#storeSummaryIfOutdated(await this.#api.getConversation(listing.uuid));
      this.#storedDuringBackfill += 1;
      if (this.#storedDuringBackfill % LIMITS.backfillRefreshInterval === 0) await this.refreshAggregate();
      await wait(TIMING.backfillPauseMs);
    }

    /**
     * Whether the cache lacks a conversation, holds another version of it, or holds a record that
     * doesn't look valid.
     * @param {string} conversationId Conversation id.
     * @param {string} updatedAt Current version timestamp of the conversation.
     * @returns {Promise<boolean>} True when it must be (re)indexed.
     * @throws {DOMException} When the cache can't be read.
     */
    async #isOutdated(conversationId, updatedAt) {
      const summary = await this.#database.read(DATABASE.stores.conversationSummaries, conversationId);
      return !SummaryValidator.isValid(summary) || summary.updatedAt !== updatedAt;
    }

    /**
     * Stores a conversation's summary if the cached one is outdated.
     * @param {ApiConversation} conversation The conversation.
     * @returns {Promise<boolean>} True if a summary was written.
     * @throws {DOMException} When the cache can't be read or written.
     */
    async #storeSummaryIfOutdated(conversation) {
      if (!(await this.#isOutdated(conversation.uuid, conversation.updated_at))) return false;
      await this.#database.write(DATABASE.stores.conversationSummaries, ConversationSummarizer.summarize(conversation));
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

  var stylesheet$1 = ".claude-plus-toolbar {\r\n  position: fixed;\r\n  top: 0;\r\n  left: 0;\r\n  right: 0;\r\n  height: var(--claude-plus-toolbar-height);\r\n  z-index: var(--claude-plus-layer-toolbar);\r\n  background: var(--claude-plus-color-bar);\r\n  border-bottom: 1px solid var(--claude-plus-color-border-strong);\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 14px;\r\n  padding: 0 10px;\r\n  font-size: 12px;\r\n  box-sizing: border-box;\r\n}\r\n\r\n.claude-plus-toolbar__title {\r\n  font-weight: 600;\r\n}\r\n\r\n.claude-plus-toolbar__button {\r\n  background: var(--claude-plus-color-button);\r\n  border: none;\r\n  color: var(--claude-plus-color-text);\r\n  padding: 5px 10px;\r\n  border-radius: 6px;\r\n  cursor: pointer;\r\n  font-size: 12px;\r\n}\r\n\r\n.claude-plus-toolbar__button:hover {\r\n  background: var(--claude-plus-color-button-hover);\r\n}\r\n\r\n.claude-plus-toolbar__button:disabled {\r\n  opacity: 0.5;\r\n  cursor: default;\r\n}\r\n\r\n.claude-plus-toolbar__font-size {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 6px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.claude-plus-toolbar__font-size input[type=range] {\r\n  width: 100px;\r\n}\r\n";

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
     */
    constructor({ preferences, workspace, layoutLibrary, settingsTransfer }) {
      this.#preferences = preferences;
      this.#workspace = workspace;
      this.#layoutLibrary = layoutLibrary;
      this.#settingsTransfer = settingsTransfer;
      const storedSize = Number.parseFloat(preferences.read(STORAGE_KEYS.messageFontSize));
      const { minimum, maximum, fallback } = Toolbar.#FONT_SIZE;
      this.#messageFontSize = Number.isFinite(storedSize) ? clamp(storedSize, minimum, maximum) : fallback;
    }

    /**
     * Adds the toolbar to the page and applies the font size.
     * @returns {void}
     */
    mount() {
      const { minimum, maximum } = Toolbar.#FONT_SIZE;
      const toolbar = createElement('div', {
        className: 'claude-plus-themed claude-plus-toolbar',
        innerHTML: `
        <div class="claude-plus-toolbar__title">ClaudePlus</div>
        <label class="claude-plus-toolbar__font-size">
          <span>Aa</span>
          <input type="range" data-name="fontSizeSlider" min="${minimum}" max="${maximum}" step="1" value="${this.#messageFontSize}">
          <span data-name="fontSizeLabel"></span>
        </label>
        <div class="claude-plus-fill-remaining"></div>
        <button class="claude-plus-toolbar__button" data-name="layoutsButton">Layouts ▾</button>
        <button class="claude-plus-toolbar__button" data-name="settingsButton">Settings ▾</button>
        <button class="claude-plus-toolbar__button" data-name="resetLayoutButton">Reset layout</button>`,
      });
      const elements = collectNamedElements(toolbar);
      elements.fontSizeSlider.addEventListener('input', () => this.#changeFontSize(Number.parseFloat(elements.fontSizeSlider.value), elements.fontSizeLabel));
      elements.layoutsButton.addEventListener('click', () => this.#showLayoutsMenu(elements.layoutsButton));
      elements.settingsButton.addEventListener('click', () => this.#showSettingsMenu(elements.settingsButton));
      elements.resetLayoutButton.addEventListener('click', () => this.#workspace.resetLayout());
      this.#applyFontSize(elements.fontSizeLabel);
      document.body.append(toolbar);
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
     * Opens the settings menu: export and import.
     * @param {HTMLElement} button The settings button.
     * @returns {void}
     */
    #showSettingsMenu(button) {
      const actions = {
        export: () => this.#settingsTransfer.exportSettings(),
        import: () => this.#settingsTransfer.chooseFileAndImport(),
      };
      this.#openMenuBelow(button, [
        { id: 'export', label: 'Export settings (JSON)' },
        { id: 'import', label: 'Import settings…' },
      ], entryId => actions[entryId]());
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
   * Serializes a value to JSON with every object's keys sorted, so two values built from the same
   * data by independent code paths compare equal regardless of key insertion order.
   * @param {*} value The value.
   * @returns {string} The canonical JSON text.
   */
  function canonicalJson(value) {
    return JSON.stringify(sortKeysDeep(value));
  }

  /**
   * Recursively rebuilds a value with every plain object's keys sorted; arrays keep their order,
   * since it's meaningful there.
   * @param {*} value The value.
   * @returns {*} An equivalent value with sorted object keys.
   */
  function sortKeysDeep(value) {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value && typeof value === 'object') return sortObjectKeys(value);
    return value;
  }

  /**
   * Rebuilds a plain object with its keys sorted and its values recursively sorted.
   * @param {object} value The object.
   * @returns {object} The rebuilt object.
   */
  function sortObjectKeys(value) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeysDeep(value[key])]));
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
     * @param {object} data The widget's own data (its tool call's input), to match against.
     * @returns {Promise<{html: string, cssHrefs: string[]}>} The card's outer HTML and the
     * stylesheet URLs it depends on.
     * @throws {Error} When the widget doesn't appear within the timeout.
     */
    static async extract(conversationId, data) {
      const iframe = WidgetIframeSource.#createHiddenIframe(conversationId);
      document.body.append(iframe);
      try {
        return await WidgetIframeSource.#searchAllPositions(iframe, canonicalJson(data));
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
     * @param {string} dataJson The widget's data, pre-serialized for comparison.
     * @returns {Promise<{html: string, cssHrefs: string[]}>} The extracted card.
     * @throws {Error} When the widget doesn't appear within the timeout.
     */
    static async #searchAllPositions(iframe, dataJson) {
      const deadline = Date.now() + WidgetIframeSource.#TIMEOUT_MS;
      for (const fraction of WidgetIframeSource.#SCROLL_FRACTIONS) {
        if (Date.now() >= deadline) break;
        if (fraction !== null) WidgetIframeSource.#scrollTo(iframe, fraction);
        const stepDeadline = Math.min(deadline, Date.now() + WidgetIframeSource.#STEP_TIMEOUT_MS);
        const found = await WidgetIframeSource.#pollUntil(iframe, dataJson, stepDeadline);
        if (found) return found;
      }
      throw new Error('widget did not render within the timeout');
    }

    /**
     * Polls the current scroll position until the widget appears or its step deadline elapses.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @param {string} dataJson The widget's data, pre-serialized for comparison.
     * @param {number} stepDeadline Epoch ms after which to stop trying this position.
     * @returns {Promise<?{html: string, cssHrefs: string[]}>} The extracted card, or null when this
     * position never showed it.
     */
    static #pollUntil(iframe, dataJson, stepDeadline) {
      return new Promise(resolve => {
        const poll = () => WidgetIframeSource.#pollOnce(iframe, dataJson, stepDeadline, poll, resolve);
        poll();
      });
    }

    /**
     * One poll attempt: resolves with the card if found, with null past the step deadline, else
     * schedules another attempt.
     * @param {HTMLIFrameElement} iframe The extraction iframe.
     * @param {string} dataJson The widget's data, pre-serialized for comparison.
     * @param {number} stepDeadline Epoch ms after which to stop trying this position.
     * @param {function(): void} poll This function, to schedule the next attempt.
     * @param {function(?{html: string, cssHrefs: string[]}): void} resolve Resolves this position's search.
     * @returns {void}
     */
    static #pollOnce(iframe, dataJson, stepDeadline, poll, resolve) {
      const found = WidgetIframeSource.#tryFind(iframe, dataJson);
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
     * @param {string} dataJson The widget's data, pre-serialized for comparison.
     * @returns {?{html: string, cssHrefs: string[]}} The extracted card, or null when not found yet.
     */
    static #tryFind(iframe, dataJson) {
      const documentInFrame = WidgetIframeSource.#documentOf(iframe);
      const rootElement = documentInFrame?.getElementById('root');
      const rootFiber = rootElement ? WidgetIframeSource.#fiberOf(rootElement) : null;
      if (!rootFiber) return null;
      const hostElement = WidgetIframeSource.#findWidgetElement(rootFiber, dataJson);
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
     * @param {string} dataJson The widget's data, pre-serialized for comparison.
     * @returns {?HTMLElement} The widget's outermost rendered element, or null when not found.
     */
    static #findWidgetElement(rootFiber, dataJson) {
      return WidgetIframeSource.#searchForHostElement(rootFiber, new Set(), dataJson);
    }

    /**
     * Depth-first search of the fiber tree for a matching node with a resolvable DOM element.
     * @param {?object} fiber Fiber to check, or null past the end of a branch.
     * @param {Set<object>} visited Fibers already checked, since child/sibling links can cross-reference.
     * @param {string} dataJson The widget's data, pre-serialized for comparison.
     * @returns {?HTMLElement} The element, or null.
     */
    static #searchForHostElement(fiber, visited, dataJson) {
      if (!fiber || visited.has(fiber)) return null;
      visited.add(fiber);
      return WidgetIframeSource.#ownHostElement(fiber, dataJson)
        || WidgetIframeSource.#searchForHostElement(fiber.child, visited, dataJson)
        || WidgetIframeSource.#searchForHostElement(fiber.sibling, visited, dataJson);
    }

    /**
     * A fiber's own resolvable DOM element, if it matches the target data and renders one.
     * @param {object} fiber The fiber.
     * @param {string} dataJson The widget's data, pre-serialized for comparison.
     * @returns {?HTMLElement} The element, or null.
     */
    static #ownHostElement(fiber, dataJson) {
      return WidgetIframeSource.#isWidgetFiber(fiber, dataJson) ? WidgetIframeSource.#firstHostElement(fiber) : null;
    }

    /**
     * Whether a fiber's props identify it as the widget with matching data.
     * @param {object} fiber The fiber.
     * @param {string} dataJson The widget's data, pre-serialized for comparison.
     * @returns {boolean} True when its input prop matches.
     */
    static #isWidgetFiber(fiber, dataJson) {
      const props = fiber.memoizedProps;
      return Boolean(props) && typeof props === 'object' && 'input' in props && canonicalJson(props.input) === dataJson;
    }

    /**
     * The first real DOM element a fiber (or its descendants) renders to.
     * @param {object} fiber The fiber.
     * @returns {?HTMLElement} The element, or null when it renders nothing yet.
     */
    static #firstHostElement(fiber) {
      let node = fiber;
      while (node) {
        if (node.stateNode instanceof HTMLElement) return node.stateNode;
        node = node.child;
      }
      return null;
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
   * Composes every part of the UI and starts it.
   */
  class ClaudePlusApp {
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
     * The stylesheet of the whole UI: the theme variables, the toolbar height from the layout
     * configuration, then the stylesheets every component registered.
     * @returns {string} The stylesheet text.
     */
    static #interfaceStylesheet() {
      const layoutVariables = `:root { --claude-plus-toolbar-height: ${LAYOUT.toolbarHeight}px; }`;
      return [themeStylesheet, layoutVariables, StyleRegistry.combinedCss].join('\n');
    }

    /**
     * Mounts the UI, then hides claude.ai and loads the data. If mounting fails, everything this
     * script added is removed again, so claude.ai stays usable instead of turning into a blank page.
     * @returns {Promise<void>} Resolves once the first conversation is shown, or after a failed mount.
     */
    async start() {
      const services = ClaudePlusApp.#mountOrRestore();
      if (services) await ClaudePlusApp.#loadData(services);
    }

    /**
     * Mounts the UI and hides the native app, or undoes everything when mounting throws.
     * @returns {?object} The services needing data (directory, router, paneManager, stats, activity, rateLimits), or null after a failure.
     */
    static #mountOrRestore() {
      try {
        const services = ClaudePlusApp.#mountInterface();
        document.head.append(createElement('style', { className: 'claude-plus-styles', textContent: nativeAppHidingStylesheet }));
        return services;
      } catch (error) {
        ClaudePlusApp.#removeInterface();
        console.error(LOG_PREFIX, 'failed to start; claude.ai was left unchanged', error);
        return null;
      }
    }

    /**
     * Injects the styles, builds every component and mounts the toolbar and the workspace.
     * @returns {object} The services needing data: directory, router, paneManager, stats, activity and rateLimits.
     * @throws {Error} When any part fails to build or mount.
     */
    static #mountInterface() {
      document.head.append(createElement('style', { className: 'claude-plus-styles', textContent: ClaudePlusApp.#interfaceStylesheet() }));
      const preferences = new Preferences();
      const api = new ClaudeApi();
      const database = new IndexedDbStore({ name: DATABASE.name, version: DATABASE.version, upgrade: ClaudePlusApp.#createMissingStores });
      const settings = new ComposerSettings(preferences);
      const directory = new ConversationDirectory(api);
      const stats = new StatsIndex(api, database);
      const activity = new ActivityTracker(database);
      const rateLimits = new RateLimitMonitor(api);
      const widgetExtractor = new WidgetExtractor(database);
      const paneManager = new ChatPaneManager({ api, settings, directory, preferences, stats, widgetExtractor });
      const router = new Router(paneManager);
      ClaudePlusApp.#connectServices({ directory, paneManager, stats, rateLimits });
      paneManager.restorePanes(conversationIdFromPath(location.pathname));

      const panelFactory = new PanelFactory({ directory, router, paneManager, stats, activity, rateLimits, preferences });
      const composer = new ComposerPanel({ paneManager, settings, stats, exporter: new ConversationExporter(api, paneManager) });
      const workspace = ClaudePlusApp.#createWorkspace({ preferences, paneManager, panelFactory, composer });
      paneManager.attachWorkspace(workspace);
      panelFactory.attachWorkspace(workspace);
      const layoutLibrary = new LayoutLibrary({ preferences, workspace, paneManager, panelFactory });
      new Toolbar({ preferences, workspace, layoutLibrary, settingsTransfer: new SettingsTransfer(preferences) }).mount();
      workspace.mount();
      ClaudePlusApp.#refreshTabTitlesOnChange(workspace, directory, paneManager);
      new KeyboardShortcuts(workspace).install();
      return { directory, router, paneManager, stats, activity, rateLimits };
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
     * @param {ConversationDirectory} services.directory Shared conversation list.
     * @param {ChatPaneManager} services.paneManager Chat panes.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {RateLimitMonitor} services.rateLimits Usage windows.
     * @returns {void}
     */
    static #connectServices({ directory, paneManager, stats, rateLimits }) {
      paneManager.subscribe('conversationLoaded', conversation => stats.indexConversation(conversation));
      paneManager.subscribe('rateLimits', limits => rateLimits.setLimits(limits));
      directory.subscribe('conversationDeleted', conversationId => stats.removeConversation(conversationId));
    }

    /**
     * Redraws the tab strips when a chat pane's title can have changed.
     * @param {DockWorkspace} workspace The workspace.
     * @param {ConversationDirectory} directory Shared conversation list, whose titles the chat tabs show.
     * @param {ChatPaneManager} paneManager Chat panes.
     * @returns {void}
     */
    static #refreshTabTitlesOnChange(workspace, directory, paneManager) {
      directory.subscribe('conversations', () => workspace.layout());
      paneManager.subscribe('paneConversations', () => workspace.layout());
    }

    /**
     * Removes every element and stylesheet this script added.
     * @returns {void}
     */
    static #removeInterface() {
      document.querySelectorAll('.claude-plus-styles, body > [class*="claude-plus-"]').forEach(element => element.remove());
    }

    /**
     * Starts polling, loads stats, activity and the conversation list, opens the URL's conversation
     * in the focused pane and reopens the other panes' conversations.
     * @param {object} services Services created by #mountInterface.
     * @param {ConversationDirectory} services.directory Shared conversation list.
     * @param {Router} services.router Navigation.
     * @param {ChatPaneManager} services.paneManager Chat panes.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {ActivityTracker} services.activity Active-time tracking.
     * @param {RateLimitMonitor} services.rateLimits Usage windows.
     * @returns {Promise<void>} Resolves once the focused pane's conversation is shown.
     */
    static async #loadData({ directory, router, paneManager, stats, activity, rateLimits }) {
      rateLimits.start();
      await Promise.all([stats.refreshAggregate(), activity.start(), directory.refresh()]);
      paneManager.openRestoredConversations();
      await router.start();
    }
  }

  new ClaudePlusApp().start().catch(error => console.error(LOG_PREFIX, 'failed to start', error));

})();
