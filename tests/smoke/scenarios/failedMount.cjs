const { ClaudeApiMock } = require('../ClaudeApiMock.cjs');

/**
 * Checks that a start failing while mounting removes everything the script added and leaves the
 * native app visible, by making window.innerWidth throw in a separate page.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function failedMount(run) {
  const failingPage = await run.context.newPage();
  await failingPage.route('https://claude.ai/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: ClaudeApiMock.NATIVE_APP_HTML }));
  await failingPage.addInitScript(makeInnerWidthThrow);
  await failingPage.goto('https://claude.ai/new');
  await failingPage.addScriptTag({ content: run.script });
  await failingPage.waitForTimeout(300);
  const isNativeAppVisible = await failingPage.$eval('#root', root => getComputedStyle(root).display !== 'none');
  const addedElementCount = await failingPage.$$eval('.claude-plus-styles, body > [class*="claude-plus-"]', elements => elements.length);
  run.check('failed mount leaves claude.ai visible', isNativeAppVisible && addedElementCount === 0);
  await failingPage.close();
}

/**
 * Runs in the page before any script: makes reading window.innerWidth throw.
 * @returns {void}
 */
function makeInnerWidthThrow() {
  Object.defineProperty(window, 'innerWidth', {
    get() {
      throw new Error('forced mount failure');
    },
  });
}

module.exports = { failedMount };
