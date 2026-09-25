const fileSystem = require('node:fs');
const operatingSystem = require('node:os');
const path = require('node:path');

/**
 * Checks the settings export (every ClaudePlus setting, nothing else) and the import, which
 * replaces the settings after confirmation and reloads the page.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function settingsTransfer(run) {
  const { page } = run;
  await page.click('[data-name="settingsButton"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.claude-plus-popup-menu__entry[data-entry-id="export"]')]);
  const exported = JSON.parse(fileSystem.readFileSync(await download.path(), 'utf8'));
  const settingKeys = Object.keys(exported.settings);
  const hasExpectedKeys = 'claudePlus.savedLayouts' in exported.settings && 'claudePlus.table.conversations' in exported.settings;
  run.check('settings export contains all ClaudePlus settings', exported.format === 'ClaudePlus settings' && hasExpectedKeys && settingKeys.every(key => key.startsWith('claudePlus.')), settingKeys.join(', '));
  exported.settings['claudePlus.messageFontSize'] = '19';
  const importPath = path.join(fileSystem.mkdtempSync(path.join(operatingSystem.tmpdir(), 'claude-plus-smoke-')), 'import-settings.json');
  fileSystem.writeFileSync(importPath, JSON.stringify(exported));
  await page.click('[data-name="settingsButton"]');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.claude-plus-popup-menu__entry[data-entry-id="import"]')]);
  await chooser.setFiles(importPath);
  await page.waitForSelector('.claude-plus-dialog .claude-plus-primary-button');
  await Promise.all([page.waitForNavigation(), page.click('.claude-plus-dialog .claude-plus-primary-button')]);
  await run.injectScript();
  run.check('settings import replaces settings and reloads', await page.$eval('[data-name="fontSizeLabel"]', label => label.textContent) === '19px');
}

module.exports = { settingsTransfer };
