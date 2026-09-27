/**
 * Per-conversation statistics stored in IndexedDB.
 * @typedef {object} ConversationSummary
 * @property {string} conversationId Conversation id; the store's key.
 * @property {string} title Conversation title.
 * @property {string} updatedAt Version of the conversation the summary was computed from.
 * @property {boolean} isImported Whether it came from an imported data export rather than the live API.
 * @property {number} promptCount Number of human messages.
 * @property {Object<string, number>} toolCallCounts Tool calls per tool name.
 * @property {Array<{name: string, timestamp: string, messageId: string}>} toolCalls Each tool call, in order.
 * @property {SourceEntry[]} sources Cited web sources.
 * @property {FileEntry[]} files Uploaded and produced files.
 * @property {number} estimatedTokensIn Estimated tokens sent.
 * @property {number} estimatedTokensOut Estimated tokens received.
 * @property {number[]} responseTimesMs Time from each prompt to its answer.
 */

export {};
