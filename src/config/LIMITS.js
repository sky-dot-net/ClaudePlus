/**
 * Result limits. sidebarPageSize / backfillPageSize: conversations requested per API page.
 * listedSources: web sources listed at once. rankedOutlets: outlets in the ranking.
 * toolResultCharacters: characters of a tool result shown. provisionalTitleLength: characters of
 * the first prompt used as a new conversation's title. backfillRefreshInterval: conversations
 * stored between aggregate refreshes during a backfill. followOutputDistance: distance from the
 * bottom, in pixels, within which the chat keeps following new output. exportFileNameLength:
 * characters of the conversation title used in an export file name. comboboxEntries: values listed
 * by a filter typeahead. searchResults: results shown by the search panel.
 * @type {Readonly<Record<string, number>>}
 */
export const LIMITS = Object.freeze({
  sidebarPageSize: 100,
  backfillPageSize: 100,
  listedSources: 500,
  rankedOutlets: 30,
  toolResultCharacters: 4000,
  provisionalTitleLength: 60,
  backfillRefreshInterval: 10,
  followOutputDistance: 40,
  exportFileNameLength: 80,
  comboboxEntries: 200,
  searchResults: 300,
});
