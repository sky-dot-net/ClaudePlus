/**
 * Optional categories of a data export: how to detect and count them in a classified result, their
 * count line's noun phrase, the toggle they show when present (null for a category with no opt-out,
 * like Artifacts), and the classified fields an unchecked toggle clears.
 * @type {ReadonlyArray<{isPresent: function(object): boolean, count: function(object): number, countNoun: string, toggleKey: ?string, toggleLabel: ?string, fields: string[]}>}
 */
export const IMPORT_OPTIONAL_CATEGORIES = Object.freeze([
  {
    isPresent: classified => classified.memoriesJsons.length > 0,
    count: classified => classified.memoriesJsons.flatMap(json => json.memory_files).length,
    countNoun: 'memory file(s)', toggleKey: 'memoryFiles', toggleLabel: 'Import memory files', fields: ['memoriesJsons'],
  },
  {
    isPresent: classified => classified.artifacts.length > 0,
    count: classified => classified.artifacts.length,
    countNoun: 'Artifact(s)', toggleKey: null, toggleLabel: null, fields: [],
  },
  {
    isPresent: classified => classified.projectsJsons.length > 0,
    count: classified => classified.projectsJsons.length,
    countNoun: 'Project(s)', toggleKey: 'projects', toggleLabel: 'Import Projects', fields: ['projectsJsons'],
  },
  {
    isPresent: classified => classified.feedbackJsons.length > 0,
    count: classified => classified.feedbackJsons.flatMap(json => json.reflections).length,
    countNoun: 'Feedback period(s)', toggleKey: 'feedbackPeriods', toggleLabel: 'Import Feedback/reflections', fields: ['feedbackJsons'],
  },
  {
    isPresent: classified => Boolean(classified.usersJson) || Boolean(classified.loginHistoryJson),
    count: classified => (classified.loginHistoryJson?.login_events.length ?? 0),
    countNoun: 'login event(s), plus the account profile', toggleKey: 'accountMetadata', toggleLabel: 'Import account profile and login history', fields: ['usersJson', 'loginHistoryJson'],
  },
]);
