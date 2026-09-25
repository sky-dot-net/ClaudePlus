/**
 * Checks deleting a conversation through the themed confirm dialog, and Ctrl+K focusing the
 * Chats search.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function deleteAndShortcut(run) {
  const { page } = run;
  const chatRows = () => run.chatsPanel.locator('tbody tr.claude-plus-conversation');
  const rowsBefore = await chatRows().count();
  const deletedConversationId = await chatRows().first().getAttribute('data-conversation-id');
  await chatRows().first().hover();
  await chatRows().first().locator('[data-action="delete"]').click();
  await page.click('.claude-plus-dialog .claude-plus-primary-button');
  await page.waitForTimeout(200);
  run.check('delete via themed dialog removes the row', await chatRows().count() === rowsBefore - 1 && await run.chatsPanel.locator(`tr[data-conversation-id="${deletedConversationId}"]`).count() === 0);
  await page.keyboard.press('Control+k');
  run.check('Ctrl+K focuses the chats search', await page.evaluate(() => document.activeElement?.dataset.name === 'searchInput'));
}

module.exports = { deleteAndShortcut };
