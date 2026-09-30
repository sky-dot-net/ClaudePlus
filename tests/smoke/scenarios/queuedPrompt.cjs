/**
 * Sends a prompt, then - while it is still streaming - types and sends a second one.
 * @param {SmokeRun} run The smoke run.
 * @param {string} firstPrompt The prompt sent normally.
 * @param {string} secondPrompt The prompt typed while the first is still streaming.
 * @returns {Promise<void>} Resolves once both have been typed and Enter pressed for each.
 */
async function sendTwoPromptsInARow(run, firstPrompt, secondPrompt) {
  const promptInput = run.composer.locator('[data-name="promptInput"]');
  await promptInput.fill(firstPrompt);
  await promptInput.press('Enter');
  await promptInput.fill(secondPrompt);
  await promptInput.press('Enter');
  await run.page.waitForTimeout(200);
}

/**
 * Checks that a prompt typed and sent while the first is still streaming is queued instead of sent
 * immediately, shown in a chip, and clears the input.
 * @param {SmokeRun} run The smoke run.
 * @param {number} sentBefore Completions recorded before this exchange started.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkPromptIsQueued(run, sentBefore) {
  const queuedRow = run.composer.locator('[data-name="queuedPromptRow"]');
  run.check('a prompt typed while a reply is streaming is queued, not sent immediately', run.api.completions.length === sentBefore + 1, String(run.api.completions.length));
  const queuedText = await queuedRow.locator('[data-name="queuedPromptText"]').textContent();
  const inputValue = await run.composer.locator('[data-name="promptInput"]').inputValue();
  run.check('the queued prompt shows in a chip and clears the input', await queuedRow.isVisible() && queuedText === 'queued second' && inputValue === '', JSON.stringify({ queuedText, inputValue }));
}

/**
 * Checks that the queued prompt sent automatically once the first reply finished, as a reply to
 * the message the first one just added, and that its chip is gone.
 * @param {SmokeRun} run The smoke run.
 * @param {number} sentBefore Completions recorded before this exchange started.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkQueuedPromptAutoSent(run, sentBefore) {
  await run.page.waitForFunction(() => document.querySelector('[data-name="stopButton"]').hidden);
  run.check('the queued prompt sends automatically once the first reply finishes', run.api.completions.length === sentBefore + 2, String(run.api.completions.length));
  const secondCompletion = run.api.completions[sentBefore + 1];
  run.check('the auto-sent prompt is the one that was queued, not the first one again', secondCompletion?.prompt === 'queued second', JSON.stringify(secondCompletion));
  run.check('the queued-prompt chip clears once it has sent', await run.composer.locator('[data-name="queuedPromptRow"]').isHidden());
}

/**
 * Checks the natural queue-then-autosend flow.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkNaturalQueueFlow(run) {
  const sentBefore = run.api.completions.length;
  await sendTwoPromptsInARow(run, 'first of two', 'queued second');
  await checkPromptIsQueued(run, sentBefore);
  await checkQueuedPromptAutoSent(run, sentBefore);
}

/**
 * Checks that "Send now" stops the current reply and sends the queued prompt immediately, instead
 * of waiting for the reply to finish naturally.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkSendNow(run) {
  const sentBefore = run.api.completions.length;
  await sendTwoPromptsInARow(run, 'third prompt', 'send this now');
  run.check('a second prompt queues while a third is still streaming', run.api.completions.length === sentBefore + 1, String(run.api.completions.length));
  await run.composer.locator('[data-name="sendQueuedNowButton"]').click();
  await run.page.waitForFunction(() => document.querySelector('[data-name="stopButton"]').hidden);
  const sentCompletion = run.api.completions[sentBefore + 1];
  run.check('"Send now" stops the reply in progress and sends the queued prompt right away', run.api.completions.length === sentBefore + 2 && sentCompletion?.prompt === 'send this now', JSON.stringify(sentCompletion));
}

/**
 * Checks that the ✕ button drops a queued prompt without ever sending it.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkCancelQueued(run) {
  const sentBefore = run.api.completions.length;
  await sendTwoPromptsInARow(run, 'fourth prompt', 'never sent');
  await run.composer.locator('[data-name="cancelQueuedButton"]').click();
  run.check('the ✕ button drops the queued prompt', await run.composer.locator('[data-name="queuedPromptRow"]').isHidden());
  await run.page.waitForFunction(() => document.querySelector('[data-name="stopButton"]').hidden);
  run.check('a cancelled queued prompt is never sent', run.api.completions.length === sentBefore + 1, String(run.api.completions.length));
}

/**
 * Checks queuing a prompt while a reply is streaming: it queues instead of sending immediately,
 * shows in a chip, auto-sends once the reply finishes, can be sent right away with "Send now"
 * (stopping the reply in progress), and can be dropped with its ✕ button without ever sending.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function queuedPrompt(run) {
  await checkNaturalQueueFlow(run);
  await checkSendNow(run);
  await checkCancelQueued(run);
}

module.exports = { queuedPrompt };
