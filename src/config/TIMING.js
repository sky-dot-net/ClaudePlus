/**
 * Timing in milliseconds. rateLimitPollMs: usage polling interval. activitySampleMs: activity
 * sampling interval. idleAfterMs: time without input after which the user counts as idle.
 * activitySaveMs: how often activity is written to IndexedDB. backfillPauseMs: pause between
 * conversation fetches during a backfill. maxResponseGapMs: longest prompt-to-answer gap still
 * counted as a response time. copyFeedbackMs: how long the copy button shows a check mark.
 * downloadUrlLifetimeMs: how long a download's object URL stays valid after the download starts.
 * widgetExtractPollMs: how often the widget extractor checks its hidden iframe for the rendered card.
 * modelCatalogPollMs: how often the model catalog extractor checks its hidden iframe.
 * modelCatalogTimeoutMs: time budget for extracting the model/effort catalog before giving up.
 * modelCatalogTtlMs: how long an extracted catalog is trusted before it's refreshed again.
 * @type {Readonly<Record<string, number>>}
 */
export const TIMING = Object.freeze({
  rateLimitPollMs: 30_000,
  activitySampleMs: 1_000,
  idleAfterMs: 60_000,
  activitySaveMs: 15_000,
  backfillPauseMs: 300,
  maxResponseGapMs: 30 * 60 * 1000,
  copyFeedbackMs: 1_000,
  downloadUrlLifetimeMs: 10_000,
  widgetExtractPollMs: 500,
  modelCatalogPollMs: 300,
  modelCatalogTimeoutMs: 20_000,
  modelCatalogTtlMs: 12 * 60 * 60 * 1000,
});
