/**
 * Checks the Web Sources table with its outlet filter and message-jump double-click, and the
 * Files panel's folder table opening a file table, its own message-jump double-click, and going back.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function sourceAndFilePanels(run) {
  const { page } = run;
  await run.openTab('Web Sources');
  const sourcesPanel = run.panelWith('outletTotal');
  run.check('Web Sources table lists sources', await sourcesPanel.locator('tbody tr').count() === 2);
  await sourcesPanel.locator('[data-filter-column="outlet"]').fill('*test*');
  await page.waitForTimeout(50);
  run.check('outlet wildcard filter', await sourcesPanel.locator('tbody tr').count() === 1);
  await sourcesPanel.locator('[data-filter-column="outlet"]').fill('');
  await page.keyboard.press('Escape');
  await sourcesPanel.locator('tbody tr').first().dblclick();
  await page.waitForTimeout(200);
  run.check('double-clicking a web source jumps to and highlights its message', await page.locator('.claude-plus-message--highlighted').count() === 1);
  await run.openTab('Files');
  const filesPanel = run.panelWith('folderTableHost');
  run.check('Files: folder table at top level', await filesPanel.locator('[data-name="folderTableHost"] tbody tr.claude-plus-folder').count() === 1);
  await filesPanel.locator('tr.claude-plus-folder').click();
  await page.waitForTimeout(50);
  run.check('Files: folder opens a file table', await filesPanel.locator('[data-name="fileTableHost"] tbody tr').count() === 2);
  run.check('claude.ai\'s quote-reply attachment never counts as a real file', await filesPanel.locator('[data-name="fileTableHost"] tbody tr', { hasText: 'excerpt_from_previous' }).count() === 0);
  const quoteChip = page.locator('.claude-plus-message-attachment--quote');
  run.check('a quote-reply attachment renders as a "Quote, N line" chip, not a raw filename', await quoteChip.count() === 1 && (await quoteChip.textContent()).includes('Quote, 1 line'), await quoteChip.count() ? await quoteChip.textContent() : 'not found');
  await filesPanel.locator('[data-name="fileTableHost"] tbody tr').first().dblclick();
  await page.waitForTimeout(200);
  run.check('double-clicking a file jumps to and highlights its message', await page.locator('.claude-plus-message--highlighted').count() === 1);
  await filesPanel.locator('[data-action="back"]').click();
}

module.exports = { sourceAndFilePanels };
