/**
 * Messages in the generated conversation that is long.
 * @type {number}
 */
const HUGE_MESSAGE_COUNT = 4000;

/**
 * Two-message conversations generated alongside it.
 * @type {number}
 */
const FILLER_CONVERSATION_COUNT = 3000;

/**
 * Text a generated message repeats one to seven times, so message heights vary.
 * @type {string}
 */
const PARAGRAPH = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ';

/**
 * The id every conversation's first message replies to.
 * @type {string}
 */
const ROOT_MESSAGE = '00000000-0000-4000-8000-000000000000';

/**
 * One message of a generated conversation, its text numbered and of varying length - every 97th
 * one enormous - so message heights vary widely, as real ones do.
 * @param {string} conversation Conversation id.
 * @param {number} index Position in the conversation.
 * @param {string} parent Id of the message it replies to.
 * @returns {object} The message, as a conversations.json entry.
 */
function generatedMessage(conversation, index, parent) {
  const text = `Message number ${index}: ${PARAGRAPH.repeat(index > 1 && index % 97 === 0 ? 300 : (index % 7) + 1)}`;
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return { uuid: `${conversation}-m${index}`, text, content: [{ type: 'text', text }], sender: index % 2 === 0 ? 'human' : 'assistant', created_at: stamp, updated_at: stamp, attachments: [], files: [], parent_message_uuid: parent };
}

/**
 * A generated data export: one conversation of thousands of messages and thousands of two-message
 * ones, dated an hour apart.
 * @returns {Buffer} The conversations.json content.
 */
function generatedExport() {
  const hugeMessages = Array.from({ length: HUGE_MESSAGE_COUNT }, (unused, index) => generatedMessage('huge', index, index === 0 ? ROOT_MESSAGE : `huge-m${index - 1}`));
  const conversations = [{ uuid: 'huge', name: 'Huge conversation', summary: '', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z', account: { uuid: 'a' }, chat_messages: hugeMessages }];
  for (let index = 0; index < FILLER_CONVERSATION_COUNT; index += 1) {
    const stamp = new Date(Date.UTC(2025, 0, 1) + index * 3600 * 1000).toISOString();
    const messages = [generatedMessage(`c${index}`, 0, ROOT_MESSAGE), generatedMessage(`c${index}`, 1, `c${index}-m0`)];
    conversations.push({ uuid: `c${index}`, name: `Filler conversation ${index}`, summary: '', created_at: stamp, updated_at: stamp, account: { uuid: 'a' }, chat_messages: messages });
  }
  return Buffer.from(JSON.stringify(conversations));
}

/**
 * Imports the generated export through the import dialog.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once imported and the dialogs are closed.
 */
async function importGeneratedExport(run) {
  const { page } = run;
  const dialog = page.locator('.claude-plus-import-dialog');
  await page.click('[data-name="settingsButton"]');
  await page.click('.claude-plus-settings-dialog [data-name="anthropicTabButton"]');
  await page.click('.claude-plus-settings-dialog [data-name="importChatExportButton"]');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dialog.locator('[data-name="chooseButton"]').click()]);
  await chooser.setFiles({ name: 'conversations.json', mimeType: 'application/json', buffer: generatedExport() });
  await dialog.locator('tbody tr[data-conversation-id]').first().waitFor({ timeout: 120000 });
  await dialog.locator('[data-name="importButton"]').click();
  await dialog.getByText('Import complete.').waitFor({ timeout: 300000 });
  await dialog.locator('[data-name="closeButton"]').click();
  await page.click('.claude-plus-settings-dialog [data-name="closeButton"]');
  await page.waitForTimeout(500);
}

/**
 * Runs in the page: scrolls the Chats table's scroller and reports what is rendered.
 * @param {?number} scrollTop Position to scroll to, or null to only look; Infinity for the very end.
 * @returns {Promise<{rendered: number, first: string, last: string}>} How many rows exist and the first and last one's title.
 */
