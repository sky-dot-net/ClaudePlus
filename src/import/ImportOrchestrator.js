import { ClaudeExportMapper } from '../vendors/anthropic/import/ClaudeExportMapper.js';
import { ClaudeExportParser } from '../vendors/anthropic/import/ClaudeExportParser.js';
import { DATABASE } from '../config/DATABASE.js';
import { ImportFileClassifier } from './ImportFileClassifier.js';
import { ImportMerger } from './ImportMerger.js';

/**
 * Runs one import end to end: classifies the selected files, maps and merges each category
 * against what's already stored, and writes only what actually changed.
 */
export class ImportOrchestrator {
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
   * Imports a set of selected files.
   * @param {File[]} files The files the user selected.
   * @returns {Promise<object>} Per-category counts: conversations {new, changed, renamedOnly,
   * unchanged}, and written/total for memoryFiles, artifacts, projects, feedbackPeriods and
   * loginEvents; accountProfile is true when a profile was written.
   * @throws {Error} When no conversations.json was among the selected files.
   */
  async importFiles(files) {
    const classified = await ImportFileClassifier.classify(files);
    if (!classified.conversationsJson) throw new Error('No conversations.json was among the selected files.');
    const importedAt = new Date().toISOString();
    const artifacts = await this.#importArtifacts(classified.artifacts);
    return {
      conversations: await this.#importConversations(classified.conversationsJson, artifacts.byId, importedAt),
      memoryFiles: await this.#importEach(DATABASE.stores.importedMemoryFiles, classified.memoriesJsons.flatMap(ClaudeExportParser.memoryFiles), record => [record.accountId, record.path], ImportMerger.mergeMemoryFile),
      artifacts: artifacts.tally,
      projects: await this.#importEach(DATABASE.stores.importedProjects, classified.projectsJsons.map(ClaudeExportParser.project), record => record.projectId, ImportMerger.mergeProject),
      feedbackPeriods: await this.#importEach(DATABASE.stores.importedFeedbackPeriods, classified.feedbackJsons.flatMap(ClaudeExportParser.feedbackPeriods), record => [record.accountId, record.period], ImportMerger.mergeFeedbackPeriod),
      accountProfile: await this.#importAccountProfile(classified.usersJson),
      loginEvents: await this.#importEach(DATABASE.stores.importedLoginEvents, classified.loginHistoryJson ? ClaudeExportParser.loginEvents(classified.loginHistoryJson) : [], record => [record.accountId, record.timestamp, record.ipAddress], ImportMerger.mergeLoginEvent),
    };
  }

  /**
   * Imports every conversation, tallying its classification.
   * @param {Array} conversationsJson The raw conversations.
   * @param {Map<string, {html: string}>} artifactsById Imported Artifact content, by artifact id.
   * @param {string} importedAt ISO timestamp of this import.
   * @returns {Promise<{new: number, changed: number, renamedOnly: number, unchanged: number}>} The counts.
   */
  async #importConversations(conversationsJson, artifactsById, importedAt) {
    const tally = { new: 0, changed: 0, renamedOnly: 0, unchanged: 0 };
    for (const rawConversation of conversationsJson) {
      const mapped = ClaudeExportMapper.mapConversation(rawConversation, artifactsById);
      const stored = await this.#conversationStore.getRecord(mapped.conversationId);
      tally[ImportMerger.classifyConversation(stored, mapped)] += 1;
      const merged = ImportMerger.mergeConversation(stored, mapped, importedAt);
      if (merged) await this.#conversationStore.write(merged);
    }
    return tally;
  }

  /**
   * Imports every Artifact, tallying how many were written.
   * @param {Array<{artifactJson: object, htmlByVersionId: Map<string, string>}>} artifacts Classified Artifact files.
   * @returns {Promise<{byId: Map<string, {html: string}>, tally: {written: number, total: number}}>}
   * Every parsed Artifact by id (whether written or already known, for resolving conversations),
   * and how many were newly written.
   */
  async #importArtifacts(artifacts) {
    const parsed = artifacts.map(({ artifactJson, htmlByVersionId }) => ClaudeExportParser.artifact(artifactJson, htmlByVersionId));
    let written = 0;
    for (const record of parsed) {
      const stored = await this.#database.read(DATABASE.stores.importedArtifacts, record.artifactId);
      const merged = ImportMerger.mergeArtifact(stored, record);
      if (merged) { await this.#database.write(DATABASE.stores.importedArtifacts, merged); written += 1; }
    }
    return { byId: new Map(parsed.map(record => [record.artifactId, record])), tally: { written, total: parsed.length } };
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
}
