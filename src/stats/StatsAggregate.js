import { addToCount } from '../math/addToCount.js';
import { fileExtension } from '../text/fileExtension.js';
import { toEpochMs } from '../time/toEpochMs.js';

/**
 * Totals across every stored conversation summary.
 */
export class StatsAggregate {
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
