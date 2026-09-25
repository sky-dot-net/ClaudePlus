/**
 * Checks that the composer sends a prompt to the active chat as a reply to its last message.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function composerSending(run) {
  const sentBefore = run.api.completions.length;
  await run.sendPrompt('first question');
  const completion = run.api.completions[sentBefore];
  run.check('composer sends to the active chat', completion?.parent_message_uuid === 'm4' && completion?.prompt === 'first question');
}

module.exports = { composerSending };
