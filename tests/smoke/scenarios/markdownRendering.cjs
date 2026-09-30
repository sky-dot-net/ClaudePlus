/**
 * Runs in the page: the last message's rendered markdown structure, if it has any.
 * @returns {object} What each block rendered as: the table, the heading, the lists, the rule and
 * the quote.
 */
function readLastMessageMarkdown() {
  const message = [...document.querySelectorAll('.claude-plus-message')].at(-1);
  return { ...readTableMarkdown(message), ...readListMarkdown(message), ...readOtherMarkdown(message) };

  /**
   * The table's header, rows, column alignment and whether a cell's bold rendered.
   * @param {HTMLElement} messageElement The message element.
   * @returns {object} The table's fields.
   */
  function readTableMarkdown(messageElement) {
    const table = messageElement.querySelector('table.claude-plus-md-table');
    const headers = [...table.querySelectorAll('thead th')].map(cell => cell.textContent.trim());
    const rows = [...table.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim()));
    const secondHeader = table.querySelector('thead th:nth-child(2)');
    return { headers, rows, alignRight: secondHeader.style.textAlign === 'right', boldFixed: Boolean(table.querySelector('td b')) };
  }

  /**
   * The unordered list's top-level items and nested sub-list, and the ordered list's items.
   * @param {HTMLElement} messageElement The message element.
   * @returns {object} The lists' fields.
   */
  function readListMarkdown(messageElement) {
    const topItems = [...messageElement.querySelector('ul').children];
    const nestedList = topItems[0].querySelector('ul');
    const nestedItems = nestedList ? [...nestedList.children].map(item => item.textContent.trim()) : [];
    const orderedItems = [...messageElement.querySelectorAll('ol li')].map(item => item.textContent.trim());
    return {
      topItemCount: topItems.length,
      firstItemBold: topItems[0].querySelector(':scope > b')?.textContent ?? '',
      secondItemText: topItems[1].textContent.trim(),
      secondItemHasNestedList: Boolean(topItems[1].querySelector('ul')),
      nestedItems,
      nestedListIsInsideFirstItem: nestedList ? nestedList.parentElement === topItems[0] : false,
      orderedItems,
    };
  }

  /**
   * The heading, horizontal rule and blockquote.
   * @param {HTMLElement} messageElement The message element.
   * @returns {object} These fields.
   */
  function readOtherMarkdown(messageElement) {
    const heading = messageElement.querySelector('h2');
    const quote = messageElement.querySelector('blockquote');
    return { headingText: heading ? heading.textContent.trim() : '', hasRule: Boolean(messageElement.querySelector('hr')), quoteText: quote ? quote.textContent.trim() : '' };
  }
}

/**
 * Checks the table: header, cell text, column alignment and inline bold inside a cell.
 * @param {SmokeRun} run The smoke run.
 * @param {object} markdown The read markdown structure.
 * @returns {void}
 */
function checkTable(run, markdown) {
  run.check('a markdown table renders as a real table with its header', JSON.stringify(markdown.headers) === '["Name","Type"]', JSON.stringify(markdown.headers));
  run.check('a markdown table\'s rows keep their cell text', JSON.stringify(markdown.rows) === '[["Bug","Fixed"],["Note","Fun"]]', JSON.stringify(markdown.rows));
  run.check('a markdown table applies a column\'s alignment from its separator row', markdown.alignRight);
  run.check('a markdown table still renders inline markup (bold) inside a cell', markdown.boldFixed);
}

/**
 * Checks the heading and the horizontal rule.
 * @param {SmokeRun} run The smoke run.
 * @param {object} markdown The read markdown structure.
 * @returns {void}
 */
function checkHeadingAndRule(run, markdown) {
  run.check('an ATX heading (##) renders as a heading element', markdown.headingText === 'Next steps', markdown.headingText);
  run.check('a horizontal rule (---) renders as <hr>, not text', markdown.hasRule);
}

/**
 * Checks the unordered list's top-level items, its nested sub-list, and the ordered list.
 * @param {SmokeRun} run The smoke run.
 * @param {object} markdown The read markdown structure.
 * @returns {void}
 */
function checkLists(run, markdown) {
  const topLevelOk = markdown.topItemCount === 2 && markdown.firstItemBold === 'item' && markdown.secondItemText === 'second item';
  run.check('an unordered list renders as <ul><li> with inline markup inside an item', topLevelOk, JSON.stringify(markdown));
  const nestedOk = markdown.nestedListIsInsideFirstItem && !markdown.secondItemHasNestedList && JSON.stringify(markdown.nestedItems) === '["nested one","nested two"]';
  run.check('an indented sub-item nests as a real <ul> inside its parent <li>, not as a sibling top-level item', nestedOk, JSON.stringify(markdown));
  run.check('an ordered list renders as <ol><li>', JSON.stringify(markdown.orderedItems) === '["one","two"]', JSON.stringify(markdown.orderedItems));
}

/**
 * Checks the blockquote.
 * @param {SmokeRun} run The smoke run.
 * @param {object} markdown The read markdown structure.
 * @returns {void}
 */
function checkQuote(run, markdown) {
  run.check('a blockquote (>) renders as a <blockquote>', markdown.quoteText === 'a quote', markdown.quoteText);
}

/**
 * Checks that the plain text and code fence around the markdown blocks are unaffected.
 * @param {SmokeRun} run The smoke run.
 * @param {import('playwright').Page} page The page.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkSurroundingText(run, page) {
  const bodyText = await page.locator('.claude-plus-message').last().locator('.claude-plus-message__body').innerText();
  const untouched = bodyText.includes('You are welcome') && bodyText.includes('inline fence') && bodyText.includes('Done.');
  run.check('markdown blocks leave the surrounding plain text and code fence untouched', untouched, bodyText);
}

/**
 * Checks that block-level markdown in a reply - a table, a heading, lists (including a nested
 * sub-list), a horizontal rule and a blockquote - renders as real elements instead of literal
 * markdown syntax, that inline markup still works inside them, and that the plain text and code
 * fence around them are untouched.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function markdownRendering(run) {
  const { page } = run;
  const markdown = await page.evaluate(readLastMessageMarkdown);
  checkTable(run, markdown);
  checkHeadingAndRule(run, markdown);
  checkLists(run, markdown);
  checkQuote(run, markdown);
  await checkSurroundingText(run, page);
}

module.exports = { markdownRendering };
