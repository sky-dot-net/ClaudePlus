/**
 * One thing a search can find.
 * @typedef {object} SearchItem
 * @property {'chat'|'file'|'source'|'tool'} kind What was found.
 * @property {string} text The item's own text: chat title, file name, source title or tool name.
 * @property {?string} detail Secondary text: the source's outlet and URL, otherwise null.
 * @property {string} conversationId Conversation the item belongs to.
 * @property {string} conversationTitle Title of that conversation.
 * @property {?string} timestamp ISO timestamp of the item.
 * @property {boolean} isImported Whether the conversation it belongs to was imported.
 * @property {?string} messageId Message the item matched in, when it's tied to one specific message
 * (a file, source or tool call); null for a chat-title match, which isn't.
 * @property {string} [reason] Why it matched, set on results.
 */

export {};
