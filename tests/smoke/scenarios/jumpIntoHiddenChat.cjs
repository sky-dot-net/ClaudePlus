/**
 * Checks that double-clicking a file in a Files panel that shares a zone with the chat, and so
 * covers it, brings the chat back and highlights the file's message.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function jumpIntoHiddenChat(run) {
  const { page } = run;
  await run.chooseFromAddMenu('Research', 'files');
  const chatList = page.locator('.claude-plus-panel--focused .claude-plus-message-list');
  const wasCovered = await chatList.isHidden();
  const filesPanel = page.locator('.claude-plus-panel:visible', { has: page.locator('[data-name="folderTableHost"]') }).first();
  await filesPanel.locator('tr.claude-plus-folder').click();
  await page.waitForTimeout(50);
  await filesPanel.locator('[data-name="fileTableHost"] tbody tr').first().dblclick();
  await page.waitForTimeout(300);
  const highlightedCount = await page.locator('.claude-plus-message--highlighted').count();
  run.check('jumping from a Files panel that covers the chat reveals the chat and highlights the message', wasCovered && await chatList.isVisible() && highlightedCount === 1, JSON.stringify({ wasCovered, highlightedCount }));
  const zone = page.locator('.claude-plus-tab-strip', { has: page.locator('.claude-plus-tab', { hasText: 'Research' }) });
  await zone.locator('.claude-plus-tab', { hasText: 'Files' }).locator('.claude-plus-tab__close-button').click();
  await page.waitForTimeout(100);
}

module.exports = { jumpIntoHiddenChat };
