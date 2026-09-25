/**
 * Checks the zones' "+" menu: a new empty chat that the composer turns into a conversation, and a
 * second, closable Stats panel.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function addPanelMenu(run) {
  const { page } = run;
  await run.chooseFromAddMenu('Research', 'chat');
  const focusedMessages = await page.locator('.claude-plus-panel--focused .claude-plus-message-list').textContent();
  run.check('"+" → Add chat opens an empty chat tab in that zone, focused', focusedMessages.includes('Start a conversation') && await page.locator('.claude-plus-tab', { hasText: 'New chat' }).count() === 1);
  run.check('export is disabled for an unsaved chat', await run.composer.locator('[data-name="exportButton"]').isDisabled());
  await run.sendPrompt('brand new');
  const pathname = await page.evaluate(() => location.pathname);
  run.check('composer creates a conversation from the new chat', Boolean(run.api.completions.at(-1).create_conversation_params) && pathname.startsWith('/chat/'));
  await run.chooseFromAddMenu('Stats', 'stats');
  const statsTabs = page.locator('.claude-plus-tab', { hasText: 'Stats' });
  const indexedCounts = await page.$$eval('[data-name="indexedConversationCount"]', counts => counts.map(count => count.textContent));
  run.check('"+" → Add Stats panel adds a second, independent Stats view', await statsTabs.count() === 2 && indexedCounts.every(count => count === '2'), JSON.stringify(indexedCounts));
  await statsTabs.nth(1).locator('.claude-plus-tab__close-button').click();
  await page.waitForTimeout(100);
  run.check('added view panels can be closed', await statsTabs.count() === 1);
}

module.exports = { addPanelMenu };
