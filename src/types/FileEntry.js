/**
 * A file uploaded by the user or produced by Claude.
 * @typedef {object} FileEntry
 * @property {string} path Path or name.
 * @property {string} title Display name.
 * @property {string} timestamp ISO timestamp.
 * @property {'user'|'claude'} source Who provided the file.
 * @property {string} [conversationTitle] Title of the conversation, set once aggregated.
 * @property {string} [conversationId] Id of the conversation, set once aggregated.
 * @property {string} [extension] Lower-case file extension, set once aggregated.
 */

export {};
