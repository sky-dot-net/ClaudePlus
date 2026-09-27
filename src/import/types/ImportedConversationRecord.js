/**
 * A conversation stored from a data export, shaped like ApiConversation so it renders through the
 * app's existing pipeline unmodified.
 * @typedef {object} ImportedConversationRecord
 * @property {string} conversationId Conversation id; the store's key.
 * @property {string} title Conversation title.
 * @property {ApiMessage[]} messages Every message ever seen for this conversation across all
 * imports, with parent links; may contain more than one branch.
 * @property {?string} currentLeafId Id of the branch shown by default; recomputed on every merge;
 * null when the conversation has no messages at all.
 * @property {string} lastImportedAt ISO timestamp of the most recent import that touched this
 * conversation.
 */

export {};
