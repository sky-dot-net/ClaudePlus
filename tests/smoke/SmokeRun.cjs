/**
 * State and helpers shared by the smoke scenarios: the page under test, the userscript, the
 * recorded check results and page errors, and locators for the parts of the UI.
 */
class SmokeRun {
  /**
   * Browser context of the page.
   * @type {import('playwright').BrowserContext}
   */
  context;

  /**
   * The page under test.
   * @type {import('playwright').Page}
   */
  page;

  /**
   * Source of the userscript under test.
   * @type {string}
   */
  script;

  /**
   * The API mock serving the page.
   * @type {ClaudeApiMock}
   */
  api;

  /**
   * Result lines, "PASS name" or "FAIL name — detail".
   * @type {string[]}
   */
  results = [];

  /**
   * Uncaught page errors and console errors.
   * @type {string[]}
   */
  errors = [];

  /**
   * Creates the run and records the page's errors.
   * @param {object} setup Run setup.
   * @param {import('playwright').BrowserContext} setup.context Browser context of the page.
   * @param {import('playwright').Page} setup.page The page under test.
   * @param {string} setup.script Source of the userscript under test.
   * @param {ClaudeApiMock} setup.api The API mock serving the page.
   */
  constructor({ context, page, script, api }) {
    this.context = context;
    this.page = page;
    this.script = script;
    this.api = api;
    page.on('pageerror', error => this.errors.push(`pageerror: ${error.message}`));
    page.on('console', message => this.#recordConsoleError(message));
  }

  /**
   * Whether every check passed.
   * @returns {boolean} True without a failed check.
   */
  get hasPassed() {
    return this.results.every(result => result.startsWith('PASS'));
  }

  /**
   * Records a check result.
   * @param {string} name What was checked.
   * @param {boolean} isPassing Whether it passed.
   * @param {string} [detail] Shown after a failure's name.
   * @returns {void}
   */
  check(name, isPassing, detail = '') {
    this.results.push(isPassing ? `PASS ${name}` : `FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }

  /**
   * Opens a claude.ai URL and injects the userscript.
   * @param {string} url Page URL.
   * @returns {Promise<void>} Resolves once a chat message is shown.
   */
  async boot(url) {
    await this.page.goto(url);
    await this.injectScript();
  }

  /**
   * Reloads the page and injects the userscript again.
   * @returns {Promise<void>} Resolves once a chat message is shown.
   */
  async reload() {
    await this.page.reload();
    await this.injectScript();
  }

  /**
   * Injects the userscript into the current page and clicks the launcher button, since ClaudePlus
   * no longer starts itself.
   * @returns {Promise<void>} Resolves once a chat message is shown and the first layout settled.
   */
  async injectScript() {
    await this.page.addScriptTag({ content: this.script });
    await this.page.click('.claude-plus-launcher');
    await this.page.waitForSelector('.claude-plus-message');
    await this.page.waitForTimeout(400);
  }

  /**
   * The panel containing an element with a data-name.
   * @param {string} elementName The data-name.
   * @returns {import('playwright').Locator} The panel.
   */
  panelWith(elementName) {
    return this.page.locator('.claude-plus-panel', { has: this.page.locator(`[data-name="${elementName}"]`) }).first();
  }

  /**
   * The Chats panel.
   * @returns {import('playwright').Locator} The panel.
   */
  get chatsPanel() {
    return this.panelWith('searchInput');
  }

  /**
   * The composer panel.
   * @returns {import('playwright').Locator} The panel.
   */
  get composer() {
    return this.panelWith('promptInput');
  }

  /**
   * Clicks the tab whose label is exactly a text; clicking the label never hits a close button.
   * @param {string} label The tab label.
   * @returns {Promise<void>} Resolves once the tab's panel had time to render.
   */
  async openTab(label) {
    await this.page.click(`.claude-plus-tab__label:text-is("${label}")`);
    await this.page.waitForTimeout(100);
  }

  /**
   * Chooses an entry of the "+" menu of the zone holding a tab.
   * @param {string} tabText Text of a tab in the zone.
   * @param {string} entryId Menu entry id.
   * @returns {Promise<void>} Resolves once the result had time to render.
   */
  async chooseFromAddMenu(tabText, entryId) {
    const tabStrip = this.page.locator('.claude-plus-tab-strip', { has: this.page.locator('.claude-plus-tab', { hasText: tabText }) });
    await tabStrip.locator('.claude-plus-tab-strip__add-button').click();
    await this.page.click(`.claude-plus-popup-menu__entry[data-entry-id="${entryId}"]`);
    await this.page.waitForTimeout(200);
  }

  /**
   * Types a prompt into the composer and sends it with Enter.
   * @param {string} prompt Prompt text.
   * @returns {Promise<void>} Resolves once the reply has finished streaming.
   */
  async sendPrompt(prompt) {
    const promptInput = this.composer.locator('[data-name="promptInput"]');
    await promptInput.fill(prompt);
    await promptInput.press('Enter');
    await this.page.waitForFunction(() => document.querySelector('[data-name="stopButton"]').hidden);
  }

  /**
   * Records console errors.
   * @param {import('playwright').ConsoleMessage} message A console message.
   * @returns {void}
   */
  #recordConsoleError(message) {
    if (message.type() === 'error') this.errors.push(`console: ${message.text()}`);
  }
}

module.exports = { SmokeRun };
