/**
 * Selector of the hotkey list of a settings tab's group.
 * @param {string} group Group id, "app" or "anthropic".
 * @returns {string} The selector.
 */
function hotkeyList(group) {
  return `.claude-plus-settings-dialog [data-name="${group}Hotkeys"]`;
}

/**
 * Checks the default chords: Ctrl+F toggles the in-chat search bar and Ctrl+Shift+F focuses the
 * global search's query field.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkDefaultChords(run) {
  const { page } = run;
  const findBar = page.locator('.claude-plus-panel--focused .claude-plus-find-bar');
  await page.keyboard.press('Control+f');
  run.check('Ctrl+F opens the in-chat search with its field focused', await findBar.isVisible() && await page.evaluate(() => document.activeElement?.dataset.name === 'findInput'));
  await page.keyboard.press('Control+f');
  run.check('Ctrl+F again closes the in-chat search', await findBar.isHidden());
  await page.keyboard.press('Control+Shift+f');
  run.check('Ctrl+Shift+F focuses the global search', await page.evaluate(() => document.activeElement?.dataset.name === 'queryInput'));
  await checkFindButton(run);
}

/**
 * Checks the magnifying glass button in the composer: its tooltip names the hotkey, and clicking it
 * opens and then closes the in-chat search.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkFindButton(run) {
  const findButton = run.composer.locator('[data-name="findButton"]');
  const findBar = run.page.locator('.claude-plus-panel--focused .claude-plus-find-bar');
  run.check('the find button names its hotkey in its tooltip', /\((Ctrl|Cmd)\+F\)$/.test(await findButton.getAttribute('title')), await findButton.getAttribute('title'));
  await findButton.click();
  const isOpen = await findBar.isVisible();
  await findButton.click();
  run.check('the find button opens and closes the in-chat search', isOpen && await findBar.isHidden());
}

/**
 * Opens the settings dialog.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once open.
 */
async function openSettings(run) {
  await run.page.click('[data-name="settingsButton"]');
  await run.page.waitForSelector('.claude-plus-settings-dialog');
}

/**
 * Closes the settings dialog.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once closed.
 */
async function closeSettings(run) {
  await run.page.click('.claude-plus-settings-dialog [data-name="closeButton"]');
}

/**
 * Rebinds "Find in the active chat" to Ctrl+G in the settings and checks the new chord works, the
 * old one no longer does, and a chord another command has is refused.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkRebinding(run) {
  const { page } = run;
  await openSettings(run);
  const row = page.locator(`${hotkeyList('app')} [data-command-id="findInChat"]`);
  run.check('the settings list every app hotkey', await page.locator(`${hotkeyList('app')} [data-command-id]`).count() === 3);
  await row.locator('[data-action="record"]').click();
  await page.keyboard.press('Control+k');
  run.check('a chord another command has is refused', (await page.locator(`${hotkeyList('app')} .claude-plus-settings-dialog__hotkey-message`).textContent()).includes('already used by'));
  await row.locator('[data-action="record"]').click();
  await page.keyboard.press('Control+g');
  run.check('recording shows the new chord', /^(Ctrl|Cmd)\+G$/.test(await row.locator('[data-action="record"]').textContent()));
  await closeSettings(run);
  await checkRebound(run);
}

/**
 * Checks Ctrl+G opens the in-chat search after the rebinding and Ctrl+F does not.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkRebound(run) {
  const { page } = run;
  const findBar = page.locator('.claude-plus-panel--focused .claude-plus-find-bar');
  await page.keyboard.press('Control+f');
  const openedByOldChord = await findBar.isVisible();
  await page.keyboard.press('Control+g');
  run.check('the rebound chord opens the in-chat search, the old one no longer does', await findBar.isVisible() && !openedByOldChord);
  run.check('the find button shows the rebound hotkey', /\((Ctrl|Cmd)\+G\)$/.test(await run.composer.locator('[data-name="findButton"]').getAttribute('title')));
  await page.keyboard.press('Escape');
}

/**
 * Resets the rebinding and checks the Anthropic tab lists its (empty) group.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkResetAndVendorTab(run) {
  const { page } = run;
  await openSettings(run);
  const row = page.locator(`${hotkeyList('app')} [data-command-id="findInChat"]`);
  await row.locator('[data-action="reset"]').click();
  run.check('Reset returns a hotkey to its default chord', /^(Ctrl|Cmd)\+F$/.test(await row.locator('[data-action="record"]').textContent()));
  await page.click('.claude-plus-settings-dialog [data-name="anthropicTabButton"]');
  run.check('the Anthropic tab has a hotkey list of its own', (await page.locator(hotkeyList('anthropic')).textContent()).includes('No Anthropic hotkeys yet'));
  await closeSettings(run);
}

/**
 * Checks the hotkeys: the default chords for the in-chat and global search, rebinding a command in
 * the settings, and the vendor tab's own list.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function hotkeys(run) {
  await checkDefaultChords(run);
  await checkRebinding(run);
  await checkResetAndVendorTab(run);
}

module.exports = { hotkeys };
