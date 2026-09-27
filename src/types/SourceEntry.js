/**
 * A web source cited by a tool result.
 * @typedef {object} SourceEntry
 * @property {string} title Page title.
 * @property {string} url Page URL.
 * @property {?string} outlet Host name without "www.".
 * @property {?string} topLevelDomain Top-level domain without the dot.
 * @property {string} timestamp ISO timestamp.
 * @property {string} messageId Id of the message that cited it.
 * @property {string} [conversationTitle] Title of the conversation, set once aggregated.
 * @property {string} [conversationId] Id of the conversation, set once aggregated.
 * @property {boolean} [isImported] Whether its conversation was imported, set once aggregated.
 */

export {};
