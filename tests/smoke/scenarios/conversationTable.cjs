/**
 * Checks the Chats list as a column table: default columns, toggling a column, sorting both ways,
 * the wildcard typeahead filter, the date range filter, dragging a column narrower or wider, and
 * that column visibility, sort order and resized widths all persist across a reload.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function conversationTable(run) {
  await checkColumnsAndSorting(run);
  await checkFilters(run);
  const widthAfterDrag = await checkColumnResize(run);
  await run.reload();
  const headers = await run.chatsPanel.locator('thead tr:first-child th').allTextContents();
  run.check('column visibility and sort persist', await run.chatsPanel.locator('[data-column-toggle="turns"]').isChecked() && headers.includes('Name ▼'), JSON.stringify(headers));
  const widthAfterReload = await columnWidth(run, 'name');
  run.check('resized column width persists across reload', Math.abs(widthAfterReload - widthAfterDrag) < 5, `${widthAfterDrag} vs ${widthAfterReload}`);
}

/**
 * The rendered width of a column's header.
 * @param {SmokeRun} run The smoke run.
 * @param {string} columnId Column id.
 * @returns {Promise<number>} The width in pixels.
 */
async function columnWidth(run, columnId) {
  const box = await run.chatsPanel.locator(`th[data-sort-column="${columnId}"]`).boundingBox();
  return box.width;
}

/**
 * Drags the Name column's resize handle 80px to the right and checks the header actually widened;
 * the check only requires real, substantial growth rather than exactly 80px, since the panel's own
 * width caps how much a flexible (auto-filling) column can grow in this narrow test viewport.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<number>} The width after dragging, for the caller to compare after a reload.
 */
async function checkColumnResize(run) {
  const { page } = run;
  const widthBefore = await columnWidth(run, 'name');
  const handleBox = await run.chatsPanel.locator('[data-resize-handle="name"]').boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 80, handleBox.y + handleBox.height / 2, { steps: 5 });
  await page.mouse.up();
  const widthAfter = await columnWidth(run, 'name');
  run.check('dragging a column\'s resize handle widens it', widthAfter > widthBefore + 15, `${widthBefore} -> ${widthAfter}`);
  return widthAfter;
}

/**
 * Checks the rows, the default columns, toggling the Turns column and sorting by name both ways.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkColumnsAndSorting(run) {
  const chatRows = () => run.chatsPanel.locator('tbody tr.claude-plus-conversation');
  const headers = () => run.chatsPanel.locator('thead tr:first-child th').allTextContents();
  run.check('Chats table lists conversations', await chatRows().count() === 2);
  run.check('Chats table default columns: Name, Origin, Date (+ buttons)', JSON.stringify(await headers()) === JSON.stringify(['Name', 'Origin', 'Date ▼', '']), JSON.stringify(await headers()));
  await run.chatsPanel.locator('summary', { hasText: 'Columns' }).click();
  await run.chatsPanel.locator('[data-column-toggle="turns"]').check();
  await run.page.waitForTimeout(50);
  const turnCells = await run.chatsPanel.locator('.claude-plus-column-table__cell--turns').allTextContents();
  run.check('toggling the Turns column shows indexed counts', turnCells.includes('2') && turnCells.includes('–'), JSON.stringify(turnCells));
  await run.chatsPanel.locator('th[data-sort-column="name"]').click();
  const namesAscending = await run.chatsPanel.locator('.claude-plus-conversation__title').allTextContents();
  await run.chatsPanel.locator('th[data-sort-column="name"]').click();
  const namesDescending = await run.chatsPanel.locator('.claude-plus-conversation__title').allTextContents();
  run.check('clicking a header sorts, clicking again reverses', namesAscending[0].startsWith('Research') && namesDescending[0] === 'Second chat', `${namesAscending} / ${namesDescending}`);
}

/**
 * Checks the name typeahead with wildcards and the date range filter, clearing both afterwards.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkFilters(run) {
  const { page } = run;
  const chatRows = () => run.chatsPanel.locator('tbody tr.claude-plus-conversation');
  const nameFilter = run.chatsPanel.locator('[data-filter-column="name"]');
  await nameFilter.click();
  const offered = await page.$$eval('.claude-plus-value-combobox__entry', entries => entries.map(entry => entry.textContent));
  await nameFilter.fill('*SECOND*');
  await page.waitForTimeout(50);
  const narrowed = await page.$$eval('.claude-plus-value-combobox__entry', entries => entries.map(entry => entry.textContent));
  run.check('typeahead lists distinct values and narrows with * wildcards, case-insensitive', offered.length === 2 && narrowed.length === 1 && await chatRows().count() === 1, `${offered} -> ${narrowed}`);
  await nameFilter.fill('');
  const dateFrom = run.chatsPanel.locator('[data-filter-column="date"][data-filter-bound="from"]');
  await dateFrom.fill('2999-01-01');
  await page.waitForTimeout(50);
  run.check('date range filter', await chatRows().count() === 0);
  await dateFrom.fill('');
  await page.keyboard.press('Escape');
}

module.exports = { conversationTable };
