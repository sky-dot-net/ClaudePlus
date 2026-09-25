import { FrameScheduler } from '../../dom/FrameScheduler.js';
import { ImageViewerDialog } from '../dialogs/ImageViewerDialog.js';
import { LIMITS } from '../../config/LIMITS.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { TIMING } from '../../config/TIMING.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import stylesheet from './MessageListView.css';

StyleRegistry.register(stylesheet);

/**
 * The messages of a chat session with copy and retry actions. Streaming updates re-render only
 * the affected message, at most once per animation frame.
 */
export class MessageListView {
  /**
   * List element the messages are rendered into.
   * @type {HTMLElement}
   */
  #listElement;

  /**
   * Session whose messages are shown.
   * @type {ChatSession}
   */
  #session;

  /**
   * Messages whose content changed since the last frame.
   * @type {Set<ChatMessage>}
   */
  #changedMessages = new Set();

  /**
   * Batches message updates per frame.
   * @type {FrameScheduler}
   */
  #updateScheduler = new FrameScheduler(() => this.#renderChangedMessages());

  /**
   * Handler per data-action value.
   * @type {Map<string, function(HTMLElement): void>}
   */
  #actionHandlers = new Map([
    ['retry', () => this.#session.retryLastPrompt()],
    ['copy', button => this.#copyMessageText(button)],
    ['openImage', image => new ImageViewerDialog(image.dataset.fullSrc, image.alt).show()],
  ]);

  /**
   * Wires the view to its list element and session.
   * @param {Panel} ownerPanel Panel owning the subscriptions.
   * @param {HTMLElement} listElement List element the messages are rendered into.
   * @param {ChatSession} session Session whose messages are shown.
   */
  constructor(ownerPanel, listElement, session) {
    this.#listElement = listElement;
    this.#session = session;
    listElement.addEventListener('click', event => this.#onClick(event));
    ownerPanel.listenTo(session, 'messages', () => this.render());
    ownerPanel.listenTo(session, 'sending', () => this.render());
    ownerPanel.listenTo(session, 'messageContent', message => this.#scheduleMessageUpdate(message));
  }

  /**
   * Re-renders every message, keeping the view at the bottom if it was there.
   * @returns {void}
   */
  render() {
    this.#changedMessages.clear();
    this.#updateScheduler.cancel();
    const wasAtBottom = this.#isScrolledToBottom();
    const messages = this.#session.messages;
    const retryableIndex = this.#session.isSending ? -1 : messages.findLastIndex(message => message.sender === 'assistant');
    this.#listElement.innerHTML = messages.map((message, index) => MessageListView.#messageHtml(message, index, index === retryableIndex)).join('')
      || '<div class="claude-plus-empty-state claude-plus-empty-state--padded">Start a conversation using the message box below.</div>';
    this.#scrollToBottomIf(wasAtBottom);
  }

  /**
   * Queues a message for re-rendering on the next frame.
   * @param {ChatMessage} message The changed message.
   * @returns {void}
   */
  #scheduleMessageUpdate(message) {
    this.#changedMessages.add(message);
    this.#updateScheduler.schedule();
  }

  /**
   * Re-renders the queued messages.
   * @returns {void}
   */
  #renderChangedMessages() {
    const wasAtBottom = this.#isScrolledToBottom();
    this.#changedMessages.forEach(message => this.#renderMessageBody(message));
    this.#changedMessages.clear();
    this.#scrollToBottomIf(wasAtBottom);
  }

  /**
   * Re-renders one message's body, if it is still shown.
   * @param {ChatMessage} message The message.
   * @returns {void}
   */
  #renderMessageBody(message) {
    const index = this.#session.messages.indexOf(message);
    const body = this.#listElement.querySelector(`[data-message-index="${index}"] .claude-plus-message__body`);
    if (body) body.innerHTML = MessageListView.#messageBodyHtml(message);
  }

  /**
   * HTML of one message.
   * @param {ChatMessage} message The message.
   * @param {number} index Position in the list.
   * @param {boolean} offersRetry Whether to offer retry on it.
   * @returns {string} The message.
   */
  static #messageHtml(message, index, offersRetry) {
    const sender = message.sender === 'human' ? 'human' : 'assistant';
    return `
      <div class="claude-plus-message claude-plus-message--${sender}" data-message-index="${index}">
        <div class="claude-plus-message__sender">${sender === 'human' ? 'You' : 'Claude'}</div>
        <div class="claude-plus-message__body">${MessageListView.#messageBodyHtml(message)}</div>
        ${message.isStreaming ? '' : MessageListView.#actionButtonsHtml(offersRetry)}
      </div>`;
  }

  /**
   * HTML of a message's action buttons.
   * @param {boolean} offersRetry Whether to include retry.
   * @returns {string} The buttons.
   */
  static #actionButtonsHtml(offersRetry) {
    const retryButton = offersRetry ? '<button class="claude-plus-message__action-button" data-action="retry" title="Retry">🔁 Retry</button>' : '';
    return `<div class="claude-plus-message__actions"><button class="claude-plus-message__action-button" data-action="copy" title="Copy">📋</button>${retryButton}</div>`;
  }

  /**
   * HTML of a message's body: content, error and streaming cursor.
   * @param {ChatMessage} message The message.
   * @returns {string} The body.
   */
  static #messageBodyHtml(message) {
    const errorHtml = message.errorText ? `<div class="claude-plus-message-error">Error: ${escapeHtml(message.errorText)}</div>` : '';
    const cursorHtml = message.isStreaming ? '<span class="claude-plus-streaming-cursor">▍</span>' : '';
    return `${message.html}${errorHtml}${cursorHtml}`;
  }

  /**
   * Runs the action of a clicked button.
   * @param {MouseEvent} event Click inside the list.
   * @returns {void}
   */
  #onClick(event) {
    const button = event.target.closest('[data-action]');
    const handleAction = button ? this.#actionHandlers.get(button.dataset.action) : null;
    if (handleAction) handleAction(button);
  }

  /**
   * Copies a message's text to the clipboard and briefly shows a check mark.
   * @param {HTMLElement} button The copy button.
   * @returns {void}
   */
  #copyMessageText(button) {
    const message = this.#session.messages[Number(button.closest('.claude-plus-message').dataset.messageIndex)];
    navigator.clipboard.writeText(MessageListView.#copyableText(message)).catch(() => undefined);
    button.textContent = '✓';
    setTimeout(() => { button.textContent = '📋'; }, TIMING.copyFeedbackMs);
  }

  /**
   * Text copied for a message.
   * @param {?ChatMessage} message The message.
   * @returns {string} Its text, else its error, else an empty string.
   */
  static #copyableText(message) {
    return message ? message.text || message.errorText || '' : '';
  }

  /**
   * Whether the list is scrolled to (or near) the bottom.
   * @returns {boolean} True within LIMITS.followOutputDistance of the bottom.
   */
  #isScrolledToBottom() {
    const list = this.#listElement;
    return list.scrollHeight - list.scrollTop - list.clientHeight < LIMITS.followOutputDistance;
  }

  /**
   * Scrolls to the bottom if the list was there before an update.
   * @param {boolean} wasAtBottom Whether the list was at the bottom.
   * @returns {void}
   */
  #scrollToBottomIf(wasAtBottom) {
    if (wasAtBottom) this.#listElement.scrollTop = this.#listElement.scrollHeight;
  }
}
