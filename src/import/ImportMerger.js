/**
 * Merges a newly parsed data export into what's already stored, per category, so re-running an
 * import never discards anything and never duplicates anything unchanged. Every rule follows the
 * same idea: a later export is more information about something already known, not a replacement
 * for it.
 */
export class ImportMerger {
  /**
   * How a newly mapped conversation compares to what's already stored.
   * @param {?ImportedConversationRecord} storedRecord The stored record, or null when not seen before.
   * @param {{conversationId: string, title: string, messages: ApiMessage[]}} mapped The newly mapped conversation.
   * @returns {'new'|'changed'|'metadataChanged'|'unchanged'} The classification; 'metadataChanged' means the
   * messages are known but the title differs or the stored record has no date yet.
   */
  static classifyConversation(storedRecord, mapped) {
    if (!storedRecord) return 'new';
    if (ImportMerger.#hasNewMessages(storedRecord, mapped)) return 'changed';
    return storedRecord.title === mapped.title && storedRecord.updatedAt ? 'unchanged' : 'metadataChanged';
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
    if (classification === 'metadataChanged') return { ...storedRecord, title: mapped.title, updatedAt: mapped.updatedAt, lastImportedAt: importedAt };
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
