/**
 * IndexedDB database: conversation summaries keyed by conversation id, active time keyed by day,
 * extracted widget cards keyed by a hash of their tool name and data, and imported-data-export
 * records. Each store maps to its key path; a key path can be a single field or, for a record with
 * no single natural id, an array of fields forming a compound key.
 * @type {Readonly<{name: string, version: number, stores: Readonly<Record<string, string>>, keyPaths: Readonly<Record<string, string|string[]>>}>}
 */
export const DATABASE = Object.freeze({
  name: 'claudePlus',
  version: 3,
  stores: Object.freeze({
    conversationSummaries: 'conversationSummaries',
    activity: 'activity',
    widgetCards: 'widgetCards',
    importedConversations: 'importedConversations',
    importedMemoryFiles: 'importedMemoryFiles',
    importedArtifacts: 'importedArtifacts',
    importedProjects: 'importedProjects',
    importedFeedbackPeriods: 'importedFeedbackPeriods',
    importedAccountProfiles: 'importedAccountProfiles',
    importedLoginEvents: 'importedLoginEvents',
  }),
  keyPaths: Object.freeze({
    conversationSummaries: 'conversationId',
    activity: 'day',
    widgetCards: 'hash',
    importedConversations: 'conversationId',
    importedMemoryFiles: ['accountId', 'path'],
    importedArtifacts: 'artifactId',
    importedProjects: 'projectId',
    importedFeedbackPeriods: ['accountId', 'period'],
    importedAccountProfiles: 'accountId',
    importedLoginEvents: ['accountId', 'timestamp', 'ipAddress'],
  }),
});
