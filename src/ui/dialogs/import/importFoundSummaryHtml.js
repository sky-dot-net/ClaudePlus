import { IMPORT_OPTIONAL_CATEGORIES } from './IMPORT_OPTIONAL_CATEGORIES.js';

/**
 * HTML summarizing how many of each category a scanned export holds, plus notes on the
 * conversations left out of the review table.
 * @param {object} preview A previewClassified() result.
 * @param {object[]} preview.conversationRows The previewed conversation rows.
 * @param {object} preview.classified The classified files.
 * @param {number} preview.failedCount Conversations that couldn't be read at all.
 * @param {number} preview.emptySkippedCount Conversations with no readable content, left out on purpose.
 * @returns {string} The summary.
 */
export function importFoundSummaryHtml({ conversationRows, classified, failedCount, emptySkippedCount }) {
  const present = IMPORT_OPTIONAL_CATEGORIES.filter(category => category.isPresent(classified));
  const lines = [`${conversationRows.length} conversation(s)`, ...present.map(category => `${category.count(classified)} ${category.countNoun}`)];
  const emptyLine = emptySkippedCount > 0 ? `<p class="claude-plus-import-dialog__file-count">${emptySkippedCount} conversation(s) with no readable content (deleted, or never really started) aren't shown below.</p>` : '';
  const failedLine = failedCount > 0 ? `<p class="claude-plus-import-dialog__warning">${failedCount} conversation(s) couldn't be read and are not shown below - see the browser console for details.</p>` : '';
  return `<p class="claude-plus-import-dialog__file-count">Found: ${lines.join(', ')}.</p>${emptyLine}${failedLine}`;
}
