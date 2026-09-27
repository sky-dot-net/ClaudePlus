import { ClaudeExportMapper } from '../vendors/anthropic/import/ClaudeExportMapper.js';
import { ClaudeExportParser } from '../vendors/anthropic/import/ClaudeExportParser.js';
import { DATABASE } from '../config/DATABASE.js';
import { ImportFileClassifier } from './ImportFileClassifier.js';
import { ImportMerger } from './ImportMerger.js';
import { StreamingJsonArrayReader } from './StreamingJsonArrayReader.js';

/**
 * Runs an import in two passes over conversations.json, never holding more than one conversation's
 * full message body in memory at a time so a real export's file - hundreds of megabytes is normal -
 * never has to be read whole: previewClassified() streams through once to classify every
 * conversation and build the lightweight rows a picker UI shows, without writing anything; apply()
 * streams through again and writes only the conversations selected from that preview, plus every
 * other category.
 */
export class ImportOrchestrator {
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
   * Creates the orchestrator.
   * @param {IndexedDbStore} database Backing storage.
   * @param {ImportedConversationStore} conversationStore Imported conversations.
   */
  constructor(database, conversationStore) {
    this.#database = database;
    this.#conversationStore = conversationStore;
  }

  /**
   * Classifies the selected files without writing anything, ready for a picker UI: one row per
   * conversation, plus counts for every other category.
   * @param {File[]} files The files the user selected.
   * @param {function(number): void} [onConversationProgress] Called with the number of
   * conversations classified so far, periodically during the scan.
   * @returns {Promise<{classified: object, artifactRecords: object[], conversationRows: Array<{conversationId: string, title: string, updatedAt: string, promptCount: number, classification: string}>}>}
   * The raw classification (for apply()), the parsed Artifact records, and the conversation rows.
   * @throws {Error} When no conversations.json was among the selected files.
   */
  async previewClassified(files, onConversationProgress) {
    const classified = await ImportFileClassifier.classify(files);
    if (!classified.conversationsFile) throw new Error('No conversations.json was among the selected files.');
    const artifactRecords = classified.artifacts.map(({ artifactJson, htmlByVersionId }) => ClaudeExportParser.artifact(artifactJson, htmlByVersionId));
    const artifactsById = new Map(artifactRecords.map(record => [record.artifactId, record]));
    const conversationRows = await this.#previewConversations(classified.conversationsFile, artifactsById, onConversationProgress);
    return { classified, artifactRecords, conversationRows };
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
   * @param {function(number): void} [onProgress] Called with the number classified so far.
   * @returns {Promise<Array<{conversationId: string, title: string, updatedAt: string, promptCount: number, classification: string}>>}
   * The rows, in file order.
   */
  async #previewConversations(conversationsFile, artifactsById, onProgress) {
    const rows = [];
    let processed = 0;
    for await (const rawConversation of StreamingJsonArrayReader.readArray(conversationsFile)) {
      const mapped = ClaudeExportMapper.mapConversation(rawConversation, artifactsById);
      const stored = await this.#conversationStore.getRecord(mapped.conversationId);
      rows.push({
        conversationId: mapped.conversationId,
        title: mapped.title,
        updatedAt: rawConversation.updated_at,
        promptCount: mapped.messages.filter(message => message.sender === 'human').length,
        classification: ImportMerger.classifyConversation(stored, mapped),
      });
      processed += 1;
      await ImportOrchestrator.#reportProgressIfDue(processed, onProgress);
    }
    onProgress?.(processed);
    return rows;
  }

  /**
   * Streams every conversation again, writing only the ones selected from the preview.
   * @param {File} conversationsFile The conversations.json file.
   * @param {Map<string, {html: string}>} artifactsById Parsed Artifact content, by artifact id.
   * @param {Set<string>} selectedConversationIds Ids of the conversations to write.
   * @param {string} importedAt ISO timestamp of this import.
   * @param {function(number): void} [onProgress] Called with the number processed so far.
   * @returns {Promise<{new: number, changed: number, renamedOnly: number, unchanged: number}>} The
   * counts, among the selected conversations only.
   */
  async #applyConversations(conversationsFile, artifactsById, selectedConversationIds, importedAt, onProgress) {
    const tally = { new: 0, changed: 0, renamedOnly: 0, unchanged: 0 };
    let processed = 0;
    for await (const rawConversation of StreamingJsonArrayReader.readArray(conversationsFile)) {
      if (selectedConversationIds.has(rawConversation.uuid)) await this.#applyOneConversation(rawConversation, artifactsById, importedAt, tally);
      processed += 1;
      await ImportOrchestrator.#reportProgressIfDue(processed, onProgress);
    }
    onProgress?.(processed);
    return tally;
  }

  /**
   * Maps, classifies and merges one selected conversation, tallying its classification.
   * @param {object} rawConversation A conversations.json entry.
   * @param {Map<string, {html: string}>} artifactsById Parsed Artifact content, by artifact id.
   * @param {string} importedAt ISO timestamp of this import.
   * @param {{new: number, changed: number, renamedOnly: number, unchanged: number}} tally Counts to update.
   * @returns {Promise<void>} Resolves once written, if anything changed.
   */
  async #applyOneConversation(rawConversation, artifactsById, importedAt, tally) {
    const mapped = ClaudeExportMapper.mapConversation(rawConversation, artifactsById);
    const stored = await this.#conversationStore.getRecord(mapped.conversationId);
    tally[ImportMerger.classifyConversation(stored, mapped)] += 1;
    const merged = ImportMerger.mergeConversation(stored, mapped, importedAt);
    if (merged) await this.#conversationStore.write(merged);
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
