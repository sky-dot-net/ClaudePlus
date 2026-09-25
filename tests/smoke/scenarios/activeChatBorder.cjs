const { FIXTURE_IDS } = require('../FIXTURE_IDS.cjs');

/**
 * Checks that the active chat is outlined only while several chat panes are visible, by opening
 * the second chat in a new pane from the Chats list.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function activeChatBorder(run) {
  const { page } = run;
  run.check('no active-chat border with one visible chat pane', await page.locator('.claude-plus-panel--active-among-several').count() === 0);
  const secondChatRow = run.chatsPanel.locator(`tr[data-conversation-id="${FIXTURE_IDS.secondChat}"]`);
  await secondChatRow.hover();
  await secondChatRow.locator('[data-action="openInNewPane"]').click();
  await page.waitForTimeout(200);
  const outlined = await page.$$eval('.claude-plus-panel--active-among-several', panels => panels.map(panel => panel.textContent.includes('hello')));
  run.check('active chat gets the green border when two chat panes are visible', outlined.length === 1 && outlined[0]);
}

module.exports = { activeChatBorder };
