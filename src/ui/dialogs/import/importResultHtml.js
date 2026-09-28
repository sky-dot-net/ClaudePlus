/**
 * HTML summarizing what an import wrote.
 * @param {object} result The orchestrator's apply() result.
 * @returns {string} The summary.
 */
export function importResultHtml(result) {
  const { conversations } = result;
  const lines = [
    `${conversations.new} brand-new conversation(s) saved`,
    `${conversations.changed} already-imported conversation(s) got new messages (a continuation or branch since last time)`,
    `${conversations.metadataChanged} already-imported conversation(s) only had their metadata (title or date) changed`,
    `${conversations.unchanged} already-imported conversation(s) had nothing new`,
    conversations.failed > 0 ? `${conversations.failed} selected conversation(s) failed to import - see the browser console for details` : null,
    `${result.memoryFiles.written} of ${result.memoryFiles.total} memory file(s) saved`,
    `${result.artifacts.written} of ${result.artifacts.total} Artifact(s) saved`,
    `${result.projects.written} of ${result.projects.total} Project(s) saved`,
    `${result.feedbackPeriods.written} of ${result.feedbackPeriods.total} Feedback period(s) saved`,
    `${result.loginEvents.written} of ${result.loginEvents.total} login event(s) saved`,
    result.accountProfile ? 'Account profile saved' : null,
  ].filter(Boolean);
  return `<p><strong>Import complete.</strong></p><ul class="claude-plus-import-dialog__detection-list">${lines.map(line => `<li>${line}</li>`).join('')}</ul>`;
}
