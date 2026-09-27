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
 * Checks the chat export import: the drop zone's drag styling, choosing the export's files, the
 * review step and the import step.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function importChatExport(run) {
  const { page } = run;
  const dialog = page.locator('.claude-plus-import-dialog');
  await page.click('[data-name="settingsButton"]');
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
}

module.exports = { importChatExport };
