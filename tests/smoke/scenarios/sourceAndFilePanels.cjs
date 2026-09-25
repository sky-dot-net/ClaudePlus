/**
 * Checks the Web Sources table with its outlet filter, and the Files panel's folder table
 * opening a file table and going back.
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
  await run.openTab('Files');
  const filesPanel = run.panelWith('folderTableHost');
  run.check('Files: folder table at top level', await filesPanel.locator('[data-name="folderTableHost"] tbody tr.claude-plus-folder').count() === 1);
  await filesPanel.locator('tr.claude-plus-folder').click();
  await page.waitForTimeout(50);
  run.check('Files: folder opens a file table', await filesPanel.locator('[data-name="fileTableHost"] tbody tr').count() === 2);
  await filesPanel.locator('[data-action="back"]').click();
}

module.exports = { sourceAndFilePanels };
