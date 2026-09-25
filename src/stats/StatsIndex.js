import { ConversationSummarizer } from './ConversationSummarizer.js';
import { DATABASE } from '../config/DATABASE.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { LIMITS } from '../config/LIMITS.js';
import { LOG_PREFIX } from '../config/LOG_PREFIX.js';
import { StatsAggregate } from './StatsAggregate.js';
import { SummaryValidator } from './SummaryValidator.js';
import { TIMING } from '../config/TIMING.js';
import { wait } from '../time/wait.js';

/**
 * Per-conversation summaries cached in IndexedDB, plus their aggregate.
 * @fires StatsIndex#aggregate The aggregate was recomputed.
 * @fires StatsIndex#backfill Backfill progress changed.
 */
export class StatsIndex extends EventEmitter {
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
