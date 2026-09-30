/**
 * Runs in the page: the last message's rendered table, if it has one.
 * @returns {{rows: string[][], headers: string[], alignRight: boolean, boldFixed: boolean}} The
 * table's header and body cell texts, whether its second column is right-aligned, and whether
 * "Fixed" rendered bold.
 */
function readLastMessageTable() {
  const message = [...document.querySelectorAll('.claude-plus-message')].at(-1);
  const table = message.querySelector('table.claude-plus-md-table');
  const headers = [...table.querySelectorAll('thead th')].map(cell => cell.textContent.trim());
  const rows = [...table.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim()));
  const secondHeader = table.querySelector('thead th:nth-child(2)');
  return { headers, rows, alignRight: secondHeader.style.textAlign === 'right', boldFixed: Boolean(table.querySelector('td b')) };
}

/**
 * Checks that a GFM table in a reply renders as a real table - not as literal pipe characters -
 * with its header, alignment and inline markup intact, and that the plain text around it still
 * renders as before.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function markdownRendering(run) {
  const { page } = run;
  const table = await page.evaluate(readLastMessageTable);
  run.check('a markdown table renders as a real table with its header', JSON.stringify(table.headers) === '["Name","Type"]', JSON.stringify(table.headers));
  run.check('a markdown table\'s rows keep their cell text', JSON.stringify(table.rows) === '[["Bug","Fixed"],["Note","Fun"]]', JSON.stringify(table.rows));
  run.check('a markdown table applies a column\'s alignment from its separator row', table.alignRight);
  run.check('a markdown table still renders inline markup (bold) inside a cell', table.boldFixed);
  const bodyText = await page.locator('.claude-plus-message').last().locator('.claude-plus-message__body').innerText();
  run.check('a markdown table leaves the surrounding plain text and code fence untouched', bodyText.includes('You are welcome') && bodyText.includes('inline fence') && bodyText.includes('Done.'), bodyText);
}

module.exports = { markdownRendering };