async function scrollChatsTable(scrollTop) {
  const scroller = document.querySelector('[data-name="searchInput"]').closest('.claude-plus-panel').querySelector('[data-name="scroller"]');
  for (let pass = 0; pass < 4 && scrollTop !== null; pass += 1) {
    scroller.scrollTop = scrollTop === Infinity ? scroller.scrollHeight : scrollTop;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const titles = [...scroller.querySelectorAll('tbody tr.claude-plus-conversation .claude-plus-conversation__title')].map(title => title.textContent);
  return { rendered: titles.length, first: titles[0], last: titles[titles.length - 1] };
}

/**
 * Runs in the page: scrolls the message list and reports which messages are rendered.
 * @param {?number} scrollTop Position to scroll to, or null to only look; a fraction below 1 of the scroll height when negative.
 * @returns {Promise<{rendered: number, first: number, last: number}>} How many messages exist and the numbers of the first and last one.
 */
async function scrollMessageList(scrollTop) {
  const list = document.querySelector('.claude-plus-message-list');
  if (scrollTop !== null) {
    list.scrollTop = scrollTop < 0 ? list.scrollHeight * -scrollTop : scrollTop;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  const numbers = [...list.querySelectorAll('.claude-plus-message')].map(message => Number((message.textContent.match(/Message number (\d+)/) ?? [])[1]));
  return { rendered: numbers.length, first: numbers[0], last: numbers[numbers.length - 1] };
}

/**
 * Checks that a table of thousands of rows only renders the rows near the visible area, and that
 * scrolling to the end and the middle renders the right ones.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkTableWindowing(run) {
  const { page } = run;
  const initial = await page.evaluate(scrollChatsTable, null);
  run.check('a table of thousands of rows renders only a window of them', initial.rendered > 0 && initial.rendered < 150, JSON.stringify(initial));
  const bottom = await page.evaluate(scrollChatsTable, Infinity);
  run.check('scrolling a long table to its end renders its last row', bottom.last === 'Filler conversation 0' && bottom.rendered < 150, JSON.stringify(bottom));
  const middle = await page.evaluate(scrollChatsTable, 40000);
  run.check('scrolling a long table into the middle renders rows from there', middle.rendered < 150 && !middle.first.includes('Research') && middle.first !== bottom.first, JSON.stringify(middle));
  await page.evaluate(scrollChatsTable, 0);
}

/**
 * Finds the long conversation in the Chats table and opens it, waiting for its last message.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once its last message is shown.
 */
async function openHugeConversation(run) {
  await run.chatsPanel.locator('[data-filter-column="name"]').fill('Huge conversation');
  await run.page.waitForTimeout(300);
  await run.chatsPanel.locator('tbody tr.claude-plus-conversation').first().click();
  await run.page.waitForFunction(() => document.querySelector('.claude-plus-message-list')?.textContent.includes('Message number 3999'), null, { timeout: 60000 });
}

/**
 * Checks that a conversation of thousands of messages opens at its end and scrolls to its start,
 * rendering only a window of messages each time.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkMessageWindowEnds(run) {
  const { page } = run;
  await openHugeConversation(run);
  const atEnd = await page.evaluate(scrollMessageList, null);
  run.check('a long conversation opens at its end with only a window of messages rendered', atEnd.last === HUGE_MESSAGE_COUNT - 1 && atEnd.rendered < 100, JSON.stringify(atEnd));
  const atStart = await page.evaluate(scrollMessageList, 0);
  run.check('scrolling a long conversation to its start renders its first messages', atStart.first === 0 && atStart.rendered < 100, JSON.stringify(atStart));
}

/**
 * Checks that scrolling a long conversation into its middle, then up from there, renders the right
 * messages without a gap.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkMessageWindowMiddle(run) {
  const { page } = run;
  const inMiddle = await page.evaluate(scrollMessageList, -0.5);
  run.check('scrolling a long conversation into the middle renders messages from there', inMiddle.first > 500 && inMiddle.last < 3500 && inMiddle.rendered < 100, JSON.stringify(inMiddle));
  const scrolledUp = await page.evaluate(scrollMessageList, await page.evaluate(() => document.querySelector('.claude-plus-message-list').scrollTop - 900));
  run.check('scrolling up from the middle renders earlier messages without a gap', scrolledUp.last >= inMiddle.first - 2 && scrolledUp.first < inMiddle.first, JSON.stringify({ inMiddle, scrolledUp }));
}

/**
 * Runs in the page: the in-chat search's position label and how many ranges it has painted.
 * @returns {{label: string, marked: number, current: number}} The label and the painted matches and current matches.
 */
function readFindState() {
  const label = document.querySelector('.claude-plus-panel--focused [data-name="countLabel"]').textContent;
  return { label, marked: CSS.highlights.get('claude-plus-find')?.size ?? 0, current: CSS.highlights.get('claude-plus-find-current')?.size ?? 0 };
}

/**
 * Types into the in-chat search field and waits for the result to be shown.
 * @param {SmokeRun} run The smoke run.
 * @param {string} text The text to search for.
 * @param {number} matchCount How many matches the finished search shows.
 * @returns {Promise<{label: string, marked: number, current: number}>} The state once shown.
 */
async function findInChat(run, text, matchCount) {
  const input = run.page.locator('.claude-plus-panel--focused [data-name="findInput"]');
  await input.fill(text);
  await run.page.waitForFunction(total => document.querySelector('.claude-plus-panel--focused [data-name="countLabel"]').textContent.endsWith(`/${total}`), matchCount, { timeout: 30000 });
  return run.page.evaluate(readFindState);
}

/**
 * Checks the in-chat search, started from the top of a long chat, lands on a message in its
 * middle, however far off the estimated heights above it are.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkFindInMiddle(run) {
  await run.page.evaluate(scrollMessageList, 0);
  await findInChat(run, 'number 2000:', 1);
  await run.page.waitForTimeout(300);
  const state = await run.page.evaluate(readFindState);
  const middle = await run.page.evaluate(scrollMessageList, null);
  run.check('in-chat search lands on a message in the middle of a long chat, whatever the estimated heights', state.current === 1 && middle.first <= 2000 && middle.last >= 2000, JSON.stringify({ state, middle }));
}

/**
 * Checks the in-chat search finds a message a windowed list has not rendered, scrolls to it and
 * marks the match, and that * works as a wildcard.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkFindAcrossWindow(run) {
  const { page } = run;
  await page.evaluate(scrollMessageList, 0);
  await page.keyboard.press('Control+f');
  const state = await findInChat(run, 'number 3999:', 1);
  await page.waitForTimeout(300);
  const rendered = await page.evaluate(scrollMessageList, null);
  run.check('in-chat search finds a message that is not rendered, scrolls to it and marks it', state.current === 1 && rendered.first <= 3999 && rendered.last >= 3999, JSON.stringify({ state, rendered }));
  await checkFindInMiddle(run);
  const wildcard = await findInChat(run, 'number 399*:', 11);
  run.check('in-chat search accepts * as a wildcard', wildcard.label.endsWith('/11') && wildcard.current === 1, JSON.stringify(wildcard));
}

/**
 * Checks the regular-expression checkbox, its per-chat memory, and the first, previous, next and
 * last buttons with wrap-around.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkFindRegexAndButtons(run) {
  const { page } = run;
  const bar = page.locator('.claude-plus-panel--focused .claude-plus-find-bar');
  await bar.locator('[data-name="regexCheckbox"]').check();
  await findInChat(run, 'number 39(8|9)9:', 2);
  const stored = await page.evaluate(() => localStorage.getItem('claudePlus.conversationSettings'));
  run.check('the regex checkbox is remembered for the chat', stored.includes('"findIsRegex":true'), stored);
  const labels = [];
  for (const button of ['lastButton', 'firstButton', 'nextButton', 'nextButton', 'previousButton']) {
    await bar.locator(`[data-name="${button}"]`).click();
    labels.push(await bar.locator('[data-name="countLabel"]').textContent());
  }
  run.check('last, first, next, next (wrapping) and previous move through the matches', labels.join(' ') === '2/2 1/2 2/2 1/2 2/2', labels.join(' '));
  await bar.locator('[data-name="findInput"]').press('Escape');
  const cleared = await page.evaluate(readFindState);
  run.check('closing the in-chat search removes its marks', await bar.isHidden() && cleared.marked === 0, JSON.stringify(cleared));
}

/**
 * Runs in the page: narrows the message list step by step faster than the list's settle time and
 * counts how often its rendered messages were replaced during that and after it had settled.
 * @returns {Promise<{during: number, after: number}>} Replacements while the width was changing and once it stopped.
 */
async function narrowMessageListAndCountRerenders() {
  const list = document.querySelector('.claude-plus-message-list');
  let replacements = 0;
  const observer = new MutationObserver(records => { replacements += records.length; });
  observer.observe(list, { childList: true });
  const baseWidth = list.clientWidth;
  for (let step = 1; step <= 10; step += 1) {
    list.style.maxWidth = `${baseWidth - step * 10}px`;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  const during = replacements;
  await new Promise(resolve => setTimeout(resolve, 700));
  observer.disconnect();
  list.style.maxWidth = '';
  return { during, after: replacements - during };
}

/**
 * Checks that resizing a list re-renders it once the width stops changing, not while it changes.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkResizeWaitsForSettle(run) {
  const counts = await run.page.evaluate(narrowMessageListAndCountRerenders);
  run.check('resizing a list does not re-render while its width is still changing', counts.during === 0, JSON.stringify(counts));
}

/**
 * Imports thousands of conversations, one of them thousands of messages long, and checks the
 * Chats table and the message list only ever render the part near the visible area.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function virtualScrolling(run) {
  await importGeneratedExport(run);
  await checkTableWindowing(run);
  await checkMessageWindowEnds(run);
  await checkMessageWindowMiddle(run);
  await checkFindAcrossWindow(run);
  await checkFindRegexAndButtons(run);
  await checkResizeWaitsForSettle(run);
}

module.exports = { virtualScrolling };
