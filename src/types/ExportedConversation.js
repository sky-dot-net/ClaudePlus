/**
 * A conversation in a format-neutral shape, as exported.
 * @typedef {object} ExportedConversation
 * @property {string} id Conversation id.
 * @property {string} title Conversation title.
 * @property {?string} createdAt ISO creation timestamp, or null when unknown.
 * @property {string} updatedAt ISO timestamp of the last change.
 * @property {string} exportedAt ISO timestamp of the export.
 * @property {ExportedMessage[]} messages Messages of the current branch, oldest first.
 */

export {};
