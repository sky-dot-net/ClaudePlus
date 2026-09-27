const path = require('node:path');

/**
 * Folder of the real claude.ai export used as import input: two conversations, one memory file,
 * the account profile and its login history.
 * @type {string}
 */
const EXPORT_FOLDER = path.resolve('data/export test 27_09_2026/with memory');

/**
 * Files of that export, as the user would select them after unzipping.
 * @type {string[]}
 */
const EXPORT_FILES = [
  'conversations-000/conversations.json',
  'memories-000/memories/db2b49f9-72ce-4240-af85-d26de1a5ac1c.json',
  'light_metadata-000/users.json',
  'light_metadata-000/login_history.json',
].map(file => path.join(EXPORT_FOLDER, file));

/**
 * Checks the review step once the export's files are chosen: the found summary, the category
 * toggles, the default selection and the select all / none buttons.
 * @param {SmokeRun} run The smoke run.
 * @param {import('playwright').Locator} dialog The import dialog.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkReview(run, dialog) {
  const importButton = dialog.locator('[data-name="importButton"]');
  const summary = await dialog.locator('[data-name="status"]').textContent();
  run.check('import summary counts every category', summary.includes('2 conversation(s)') && summary.includes('memory file(s)') && summary.includes('login event(s)'), summary);
  run.check('import shows one toggle per optional category found', await dialog.locator('[data-category-toggle]').count() === 2);
  run.check('import review preselects new conversations', await importButton.textContent() === 'Import selected (2)', await importButton.textContent());
  await dialog.locator('[data-name="selectNoneButton"]').click();
  const noneLabel = await importButton.textContent();
  await dialog.locator('[data-name="selectAllButton"]').click();
  run.check('import select none / all update the selection', noneLabel === 'Import selected (0)' && await importButton.textContent() === 'Import selected (2)', noneLabel);
}

/**
 * Checks the import step: an unchecked toggle excludes its category and the result summary
 * reports what was saved.
 * @param {SmokeRun} run The smoke run.
 * @param {import('playwright').Locator} dialog The import dialog.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkImport(run, dialog) {
  await dialog.locator('[data-category-toggle="memoryFiles"]').uncheck();
  await dialog.locator('[data-name="importButton"]').click();
  await dialog.getByText('Import complete.').waitFor();
  const result = await dialog.locator('[data-name="status"]').textContent();
  run.check('import saves the selection and skips an unchecked category', result.includes('2 brand-new conversation(s) saved') && result.includes('0 of 0 memory file(s) saved') && result.includes('Account profile saved'), result);
}

/**
 * Id of "Your first chat with Claude", the imported conversation with a tool call
 * (chart_display_v0) used to check read-only behavior and message-level search.
 * @type {string}
 */
const IMPORTED_CONVERSATION_ID = '4759f4a1-d669-49a4-aafa-d0bb0d55ff63';

/**
 * Checks that an imported conversation is tagged in the Chats table, that opening it disables
 * only the composer's send box and choosers (not the whole toolbar) and hides edit/retry buttons,
 * and that a search result tied to one of its messages scrolls to and highlights that message.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkImportedConversationBehavior(run) {
  const { page } = run;
  const row = run.chatsPanel.locator(`tr[data-conversation-id="${IMPORTED_CONVERSATION_ID}"]`);
  const origin = await row.locator('td').nth(1).textContent();
  run.check('imported conversation is tagged Imported in the Chats table', origin === 'Imported', origin);
  await row.click();
  await page.waitForTimeout(150);
  const composer = run.composer;
  const isSendBoxHiddenAndDisabled = await composer.locator('[data-name="promptInput"]').isHidden()
    && await composer.locator('[data-name="readonlyNotice"]').isVisible()
    && await composer.locator('[data-name="modelSelect"]').isDisabled();
  run.check('imported chat composer disables the send box and choosers, keeps the rest', isSendBoxHiddenAndDisabled);
  run.check('imported chat has no edit or retry buttons', await page.locator('[data-action="startEdit"], [data-action="retry"]').count() === 0);
  await run.openTab('Search');
  const searchPanel = run.panelWith('queryInput');
  await searchPanel.locator('[data-name="queryInput"]').fill('tool:chart_display_v0');
  await page.waitForTimeout(60);
  const toolResults = searchPanel.locator('tbody tr.claude-plus-search-result');
  run.check('imported conversation tool call is searchable', await toolResults.count() === 1, String(await toolResults.count()));
  await toolResults.click();
  await page.waitForTimeout(300);
  run.check('clicking a message-specific search result scrolls to and highlights it', await page.locator('.claude-plus-message--highlighted').count() === 1);
  await checkStatsViewToggle(run);
}

/**
 * Checks that the Stats panel's Combined/Live/Imported toggle actually partitions the indexed
 * conversations, rather than just relabeling the same combined total three times.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkStatsViewToggle(run) {
  const { page } = run;
  await run.openTab('Stats');
  const statsPanel = run.panelWith('viewToggle');
  const countFor = async view => {
    await statsPanel.locator(`[data-view="${view}"]`).click();
    await page.waitForTimeout(60);
    return Number(await statsPanel.locator('[data-name="indexedConversationCount"]').textContent());
  };
  const combinedCount = await countFor('combined');
  const liveCount = await countFor('live');
  const importedCount = await countFor('imported');
  const partitionsCleanly = importedCount === 2 && liveCount + importedCount === combinedCount && importedCount < combinedCount;
  run.check('stats view toggle partitions Combined into Live and Imported', partitionsCleanly, JSON.stringify({ combinedCount, liveCount, importedCount }));
}

/**
 * Checks the chat export import: the drop zone's drag styling, choosing the export's files, the
 * review step, the import step, and how the newly imported data behaves once in the app.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function importChatExport(run) {
  const { page } = run;
  const dialog = page.locator('.claude-plus-import-dialog');
  await page.click('[data-name="settingsButton"]');
  const settingsDialog = page.locator('.claude-plus-settings-dialog');
  await page.click('.claude-plus-settings-dialog [data-name="anthropicTabButton"]');
  run.check('Anthropic settings tab shows its pane and hides the App pane', await settingsDialog.locator('[data-name="anthropicPane"]').isVisible() && await settingsDialog.locator('[data-name="appPane"]').isHidden());
  await page.click('.claude-plus-settings-dialog [data-name="importChatExportButton"]');
  await dialog.locator('[data-name="dropZone"]').dispatchEvent('dragenter');
  run.check('import drop zone highlights while dragging', await dialog.locator('.claude-plus-import-dialog__drop-zone--active').count() === 1);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dialog.locator('[data-name="chooseButton"]').click()]);
  await chooser.setFiles(EXPORT_FILES);
  await dialog.locator('tbody tr[data-conversation-id]').first().waitFor();
  await checkReview(run, dialog);
  await checkImport(run, dialog);
  await dialog.locator('[data-name="closeButton"]').click();
  await page.click('.claude-plus-settings-dialog [data-name="closeButton"]');
  await checkImportedConversationBehavior(run);
}

module.exports = { importChatExport };
