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
  await checkImportedIndexRebuilt(run);
  await checkQuoteFilesStayHidden(run);
  await checkRecordsWithoutDates(run);
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
  const background = view => statsPanel.locator(`[data-view="${view}"]`).evaluate(button => getComputedStyle(button).backgroundColor);
  run.check('the selected stats view button is colored differently from the others', await background('imported') !== await background('live'), `${await background('imported')} vs ${await background('live')}`);
}

/**
 * Runs in the page: removes every imported conversation's summary from the stats cache, as if an
 * import had been interrupted before indexing them.
 * @returns {Promise<number>} How many summaries were removed.
 */
async function removeImportedSummaries() {
  const database = await new Promise(resolve => { const request = indexedDB.open('claudePlus'); request.onsuccess = () => resolve(request.result); });
  const transaction = database.transaction('conversationSummaries', 'readwrite');
  const store = transaction.objectStore('conversationSummaries');
  const summaries = await new Promise(resolve => { const request = store.getAll(); request.onsuccess = () => resolve(request.result); });
  const imported = summaries.filter(summary => summary.isImported);
  imported.forEach(summary => store.delete(summary.conversationId));
  await new Promise(resolve => { transaction.oncomplete = resolve; });
  database.close();
  return imported.length;
}

/**
 * Runs in the page: strips the date from an imported conversation's record and removes its
 * summary, as a record stored by an older version looks.
 * @param {string} conversationId Id of the conversation.
 * @returns {Promise<void>} Resolves once stored.
 */
async function storeRecordWithoutDate(conversationId) {
  const database = await new Promise(resolve => { const request = indexedDB.open('claudePlus'); request.onsuccess = () => resolve(request.result); });
  const transaction = database.transaction(['importedConversations', 'conversationSummaries'], 'readwrite');
  const records = transaction.objectStore('importedConversations');
  const record = await new Promise(resolve => { const request = records.get(conversationId); request.onsuccess = () => resolve(request.result); });
  delete record.updatedAt;
  records.put(record);
  transaction.objectStore('conversationSummaries').delete(conversationId);
  await new Promise(resolve => { transaction.oncomplete = resolve; });
  database.close();
}

/**
 * Checks that a stored imported conversation without a date still shows a date and is indexed.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkRecordsWithoutDates(run) {
  await run.page.evaluate(storeRecordWithoutDate, IMPORTED_CONVERSATION_ID);
  await run.reload();
  await run.page.waitForTimeout(500);
  const row = run.chatsPanel.locator(`tr[data-conversation-id="${IMPORTED_CONVERSATION_ID}"]`);
  const rowText = await row.textContent();
  const summaryCount = await run.page.evaluate(async conversationId => {
    const database = await new Promise(resolve => { const request = indexedDB.open('claudePlus'); request.onsuccess = () => resolve(request.result); });
    const summary = await new Promise(resolve => { const request = database.transaction('conversationSummaries').objectStore('conversationSummaries').get(conversationId); request.onsuccess = () => resolve(request.result); });
    database.close();
    return summary ? 1 : 0;
  }, IMPORTED_CONVERSATION_ID);
  run.check('an imported conversation stored without a date shows a date and is indexed', /\d{2}\/\d{2}\/\d{4}/.test(rowText) && summaryCount === 1, `${rowText} / ${summaryCount}`);
}

/**
 * Runs in the page: stores a summary, as an older version might have stored it, that lists
 * claude.ai's quote-reply text file as a file of the conversation.
 * @returns {Promise<void>} Resolves once stored.
 */
async function storeSummaryWithQuoteFile() {
  const database = await new Promise(resolve => { const request = indexedDB.open('claudePlus'); request.onsuccess = () => resolve(request.result); });
  const transaction = database.transaction('conversationSummaries', 'readwrite');
  const file = { path: 'excerpt_from_previous_claude_message.txt', title: 'excerpt_from_previous_claude_message.txt', timestamp: '2026-01-01T00:00:00Z', source: 'user', messageId: 'm1' };
  transaction.objectStore('conversationSummaries').put({ conversationId: 'old-summary', title: 'Old summary', updatedAt: '2026-01-01T00:00:00Z', version: 2, isImported: false, promptCount: 1, toolCallCounts: {}, toolCalls: [], sources: [], files: [file], estimatedTokensIn: 1, estimatedTokensOut: 1, responseTimesMs: [] });
  await new Promise(resolve => { transaction.oncomplete = resolve; });
  database.close();
}

/**
 * Checks that a stored summary listing the quote-reply text file never shows it in the global search.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkQuoteFilesStayHidden(run) {
  await run.page.evaluate(storeSummaryWithQuoteFile);
  await run.reload();
  await run.openTab('Search');
  const searchPanel = run.panelWith('queryInput');
  await searchPanel.locator('[data-name="queryInput"]').fill('excerpt_from_previous');
  await run.page.waitForTimeout(150);
  run.check('quote-reply text files never appear in the global search', await searchPanel.locator('tbody tr.claude-plus-search-result').count() === 0);
}

/**
 * Checks that imported conversations left without statistics are indexed again when the app starts.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkImportedIndexRebuilt(run) {
  const { page } = run;
  const removedCount = await page.evaluate(removeImportedSummaries);
  await run.reload();
  await run.openTab('Stats');
  const statsPanel = run.panelWith('viewToggle');
  await statsPanel.locator('[data-view="imported"]').click();
  const importedCount = () => statsPanel.locator('[data-name="indexedConversationCount"]').textContent().then(Number);
  await page.waitForFunction(() => document.querySelector('[data-name="indexedConversationCount"]')?.textContent === '2', null, { timeout: 5000 }).catch(() => undefined);
  run.check('imported conversations without statistics are indexed again at startup', removedCount === 2 && await importedCount() === 2, JSON.stringify({ removedCount, importedCount: await importedCount() }));
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
