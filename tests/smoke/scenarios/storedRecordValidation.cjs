const { FIXTURE_IDS } = require('../FIXTURE_IDS.cjs');

/**
 * Stores a malformed conversation summary before the first start, boots the script and checks
 * the initial UI: the native app hidden, the default layout, the current branch only, no send
 * button, and the malformed record skipped with a hint while the valid one is counted.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function storedRecordValidation(run) {
  const { page } = run;
  await page.goto('https://claude.ai/new');
  await page.evaluate(storeMalformedSummary);
  await run.boot(`https://claude.ai/chat/${FIXTURE_IDS.researchChat}`);
  run.check('native app hidden', await page.$eval('#root', root => getComputedStyle(root).display) === 'none');
  run.check('default layout: chats | chat over composer | extras', (await page.$$('.claude-plus-tab-strip')).length === 4 && await page.locator('.claude-plus-tab', { hasText: 'Message' }).count() === 1);
  run.check('chat pane shows current branch only', (await page.$$('.claude-plus-message')).length === 4);
  run.check('composer has no send button', await page.$$eval('.claude-plus-composer__send-button', buttons => buttons.length) === 0 && await page.$eval('[data-name="stopButton"]', button => button.hidden));
  await run.openTab('Stats');
  const staleHint = await page.$eval('[data-name="staleRecordHint"]', hint => ({ hidden: hint.hidden, text: hint.textContent }));
  run.check('malformed stored record skipped with a hint', !staleHint.hidden && staleHint.text.startsWith('1 stored'), JSON.stringify(staleHint));
  run.check('valid stored record still counted', await page.$eval('[data-name="indexedConversationCount"]', count => count.textContent) === '1');
}

/**
 * Runs in the page: creates the ClaudePlus database and stores a summary with a wrong title type.
 * @returns {Promise<void>} Resolves once stored.
 */
function storeMalformedSummary() {
  return new Promise(resolve => {
    const request = indexedDB.open('claudePlus', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('conversationSummaries', { keyPath: 'conversationId' });
      request.result.createObjectStore('activity', { keyPath: 'day' });
    };
    request.onsuccess = () => {
      const transaction = request.result.transaction('conversationSummaries', 'readwrite');
      transaction.objectStore('conversationSummaries').put({ conversationId: 'broken', title: 42 });
      transaction.oncomplete = () => {
        request.result.close();
        resolve();
      };
    };
  });
}

module.exports = { storedRecordValidation };
