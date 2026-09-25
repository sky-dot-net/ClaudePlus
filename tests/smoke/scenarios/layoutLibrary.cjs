/**
 * Checks that a layout saved under a name comes back after resetting to the default layout.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function layoutLibrary(run) {
  const { page } = run;
  const tabStripCount = async () => (await page.$$('.claude-plus-tab-strip')).length;
  const stripsBefore = await tabStripCount();
  await page.click('[data-name="layoutsButton"]');
  await page.click('.claude-plus-popup-menu__entry[data-entry-id="save:"]');
  await page.fill('.claude-plus-dialog__input', 'research mode');
  await page.click('.claude-plus-dialog .claude-plus-primary-button');
  await page.click('[data-name="resetLayoutButton"]');
  await page.waitForTimeout(100);
  const stripsAfterReset = await tabStripCount();
  await page.click('[data-name="layoutsButton"]');
  await page.click('.claude-plus-popup-menu__entry[data-entry-id="load:research mode"]');
  await page.waitForTimeout(200);
  const stripsAfterLoad = await tabStripCount();
  run.check('layout save → reset → load restores the arrangement', stripsAfterReset === 4 && stripsAfterLoad === stripsBefore, `${stripsBefore} -> ${stripsAfterReset} -> ${stripsAfterLoad}`);
}

module.exports = { layoutLibrary };
