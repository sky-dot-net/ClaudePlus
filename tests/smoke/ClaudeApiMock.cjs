const zlib = require('node:zlib');
const { FIXTURE_IDS } = require('./FIXTURE_IDS.cjs');
const { conversationFixture } = require('./conversationFixture.cjs');

/**
 * Serves claude.ai for a Playwright page: a bare native app for every page and the internal API
 * from fixtures. Records every completion request and upload so scenarios can check what was sent.
 */
class ClaudeApiMock {
  /**
   * HTML standing in for the native claude.ai app.
   * @type {string}
   */
  static NATIVE_APP_HTML = '<!doctype html><html><head></head><body><div id="root">NATIVE APP</div></body></html>';

  /**
   * A 1×1 PNG served for the fixture image.
   * @type {Buffer}
   */
  static #FIXTURE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

  /**
   * Epoch milliseconds the fixture times are relative to.
   * @type {number}
   */
  #now = Date.now();

  /**
   * Parsed bodies of every completion request, oldest first.
   * @type {object[]}
   */
  completions = [];

  /**
   * Number of uploads received.
   * @type {number}
   */
  uploadCount = 0;

  /**
   * Answers every claude.ai request of a page.
   * @param {import('playwright').Page} page The page.
   * @returns {Promise<void>} Resolves once the route is installed.
   */
  install(page) {
    return page.route('https://claude.ai/**', route => this.#answer(route));
  }

  /**
   * Answers one request.
   * @param {import('playwright').Route} route The intercepted request.
   * @returns {Promise<void>} Resolves once fulfilled.
   */
  #answer(route) {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'text/html', body: ClaudeApiMock.NATIVE_APP_HTML });
    const handler = this.#handlers().find(([pattern]) => pattern.test(url.pathname));
    return handler ? handler[1](route, url, url.pathname.match(handler[0])) : ClaudeApiMock.#json(route, { error: `unmocked ${url.pathname}` }, 404);
  }

  /**
   * Handler per API path pattern, checked in order.
   * @returns {Array<[RegExp, function(import('playwright').Route, URL, RegExpMatchArray): Promise<void>]>} The handlers.
   */
  #handlers() {
    const organizationPath = `/api/organizations/${FIXTURE_IDS.organization}`;
    return [
      [/^\/api\/organizations$/, route => ClaudeApiMock.#json(route, [{ uuid: FIXTURE_IDS.organization }])],
      [/^\/api\/fixtures\/photo\.png$/, route => route.fulfill({ status: 200, contentType: 'image/png', body: ClaudeApiMock.#FIXTURE_PNG })],
      [new RegExp(`^${organizationPath}/usage$`), route => ClaudeApiMock.#json(route, { five_hour: { utilization: 12.5 }, seven_day: { utilization: 40 } })],
      [new RegExp(`^${organizationPath}/chat_conversations$`), (route, url) => this.#listConversations(route, url)],
      [/\/wiggle\/upload-file$/, route => this.#acceptUpload(route)],
      [/chat_conversations\/[^/]+\/completion$/, route => this.#streamCompletion(route)],
      [/chat_conversations\/([^/]+)$/, (route, url, match) => this.#answerConversation(route, match[1])],
    ];
  }

  /**
   * Lists both conversations on the first page and nothing after it.
   * @param {import('playwright').Route} route The request.
   * @param {URL} url Request URL.
   * @returns {Promise<void>} Resolves once fulfilled.
   */
  #listConversations(route, url) {
    const isFirstPage = Number(url.searchParams.get('offset')) === 0;
    return ClaudeApiMock.#json(route, isFirstPage ? [
      { uuid: FIXTURE_IDS.researchChat, name: 'Research chat', updated_at: new Date(this.#now - 1e6).toISOString() },
      { uuid: FIXTURE_IDS.secondChat, name: 'Second chat', updated_at: new Date(this.#now - 5e6).toISOString() },
    ] : []);
  }

  /**
   * Accepts an upload and answers with a file record whose id is "upload-" plus the file name.
   * @param {import('playwright').Route} route The request.
   * @returns {Promise<void>} Resolves once fulfilled.
   */
  #acceptUpload(route) {
    this.uploadCount += 1;
    const fileName = route.request().postData().match(/filename="([^"]+)"/)[1];
    return ClaudeApiMock.#json(route, { file_uuid: `upload-${fileName}`, file_name: fileName, file_kind: 'blob' });
  }

  /**
   * Records a completion request and streams a two-part reply with usage windows.
   * @param {import('playwright').Route} route The request.
   * @returns {Promise<void>} Resolves once fulfilled.
   */
  #streamCompletion(route) {
    this.completions.push(JSON.parse(zlib.gunzipSync(route.request().postDataBuffer()).toString()));
    const events = [
      { type: 'message_start' },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Streamed ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'reply.' } },
      { type: 'message_limit', message_limit: { windows: { '5h': { utilization: 13 }, '7d': { utilization: 41 } } } },
      { type: 'message_stop' },
    ];
    const body = events.map(event => `event: x\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  }

  /**
   * Deletes a conversation or returns its fixture.
   * @param {import('playwright').Route} route The request.
   * @param {string} conversationId Conversation id from the path.
   * @returns {Promise<void>} Resolves once fulfilled.
   */
  #answerConversation(route, conversationId) {
    if (route.request().method() === 'DELETE') return route.fulfill({ status: 204, body: '' });
    return ClaudeApiMock.#json(route, conversationFixture(conversationId, this.#now));
  }

  /**
   * Fulfills a request with JSON.
   * @param {import('playwright').Route} route The request.
   * @param {*} body Response body.
   * @param {number} [status] HTTP status.
   * @returns {Promise<void>} Resolves once fulfilled.
   */
  static #json(route, body, status = 200) {
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  }
}

module.exports = { ClaudeApiMock };
