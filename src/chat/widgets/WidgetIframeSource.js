import { TIMING } from '../../config/TIMING.js';
import { createElement } from '../../dom/createElement.js';

/**
 * Extracts a widget's real rendered card straight from claude.ai's own React app, run fresh and
 * self-contained in a hidden same-origin iframe: no widget-specific rendering code of our own, no
 * touching the page's own native app instance. The iframe loads the conversation, React renders
 * the widget exactly as it normally would (its own hooks, its own context, all real), and once
 * found by its tool call's id, the finished card's HTML and stylesheet URLs are read off and the
 * iframe is torn down.
 */
export class WidgetIframeSource {
  /**
   * How long to wait for a widget to appear before giving up.
   * @type {number}
   */
  static #TIMEOUT_MS = 20000;

  /**
   * Extracts a widget's rendered card.
   * @param {string} conversationId Conversation the widget's message belongs to.
   * @param {string} toolUseId Id of the widget's tool_use block.
   * @returns {Promise<{html: string, cssHrefs: string[]}>} The card's outer HTML and the
   * stylesheet URLs it depends on.
   * @throws {Error} When the widget doesn't appear within the timeout.
   */
  static async extract(conversationId, toolUseId) {
    const iframe = WidgetIframeSource.#createHiddenIframe(conversationId);
    document.body.append(iframe);
    try {
      return await WidgetIframeSource.#waitForWidget(iframe, toolUseId);
    } finally {
      iframe.remove();
    }
  }

  /**
   * Creates a hidden iframe pointed at a conversation, ready to append.
   * @param {string} conversationId Conversation to load.
   * @returns {HTMLIFrameElement} The iframe.
   */
  static #createHiddenIframe(conversationId) {
    return createElement('iframe', {
      src: `https://claude.ai/chat/${conversationId}`,
      style: 'position:fixed; top:-9999px; left:-9999px; width:900px; height:3000px; border:0;',
    });
  }

  /**
   * Polls the iframe until the widget appears or the timeout elapses.
   * @param {HTMLIFrameElement} iframe The extraction iframe.
   * @param {string} toolUseId Id of the widget's tool_use block.
   * @returns {Promise<{html: string, cssHrefs: string[]}>} The extracted card.
   * @throws {Error} When the widget doesn't appear within the timeout.
   */
  static #waitForWidget(iframe, toolUseId) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + WidgetIframeSource.#TIMEOUT_MS;
      const poll = () => WidgetIframeSource.#pollOnce(iframe, toolUseId, deadline, poll, resolve, reject);
      poll();
    });
  }

  /**
   * One poll attempt: resolves if found, rejects past the deadline, else schedules another attempt.
   * @param {HTMLIFrameElement} iframe The extraction iframe.
   * @param {string} toolUseId Id of the widget's tool_use block.
   * @param {number} deadline Epoch ms after which to give up.
   * @param {function(): void} poll This function, to schedule the next attempt.
   * @param {function({html: string, cssHrefs: string[]}): void} resolve Resolves the extraction.
   * @param {function(Error): void} reject Rejects the extraction.
   * @returns {void}
   */
  static #pollOnce(iframe, toolUseId, deadline, poll, resolve, reject) {
    const found = WidgetIframeSource.#tryFind(iframe, toolUseId);
    if (found) resolve(found);
    else if (Date.now() > deadline) reject(new Error(`widget ${toolUseId} did not render within the timeout`));
    else setTimeout(poll, TIMING.widgetExtractPollMs);
  }

  /**
   * Looks for the widget in the iframe's current document, if it has loaded far enough to have one.
   * @param {HTMLIFrameElement} iframe The extraction iframe.
   * @param {string} toolUseId Id of the widget's tool_use block.
   * @returns {?{html: string, cssHrefs: string[]}} The extracted card, or null when not found yet.
   */
  static #tryFind(iframe, toolUseId) {
    const documentInFrame = WidgetIframeSource.#documentOf(iframe);
    const rootElement = documentInFrame?.getElementById('root');
    const rootFiber = rootElement ? WidgetIframeSource.#fiberOf(rootElement) : null;
    if (!rootFiber) return null;
    const hostElement = WidgetIframeSource.#findWidgetElement(rootFiber, toolUseId);
    if (!hostElement) return null;
    const cssHrefs = [...documentInFrame.querySelectorAll('link[rel="stylesheet"]')].map(link => link.href);
    return { html: hostElement.outerHTML, cssHrefs };
  }

  /**
   * The iframe's document, or null while it can't be read (not yet navigated, still loading).
   * @param {HTMLIFrameElement} iframe The extraction iframe.
   * @returns {?Document} The document, or null.
   */
  static #documentOf(iframe) {
    try {
      return iframe.contentDocument;
    } catch {
      return null;
    }
  }

  /**
   * React's internal fiber for a DOM node, if it manages one.
   * @param {HTMLElement} element The element.
   * @returns {?object} The fiber, or null.
   */
  static #fiberOf(element) {
    const fiberKey = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactFiber') || name.startsWith('__reactContainer'));
    return fiberKey ? element[fiberKey] : null;
  }

  /**
   * The rendered DOM element of the widget matching a tool call id, searching the whole fiber
   * tree generically (works for every widget type, since it looks for the tool call id claude.ai
   * itself passes as a prop, not for anything specific to one widget's layout).
   * @param {object} rootFiber Root fiber to search from.
   * @param {string} toolUseId Id of the widget's tool_use block.
   * @returns {?HTMLElement} The widget's outermost rendered element, or null when not found.
   */
  static #findWidgetElement(rootFiber, toolUseId) {
    const matchingFiber = WidgetIframeSource.#findMatchingFiber(rootFiber, new Set(), toolUseId);
    return matchingFiber ? WidgetIframeSource.#firstHostElement(matchingFiber) : null;
  }

  /**
   * Depth-first search of the fiber tree for a node whose props carry a given tool call id.
   * @param {?object} fiber Fiber to check, or null past the end of a branch.
   * @param {Set<object>} visited Fibers already checked, since child/sibling links can cross-reference.
   * @param {string} toolUseId Id of the widget's tool_use block.
   * @returns {?object} The matching fiber, or null.
   */
  static #findMatchingFiber(fiber, visited, toolUseId) {
    if (!fiber || visited.has(fiber)) return null;
    visited.add(fiber);
    if (WidgetIframeSource.#isWidgetFiber(fiber, toolUseId)) return fiber;
    return WidgetIframeSource.#findMatchingFiber(fiber.child, visited, toolUseId) || WidgetIframeSource.#findMatchingFiber(fiber.sibling, visited, toolUseId);
  }

  /**
   * Whether a fiber's props identify it as the widget with a given tool call id.
   * @param {object} fiber The fiber.
   * @param {string} toolUseId Id of the widget's tool_use block.
   * @returns {boolean} True when its props carry a matching toolUseId.
   */
  static #isWidgetFiber(fiber, toolUseId) {
    const props = fiber.memoizedProps;
    return Boolean(props) && typeof props === 'object' && props.toolUseId === toolUseId && 'input' in props;
  }

  /**
   * The first real DOM element a fiber (or its descendants) renders to.
   * @param {object} fiber The fiber.
   * @returns {?HTMLElement} The element, or null when it renders nothing yet.
   */
  static #firstHostElement(fiber) {
    let node = fiber;
    while (node) {
      if (node.stateNode instanceof HTMLElement) return node.stateNode;
      node = node.child;
    }
    return null;
  }
}
