/**
 * IndexedDB database: conversation summaries keyed by conversation id, active time keyed by day,
 * and extracted widget cards keyed by a hash of their tool name and data. Each store maps to its
 * key path.
 * @type {Readonly<{name: string, version: number, stores: Readonly<Record<string, string>>, keyPaths: Readonly<Record<string, string>>}>}
 */
export const DATABASE = Object.freeze({
  name: 'claudePlus',
  version: 2,
  stores: Object.freeze({ conversationSummaries: 'conversationSummaries', activity: 'activity', widgetCards: 'widgetCards' }),
  keyPaths: Object.freeze({ conversationSummaries: 'conversationId', activity: 'day', widgetCards: 'hash' }),
});
