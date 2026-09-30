/**
 * Runs in the page: the resolved font-family custom properties.
 * @returns {{interfaceFont: string, chatFont: string}} The interface and chat font stacks currently applied.
 */
function readAppliedFonts() {
  const style = getComputedStyle(document.documentElement);
  return { interfaceFont: style.getPropertyValue('--claude-plus-font-family').trim(), chatFont: style.getPropertyValue('--claude-plus-message-font-family').trim() };
}

/**
 * Opens the settings dialog.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once open.
 */
async function openSettings(run) {
  await run.page.click('[data-name="settingsButton"]');
  await run.page.waitForSelector('.claude-plus-settings-dialog');
}

/**
 * Closes the settings dialog.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once closed.
 */
async function closeSettings(run) {
  await run.page.click('.claude-plus-settings-dialog [data-name="closeButton"]');
}

/**
 * Checks that a fresh install defaults both font pickers to Anthropic Sans - claude.ai's own font -
 * rather than a blank field or a plain system font, and actually applies it.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkDefaultIsAnthropicSans(run) {
  const applied = await run.page.evaluate(readAppliedFonts);
  run.check('the interface font defaults to Anthropic Sans, not a blank system default', applied.interfaceFont.startsWith('anthropic-sans'), applied.interfaceFont);
  run.check('the chat font defaults to Anthropic Sans too', applied.chatFont.startsWith('anthropic-sans'), applied.chatFont);
  await openSettings(run);
  const uiSelect = run.page.locator('.claude-plus-settings-dialog [data-name="uiFontSelect"]');
  run.check('the interface font picker is a dropdown, pre-selecting Anthropic Sans', await uiSelect.inputValue() === 'anthropicSans', await uiSelect.inputValue());
  run.check('the free-text font field is hidden while a preset is selected', await run.page.locator('.claude-plus-settings-dialog [data-name="uiFontInput"]').isHidden());
}

/**
 * Checks that choosing another preset from the dropdown applies it immediately, with no need to
 * type anything.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkPresetChoice(run) {
  const chatSelect = run.page.locator('.claude-plus-settings-dialog [data-name="chatFontSelect"]');
  await chatSelect.selectOption('inter');
  const applied = await run.page.evaluate(readAppliedFonts);
  run.check('choosing a different preset applies it without typing anything', applied.chatFont.startsWith('"Inter"'), applied.chatFont);
}

/**
 * Checks that choosing "Custom…" reveals a free-text field and applies whatever is typed into it.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkCustomFont(run) {
  const uiSelect = run.page.locator('.claude-plus-settings-dialog [data-name="uiFontSelect"]');
  const uiInput = run.page.locator('.claude-plus-settings-dialog [data-name="uiFontInput"]');
  await uiSelect.selectOption('custom');
  run.check('choosing "Custom…" reveals the free-text field', await uiInput.isVisible());
  await uiInput.fill('"Comic Sans MS", cursive');
  const applied = await run.page.evaluate(readAppliedFonts);
  run.check('typing a custom font applies it', applied.interfaceFont.startsWith('"Comic Sans MS"'), applied.interfaceFont);
}

/**
 * Checks that Reset to defaults returns both pickers to Anthropic Sans.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function checkResetRestoresDefault(run) {
  await run.page.click('.claude-plus-settings-dialog [data-name="resetThemeButton"]');
  const uiSelect = run.page.locator('.claude-plus-settings-dialog [data-name="uiFontSelect"]');
  const chatSelect = run.page.locator('.claude-plus-settings-dialog [data-name="chatFontSelect"]');
  run.check('Reset to defaults returns both font pickers to Anthropic Sans', await uiSelect.inputValue() === 'anthropicSans' && await chatSelect.inputValue() === 'anthropicSans', JSON.stringify({ uiFont: await uiSelect.inputValue(), chatFont: await chatSelect.inputValue() }));
  const applied = await run.page.evaluate(readAppliedFonts);
  run.check('Reset to defaults re-applies Anthropic Sans', applied.interfaceFont.startsWith('anthropic-sans') && applied.chatFont.startsWith('anthropic-sans'), JSON.stringify(applied));
}

/**
 * Checks the font settings: they default to claude.ai's own Anthropic Sans font instead of a blank
 * field, are chosen from a dropdown of presets instead of typed freehand, "Custom…" still allows a
 * free-text CSS font-family for anyone who wants one, and Reset to defaults restores Anthropic Sans.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function themeFonts(run) {
  await checkDefaultIsAnthropicSans(run);
  await checkPresetChoice(run);
  await checkCustomFont(run);
  await checkResetRestoresDefault(run);
  await closeSettings(run);
}

module.exports = { themeFonts };
