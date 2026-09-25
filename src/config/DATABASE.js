/**
 * IndexedDB database: conversation summaries keyed by conversation id, and active time keyed by day.
 * Each store maps to its key path.
 * @type {Readonly<{name: string, version: number, stores: Readonly<Record<string, string>>, keyPaths: Readonly<Record<string, string>>}>}
 */
export const DATABASE = Object.freeze({
  name: 'claudePlus',
  version: 1,
  stores: Object.freeze({ conversationSummaries: 'conversationSummaries', activity: 'activity' }),
  keyPaths: Object.freeze({ conversationSummaries: 'conversationId', activity: 'day' }),
});
