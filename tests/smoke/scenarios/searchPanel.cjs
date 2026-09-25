/**
 * Checks the Search panel's qualifiers (file:, outlet:, tool:, chat: with a quoted value, after:)
 * and a free term with its match reason.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function searchPanel(run) {
  await run.openTab('Search');
  const panel = run.panelWith('queryInput');
  const search = async query => {
    await panel.locator('[data-name="queryInput"]').fill(query);
    await run.page.waitForTimeout(60);
    return panel.locator('tbody tr.claude-plus-search-result').evaluateAll(resultRowTexts);
  };
  await checkKindQualifiers(run, search);
  const chats = await search('chat:"second chat"');
  const future = await search('after:2999-01-01 research');
  const freeTerm = await search('report');
  run.check('search chat: qualifier with quoted value', chats.length === 1 && chats[0].startsWith('Second chat | Chat'), JSON.stringify(chats));
  run.check('search after: date qualifier', future.length === 0);
  run.check('search free term with reason', freeTerm.length === 1 && freeTerm[0].includes('"report" in file'), JSON.stringify(freeTerm));
}

/**
 * Checks the file:, outlet: and tool: qualifiers.
 * @param {SmokeRun} run The smoke run.
 * @param {function(string): Promise<string[]>} search Runs a query and returns the result rows' texts.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkKindQualifiers(run, search) {
  const pdfFiles = await search('file:*.pdf');
  const outlets = await search('outlet:*EXAMPLE*');
  const tools = await search('tool:web_search');
  run.check('search file: qualifier', pdfFiles.length === 1 && pdfFiles[0].startsWith('notes.pdf | File'), JSON.stringify(pdfFiles));
  run.check('search outlet: qualifier (wildcard, case-insensitive)', outlets.length === 1 && outlets[0].includes('Source'), JSON.stringify(outlets));
  run.check('search tool: qualifier', tools.length === 1 && tools[0].startsWith('web_search | Tool'), JSON.stringify(tools));
}

/**
 * Runs in the page: the text of each result row, its cells joined by " | ".
 * @param {HTMLTableRowElement[]} rows The result rows.
 * @returns {string[]} One text per row.
 */
function resultRowTexts(rows) {
  return rows.map(row => [...row.cells].map(cell => cell.textContent).join(' | '));
}

module.exports = { searchPanel };
