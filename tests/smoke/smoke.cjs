const fileSystem = require('node:fs');
const path = require('node:path');
const { ClaudeApiMock } = require('./ClaudeApiMock.cjs');
const { SmokeRun } = require('./SmokeRun.cjs');
const { activeChatBorder } = require('./scenarios/activeChatBorder.cjs');
const { addPanelMenu } = require('./scenarios/addPanelMenu.cjs');
const { chromium } = require('playwright');
const { composerSending } = require('./scenarios/composerSending.cjs');
const { conversationSubPanes } = require('./scenarios/conversationSubPanes.cjs');
const { conversationTable } = require('./scenarios/conversationTable.cjs');
const { deleteAndShortcut } = require('./scenarios/deleteAndShortcut.cjs');
const { failedMount } = require('./scenarios/failedMount.cjs');
const { fileAttachments } = require('./scenarios/fileAttachments.cjs');
const { imageViewer } = require('./scenarios/imageViewer.cjs');
const { layoutLibrary } = require('./scenarios/layoutLibrary.cjs');
const { searchPanel } = require('./scenarios/searchPanel.cjs');
const { settingsTransfer } = require('./scenarios/settingsTransfer.cjs');
const { sourceAndFilePanels } = require('./scenarios/sourceAndFilePanels.cjs');
const { storedRecordValidation } = require('./scenarios/storedRecordValidation.cjs');

/**
 * Scenarios in the order they run; each builds on the state the previous ones left.
 * @type {Array<function(SmokeRun): Promise<void>>}
 */
const SCENARIOS = [
  storedRecordValidation, conversationTable, sourceAndFilePanels, searchPanel, composerSending, fileAttachments,
  conversationSubPanes, addPanelMenu, activeChatBorder, imageViewer, layoutLibrary, settingsTransfer, deleteAndShortcut, failedMount,
];

/**
 * Runs every smoke scenario against a built userscript in headless Chromium with a mocked
 * claude.ai, prints one line per check, saves a final screenshot to test-results/ and exits
 * non-zero when a check failed or the page logged an error.
 * Usage: node tests/smoke/smoke.cjs build/dev/ClaudePlus.js
 * @returns {Promise<void>} Resolves once the browser is closed.
 */
async function runSmokeTests() {
  const scriptPath = path.resolve(process.argv[2] ?? 'build/dev/ClaudePlus.js');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const api = new ClaudeApiMock();
  await api.install(page);
  const run = new SmokeRun({ context, page, script: fileSystem.readFileSync(scriptPath, 'utf8'), api });
  try {
    for (const scenario of SCENARIOS) await scenario(run);
    run.check('no page/console errors', run.errors.length === 0, run.errors.join(' | '));
    await page.screenshot({ path: path.resolve('test-results/smoke.png') });
  } finally {
    console.log(`${path.relative(process.cwd(), scriptPath)}\n${run.results.join('\n')}`);
    await browser.close();
  }
  process.exitCode = run.hasPassed ? 0 : 1;
}

runSmokeTests().catch(error => {
  console.error(error.message.split('\n')[0]);
  process.exitCode = 1;
});
