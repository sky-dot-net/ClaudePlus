/**
 * Checks that the active chat shows an animated bar at the bottom of the pane while a reply is
 * streaming in, and hides it again once the reply finishes.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function sendingIndicator(run) {
  const { page } = run;
  const sendingBar = page.locator('.claude-plus-panel--focused [data-name="sendingBar"]');
  run.check('the sending bar is hidden before a prompt is sent', await sendingBar.isHidden());
  const promptInput = run.composer.locator('[data-name="promptInput"]');
  await promptInput.fill('second question');
  await promptInput.press('Enter');
  run.check('the sending bar appears while a reply is streaming', await sendingBar.isVisible());
  await page.waitForFunction(() => document.querySelector('[data-name="stopButton"]').hidden);
  run.check('the sending bar disappears once the reply finishes', await sendingBar.isHidden());
}

module.exports = { sendingIndicator };
