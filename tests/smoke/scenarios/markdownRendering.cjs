/**
 * Runs in the page: the last message's rendered markdown structure, if it has any.
 * @returns {object} What each block rendered as: the table, the heading, the lists, the rule and
 * the quote.
 */
function readLastMessageMarkdown() {
  const message = [...document.querySelectorAll('.claude-plus-message')].at(-1);
  const table = message.querySelector('table.claude-plus-md-table');
  const headers = [...table.querySelectorAll('thead th')].map(cell => cell.textContent.trim());
  const rows = [...table.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim()));
  const secondHeader = table.querySelector('thead th:nth-child(2)');
  const heading = message.querySelector('h2');
  const unorderedItems = [...message.querySelectorAll('ul li')].map(item => item.innerHTML);
  const orderedItems = [...message.querySelectorAll('ol li')].map(item => item.textContent.trim());
  const quote = message.querySelector('blockquote');
  return {
    headers, rows, alignRight: secondHeader.style.textAlign === 'right', boldFixed: Boolean(table.querySelector('td b')),
    headingText: heading?.textContent.trim(), unorderedItems, orderedItems, hasRule: Boolean(message.querySelector('hr')),
    quoteText: quote?.textContent.trim(),
  };
}

/**
 * Checks that block-level markdown in a reply - a table, a heading, lists, a horizontal rule and a
 * blockquote - renders as real elements instead of literal markdown syntax, that inline markup
 * still works inside them, and that the plain text and code fence around them are untouched.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function markdownRendering(run) {
  const { page } = run;
  const markdown = await page.evaluate(readLastMessageMarkdown);
  run.check('a markdown table renders as a real table with its header', JSON.stringify(markdown.headers) === '["Name","Type"]', JSON.stringify(markdown.headers));
  run.check('a markdown table\'s rows keep their cell text', JSON.stringify(markdown.rows) === '[["Bug","Fixed"],["Note","Fun"]]', JSON.stringify(markdown.rows));
  run.check('a markdown table applies a column\'s alignment from its separator row', markdown.alignRight);
  run.check('a markdown table still renders inline markup (bold) inside a cell', markdown.boldFixed);
  run.check('an ATX heading (##) renders as a heading element', markdown.headingText === 'Next steps', markdown.headingText);
  run.check('an unordered list renders as <ul><li> with inline markup inside an item', JSON.stringify(markdown.unorderedItems) === '["first <b>item</b>","second item"]', JSON.stringify(markdown.unorderedItems));
  run.check('an ordered list renders as <ol><li>', JSON.stringify(markdown.orderedItems) === '["one","two"]', JSON.stringify(markdown.orderedItems));
  run.check('a horizontal rule (---) renders as <hr>, not text', markdown.hasRule);
  run.check('a blockquote (>) renders as a <blockquote>', markdown.quoteText === 'a quote', markdown.quoteText);
  const bodyText = await page.locator('.claude-plus-message').last().locator('.claude-plus-message__body').innerText();
  run.check('markdown blocks leave the surrounding plain text and code fence untouched', bodyText.includes('You are welcome') && bodyText.includes('inline fence') && bodyText.includes('Done.'), bodyText);
}

module.exports = { markdownRendering };
