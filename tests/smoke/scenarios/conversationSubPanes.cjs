/**
 * Checks the active chat's files and sources sub-panes: opening from the composer, their rows,
 * redocking to the left and top, and closing.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function conversationSubPanes(run) {
  await run.composer.locator('[data-name="filesButton"]').click();
  await run.composer.locator('[data-name="sourcesButton"]').click();
  await run.page.waitForTimeout(100);
  const focusedChat = run.page.locator('.claude-plus-panel--focused');
  const filesSubPane = focusedChat.locator('.claude-plus-subpane', { hasText: 'Files' });
  const sourcesSubPane = focusedChat.locator('.claude-plus-subpane', { hasText: 'Sources' });
  run.check('📁 and 🌐 open sub-panes on the right of the active chat', await focusedChat.locator('[data-name="rightSide"] .claude-plus-subpane').count() === 2);
  const rowCounts = await focusedChat.locator('.claude-plus-subpane').evaluateAll(subPanes => subPanes.map(subPane => subPane.querySelectorAll('tbody tr').length));
  run.check('sub-panes list this chat\'s files and sources', JSON.stringify(rowCounts) === '[2,2]', JSON.stringify(rowCounts));
  await filesSubPane.locator('[data-edge="left"]').click();
  await sourcesSubPane.locator('[data-edge="top"]').click();
  run.check('sub-panes redock left and top', await focusedChat.locator('[data-name="leftSide"] .claude-plus-subpane').count() === 1 && await focusedChat.locator('[data-name="topSide"] .claude-plus-subpane').count() === 1);
  await filesSubPane.locator('[data-action="close"]').click();
  await sourcesSubPane.locator('[data-action="close"]').click();
  run.check('sub-panes close', await focusedChat.locator('.claude-plus-subpane').count() === 0);
}

module.exports = { conversationSubPanes };
