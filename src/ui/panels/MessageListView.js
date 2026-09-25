import { FrameScheduler } from '../../dom/FrameScheduler.js';
import { ImageViewerDialog } from '../dialogs/ImageViewerDialog.js';
import { LIMITS } from '../../config/LIMITS.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { TIMING } from '../../config/TIMING.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import stylesheet from './MessageListView.css';

StyleRegistry.register(stylesheet);

/**
 * The messages of a chat session: copy, retry, branch navigation between a message's edits and
 * retries, and double-click (or the edit button) to edit a human message, which sends the new text
 * as a sibling branch. Streaming updates re-render only the affected message, at most once per
 * animation frame.
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
   * Position of the message being edited, or null while none is.
   * @type {?number}
   */
  #editingIndex = null;

  /**
   * Handler per data-action value.
   * @type {Map<string, function(HTMLElement): void>}
   */
  #actionHandlers = new Map([
    ['retry', () => this.#session.retryLastPrompt()],
    ['copy', button => this.#copyMessageText(button)],
    ['openImage', image => new ImageViewerDialog(image.dataset.fullSrc, image.alt).show()],
    ['startEdit', button => this.#startEdit(MessageListView.#indexOf(button))],
    ['cancelEdit', () => this.#cancelEdit()],
    ['saveEdit', button => this.#commitEdit(button.closest('.claude-plus-message'))],
    ['prevBranch', button => this.#switchBranch(button, -1)],
    ['nextBranch', button => this.#switchBranch(button, 1)],
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
    listElement.addEventListener('dblclick', event => this.#onDoubleClick(event));
    listElement.addEventListener('keydown', event => this.#onEditKeydown(event));
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
    this.#listElement.innerHTML = messages.map((message, index) => this.#messageHtml(message, index, index === retryableIndex)).join('')
      || '<div class="claude-plus-empty-state claude-plus-empty-state--padded">Start a conversation using the message box below.</div>';
    this.#scrollToBottomIf(wasAtBottom);
    this.#focusEditInputIfEditing();
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
   * HTML of one message: its edit form while being edited, else its bubble with actions.
   * @param {ChatMessage} message The message.
   * @param {number} index Position in the list.
   * @param {boolean} offersRetry Whether to offer retry on it.
   * @returns {string} The message.
   */
  #messageHtml(message, index, offersRetry) {
    if (index === this.#editingIndex) return MessageListView.#editingMessageHtml(message, index);
    const sender = message.sender === 'human' ? 'human' : 'assistant';
    const bodyHtml = MessageListView.#messageBodyHtml(message);
    return `
      <div class="claude-plus-message claude-plus-message--${sender}" data-message-index="${index}">
        ${MessageListView.#attachmentsHtmlOrEmpty(message)}
        ${bodyHtml ? `<div class="claude-plus-message__bubble"><div class="claude-plus-message__body">${bodyHtml}</div></div>` : ''}
        ${this.#actionsHtmlOrEmpty(sender, message, offersRetry)}
      </div>`;
  }

  /**
   * HTML of a message's uploads, shown above it rather than inside it.
   * @param {ChatMessage} message The message.
   * @returns {string} The uploads, wrapped in their own container; an empty string when there are none.
   */
  static #attachmentsHtmlOrEmpty(message) {
    return message.attachmentsHtml ? `<div class="claude-plus-message__attachments">${message.attachmentsHtml}</div>` : '';
  }

  /**
   * A message's action row, or an empty string while it is still streaming.
   * @param {'human'|'assistant'} sender The message's sender.
   * @param {ChatMessage} message The message.
   * @param {boolean} offersRetry Whether to include retry.
   * @returns {string} The action row, or an empty string.
   */
  #actionsHtmlOrEmpty(sender, message, offersRetry) {
    if (message.isStreaming) return '';
    const branchInfo = message.isPersisted ? this.#session.branchInfoFor(message.id) : null;
    return this.#actionsHtml(sender, message, offersRetry, branchInfo);
  }

  /**
   * HTML of a human message's inline edit form: an editable copy of its text, and Cancel/Save.
   * @param {ChatMessage} message The message.
   * @param {number} index Position in the list.
   * @returns {string} The form.
   */
  static #editingMessageHtml(message, index) {
    return `
      <div class="claude-plus-message claude-plus-message--human claude-plus-message--editing" data-message-index="${index}">
        ${MessageListView.#attachmentsHtmlOrEmpty(message)}
        <textarea class="claude-plus-message__edit-input" data-name="editInput">${escapeHtml(message.text)}</textarea>
        <div class="claude-plus-message__actions">
          <button class="claude-plus-message__action-button" data-action="cancelEdit">Cancel</button>
          <button class="claude-plus-message__action-button claude-plus-message__action-button--primary" data-action="saveEdit">Save &amp; branch</button>
        </div>
      </div>`;
  }

  /**
   * HTML of a message's action row: branch navigation, copy, edit (human only) and retry.
   * @param {'human'|'assistant'} sender The message's sender.
   * @param {ChatMessage} message The message.
   * @param {boolean} offersRetry Whether to include retry.
   * @param {?{index: number, count: number}} branchInfo Its sibling position, if it has siblings.
   * @returns {string} The action row.
   */
  #actionsHtml(sender, message, offersRetry, branchInfo) {
    const branchNavHtml = branchInfo ? MessageListView.#branchNavHtml(branchInfo) : '';
    const editButton = sender === 'human' && message.isPersisted
      ? '<button class="claude-plus-message__action-button" data-action="startEdit" title="Edit and branch from here">✎</button>' : '';
    const retryButton = offersRetry ? '<button class="claude-plus-message__action-button" data-action="retry" title="Retry">🔁</button>' : '';
    return `
      <div class="claude-plus-message__actions">
        ${branchNavHtml}
        <button class="claude-plus-message__action-button" data-action="copy" title="Copy">📋</button>
        ${editButton}
        ${retryButton}
      </div>`;
  }

  /**
   * HTML of a branch-switch control: previous/next buttons around the sibling position.
   * @param {{index: number, count: number}} branchInfo Zero-based position and sibling count.
   * @returns {string} The control.
   */
  static #branchNavHtml({ index, count }) {
    const prevDisabled = index === 0 ? 'disabled' : '';
    const nextDisabled = index === count - 1 ? 'disabled' : '';
    return `
      <span class="claude-plus-message__branch-nav">
        <button class="claude-plus-message__branch-nav-button" data-action="prevBranch" ${prevDisabled} title="Previous version">‹</button>
        <span class="claude-plus-message__branch-nav-count">${index + 1}/${count}</span>
        <button class="claude-plus-message__branch-nav-button" data-action="nextBranch" ${nextDisabled} title="Next version">›</button>
      </span>`;
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
   * Starts editing the human message double-clicked on, unless it hasn't been persisted yet.
   * @param {MouseEvent} event Double-click inside the list.
   * @returns {void}
   */
  #onDoubleClick(event) {
    if (event.target.closest('[data-action], .claude-plus-message__edit-input')) return;
    const container = event.target.closest('.claude-plus-message--human');
    if (!container) return;
    const index = MessageListView.#indexOf(container);
    if (this.#session.messages[index]?.isPersisted) this.#startEdit(index);
  }

  /**
   * Saves or cancels the edit in progress on Enter or Escape.
   * @param {KeyboardEvent} event Key press inside the list.
   * @returns {void}
   */
  #onEditKeydown(event) {
    if (!event.target.matches('.claude-plus-message__edit-input')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.#cancelEdit();
    } else if (MessageListView.#isCommitShortcut(event)) {
      event.preventDefault();
      this.#commitEdit(event.target.closest('.claude-plus-message'));
    }
  }

  /**
   * Whether a key press commits an edit in progress.
   * @param {KeyboardEvent} event The key press.
   * @returns {boolean} True for Enter without Shift outside IME composition.
   */
  static #isCommitShortcut(event) {
    return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
  }

  /**
   * Shows a message as an editable form.
   * @param {number} index Position of the message.
   * @returns {void}
   */
  #startEdit(index) {
    this.#editingIndex = index;
    this.render();
  }

  /**
   * Leaves edit mode without sending anything.
   * @returns {void}
   */
  #cancelEdit() {
    this.#editingIndex = null;
    this.render();
  }

  /**
   * Sends an edit form's text as a branch from the edited message's parent, or cancels for blank
   * text.
   * @param {HTMLElement} container The message element being edited.
   * @returns {void}
   */
  #commitEdit(container) {
    const index = MessageListView.#indexOf(container);
    const newText = container.querySelector('.claude-plus-message__edit-input').value;
    this.#editingIndex = null;
    if (newText.trim()) this.#session.editMessage(index, newText);
    else this.render();
  }

  /**
   * Focuses and places the caret at the end of the edit form's text, if one is open.
   * @returns {void}
   */
  #focusEditInputIfEditing() {
    if (this.#editingIndex === null) return;
    const input = this.#listElement.querySelector('.claude-plus-message__edit-input');
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /**
   * Switches a message to its previous or next sibling version.
   * @param {HTMLElement} button The clicked branch-nav button.
   * @param {number} step -1 for the previous version, +1 for the next.
   * @returns {void}
   */
  #switchBranch(button, step) {
    const message = this.#session.messages[MessageListView.#indexOf(button)];
    if (message) this.#session.switchBranch(message.id, step);
  }

  /**
   * Position encoded in the closest message element's data-message-index.
   * @param {HTMLElement} descendant An element inside, or equal to, a message element.
   * @returns {number} The position.
   */
  static #indexOf(descendant) {
    return Number(descendant.closest('.claude-plus-message').dataset.messageIndex);
  }

  /**
   * Copies a message's text to the clipboard and briefly shows a check mark.
   * @param {HTMLElement} button The copy button.
   * @returns {void}
   */
  #copyMessageText(button) {
    const message = this.#session.messages[MessageListView.#indexOf(button)];
    navigator.clipboard.writeText(MessageListView.#copyableText(message)).catch(() => undefined);
    const label = button.textContent;
    button.textContent = '✓';
    setTimeout(() => { button.textContent = label; }, TIMING.copyFeedbackMs);
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
