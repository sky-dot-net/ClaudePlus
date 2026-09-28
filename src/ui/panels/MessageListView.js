import { FrameScheduler } from '../../dom/FrameScheduler.js';
import { ImageViewerDialog } from '../dialogs/ImageViewerDialog.js';
import { LIMITS } from '../../config/LIMITS.js';
import { MessageToolSteps } from '../../vendors/anthropic/chat/MessageToolSteps.js';
import { SelectionReplyButton } from './SelectionReplyButton.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { TIMING } from '../../config/TIMING.js';
import { VirtualList } from '../virtual/VirtualList.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import stylesheet from './MessageListView.css';

StyleRegistry.register(stylesheet);

/**
 * The messages of a chat session: copy, retry, branch navigation between a message's edits and
 * retries, and double-click (or the edit button) to edit a human message, which sends the new text
 * as a sibling branch. Selecting text offers a Reply button that requests a quote of it for the
 * next prompt. Streaming updates re-render only the affected message, at most once per animation
 * frame.
 */
export class MessageListView {
  /**
   * Gap between messages, in pixels; matches the list's CSS.
   * @type {number}
   */
  static #MESSAGE_GAP = 10;

  /**
   * Height assumed for a message until some have been measured, in pixels.
   * @type {number}
   */
  static #ESTIMATED_MESSAGE_HEIGHT = 110;

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
    ['toolSteps', button => this.#showToolSteps(button)],
  ]);

  /**
   * Called with a message to show its thinking and tool-call steps.
   * @type {function(ChatMessage): void}
   */
  #onShowToolSteps;

  /**
   * Fills a widget's placeholder slot with its real, extracted card.
   * @type {WidgetExtractor}
   */
  #widgetExtractor;

  /**
   * The floating "Reply" button shown above a text selection.
   * @type {SelectionReplyButton}
   */
  #replyButton = new SelectionReplyButton();

  /**
   * Renders only the messages near the visible area, however long the conversation is.
   * @type {VirtualList}
   */
  #virtualList;

  /**
   * Position of the message offering Retry, or -1 for none; decided once per render so messages
   * created later, as the list scrolls, agree with the ones created then.
   * @type {number}
   */
  #retryableIndex = -1;

  /**
   * The conversation the list last rendered, to notice a different one.
   * @type {?string|undefined}
   */
  #renderedConversationId;

  /**
   * Wires the view to its list element and session.
   * @param {Panel} ownerPanel Panel owning the subscriptions.
   * @param {HTMLElement} listElement List element the messages are rendered into.
   * @param {ChatSession} session Session whose messages are shown.
   * @param {function(ChatMessage): void} onShowToolSteps Called with a message to show its thinking and tool-call steps.
   * @param {WidgetExtractor} widgetExtractor Fills a widget's placeholder slot with its real, extracted card.
   */
  constructor(ownerPanel, listElement, session, onShowToolSteps, widgetExtractor) {
    this.#listElement = listElement;
    this.#session = session;
    this.#onShowToolSteps = onShowToolSteps;
    this.#widgetExtractor = widgetExtractor;
    this.#virtualList = this.#createVirtualList();
    listElement.addEventListener('click', event => this.#onClick(event));
    listElement.addEventListener('dblclick', event => this.#onDoubleClick(event));
    listElement.addEventListener('keydown', event => this.#onEditKeydown(event));
    listElement.addEventListener('mouseup', () => this.#onSelectionMaybeChanged());
    listElement.addEventListener('scroll', () => this.#replyButton.hide());
    ownerPanel.listenTo(session, 'messages', () => this.render());
    ownerPanel.listenTo(session, 'sending', () => this.render());
    ownerPanel.listenTo(session, 'messageContent', message => this.#scheduleMessageUpdate(message));
  }

  /**
   * Re-renders the messages near the visible area, keeping the view at the bottom if it was there
   * and starting at the bottom for a different conversation.
   * @returns {void}
   */
  render() {
    this.#changedMessages.clear();
    this.#updateScheduler.cancel();
    this.#replyButton.hide();
    const messages = this.#session.messages;
    this.#retryableIndex = this.#session.isSending || this.#session.isReadOnly ? -1 : messages.findLastIndex(message => message.sender === 'assistant');
    this.#resetForNewConversation();
    this.#virtualList.setCount(messages.length);
    this.#focusEditInputIfEditing();
  }

  /**
   * Stops following the list's scrolling and size.
   * @returns {void}
   */
  dispose() {
    this.#virtualList.dispose();
  }

  /**
   * The windowed list rendering the messages into the list element.
   * @returns {VirtualList} The list.
   */
  #createVirtualList() {
    return new VirtualList({
      scrollElement: this.#listElement,
      contentElement: this.#listElement,
      gap: MessageListView.#MESSAGE_GAP,
      estimatedHeight: MessageListView.#ESTIMATED_MESSAGE_HEIGHT,
      renderItems: (start, end) => this.#messagesHtml(start, end),
      emptyHtml: () => '<div class="claude-plus-empty-state claude-plus-empty-state--padded">Start a conversation using the message box below.</div>',
      onItemsRendered: (elements, from) => this.#onMessagesRendered(elements, from),
      followsEnd: true,
      endDistance: LIMITS.followOutputDistance,
    });
  }

  /**
   * Forgets the measured message heights when the list now shows a different conversation.
   * @returns {void}
   */
  #resetForNewConversation() {
    const conversationId = this.#session.openConversationId;
    if (conversationId === this.#renderedConversationId) return;
    this.#renderedConversationId = conversationId;
    this.#virtualList.reset();
  }

  /**
   * HTML of a run of messages.
   * @param {number} start Index of the first message.
   * @param {number} end Index after the last message.
   * @returns {string} The messages.
   */
  #messagesHtml(start, end) {
    const messages = this.#session.messages;
    let html = '';
    for (let index = start; index < end; index += 1) html += this.#messageHtml(messages[index], index, index === this.#retryableIndex);
    return html;
  }

  /**
   * Starts filling the widget slots of messages that just entered the window.
   * @param {HTMLElement[]} elements The new message elements.
   * @param {number} from Position of the first one.
   * @returns {void}
   */
  #onMessagesRendered(elements, from) {
    elements.forEach((element, offset) => this.#fillWidgetSlotsIn(element, this.#session.messages[from + offset]));
  }

  /**
   * Scrolls a message into view and briefly highlights it, if it's part of the branch shown; does
   * nothing when it belongs to a different branch (an edit or retry from before this conversation
   * was exported), rather than switching branches to find it.
   * @param {string} messageId Message id.
   * @returns {void}
   */
  scrollToMessage(messageId) {
    const index = this.#session.messages.findIndex(message => message.id === messageId);
    if (index === -1) return;
    this.#virtualList.scrollToIndex(index, 'center');
    const element = this.#virtualList.elementAt(index);
    if (!element) return;
    element.classList.add('claude-plus-message--highlighted');
    setTimeout(() => element.classList.remove('claude-plus-message--highlighted'), TIMING.messageHighlightMs);
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
    this.#changedMessages.forEach(message => this.#renderMessageBody(message));
    this.#changedMessages.clear();
    this.#virtualList.keepEndInView();
  }

  /**
   * Re-renders one message's body, if it is still shown.
   * @param {ChatMessage} message The message.
   * @returns {void}
   */
  #renderMessageBody(message) {
    const index = this.#session.messages.indexOf(message);
    const container = this.#listElement.querySelector(`[data-message-index="${index}"]`);
    const body = container ? container.querySelector('.claude-plus-message__body') : null;
    if (body) body.innerHTML = MessageListView.#messageBodyHtml(message);
    if (container) this.#fillWidgetSlotsIn(container, message);
  }

  /**
   * Starts filling one message's widget slots with their real cards.
   * @param {HTMLElement} container The message's element.
   * @param {ChatMessage} message The message.
   * @returns {void}
   */
  #fillWidgetSlotsIn(container, message) {
    const conversationId = this.#session.openConversationId;
    message.widgets.forEach(job => this.#fillWidgetSlot(container, conversationId, job));
  }

  /**
   * Fills one widget's placeholder slot with its real, extracted card.
   * @param {HTMLElement} container The message's element.
   * @param {?string} conversationId Conversation the widget's message belongs to.
   * @param {{toolName: string, data: object, toolUseId: string}} job The widget to render.
   * @returns {void}
   */
  #fillWidgetSlot(container, conversationId, job) {
    const slot = container.querySelector(`[data-widget-key="${CSS.escape(job.toolUseId)}"]`);
    if (slot) this.#widgetExtractor.render(slot, conversationId, job);
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
    const editButton = this.#editButtonHtml(sender, message);
    const retryButton = offersRetry ? '<button class="claude-plus-message__action-button" data-action="retry" title="Retry">🔁</button>' : '';
    const toolStepsButton = MessageListView.#toolStepsButtonHtml(message);
    return `
      <div class="claude-plus-message__actions">
        ${branchNavHtml}
        <button class="claude-plus-message__action-button" data-action="copy" title="Copy">📋</button>
        ${editButton}
        ${retryButton}
        ${toolStepsButton}
      </div>`;
  }

  /**
   * The edit-and-branch button, for a persisted human message in a conversation that isn't read-only.
   * @param {'human'|'assistant'} sender The message's sender.
   * @param {ChatMessage} message The message.
   * @returns {string} The button, or an empty string when it doesn't apply.
   */
  #editButtonHtml(sender, message) {
    return sender === 'human' && this.#isEditable(message)
      ? '<button class="claude-plus-message__action-button" data-action="startEdit" title="Edit and branch from here">✎</button>' : '';
  }

  /**
   * Whether a message can be edited: persisted, and not part of a read-only (imported) conversation.
   * @param {?ChatMessage} message The message.
   * @returns {boolean} True when it can be edited.
   */
  #isEditable(message) {
    return Boolean(message?.isPersisted) && !this.#session.isReadOnly;
  }

  /**
   * A lightbulb button opening the message's thinking and tool-call steps, when it has any.
   * @param {ChatMessage} message The message.
   * @returns {string} The button, or an empty string when the message has no steps.
   */
  static #toolStepsButtonHtml(message) {
    return MessageToolSteps.stepsOf(message.apiMessage).length > 0
      ? '<button class="claude-plus-message__action-button" data-action="toolSteps" title="Thinking and tool calls">💡</button>' : '';
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
   * Shows the floating Reply button above a new, non-empty text selection inside one message, or
   * hides it otherwise.
   * @returns {void}
   */
  #onSelectionMaybeChanged() {
    const context = this.#selectionContext();
    if (context) this.#replyButton.show(context.rect, () => this.#session.requestQuote(context.text, context.sender));
    else this.#replyButton.hide();
  }

  /**
   * The current selection's text, sender and bounding rectangle, if it qualifies for a Reply button.
   * @returns {?{text: string, sender: string, rect: DOMRect}} The context, or null.
   */
  #selectionContext() {
    const selection = window.getSelection();
    if (!this.#isQuotableSelection(selection)) return null;
    const message = this.#messageAt(selection.anchorNode);
    const text = selection.toString().trim();
    return message && text ? { text, sender: message.sender, rect: selection.getRangeAt(0).getBoundingClientRect() } : null;
  }

  /**
   * Whether a selection is worth offering a Reply button for: not collapsed, inside this list, and
   * the conversation isn't read-only (there would be nothing to send the quote with).
   * @param {?Selection} selection The current selection.
   * @returns {boolean} True when it qualifies.
   */
  #isQuotableSelection(selection) {
    return !this.#session.isReadOnly && Boolean(selection) && !selection.isCollapsed && this.#listElement.contains(selection.anchorNode);
  }

  /**
   * The message a selection node belongs to.
   * @param {Node} node A node inside a message element; nodeType 3 is a text node, which has no
   * closest() of its own.
   * @returns {?ChatMessage} The message, or null when not found.
   */
  #messageAt(node) {
    const element = node.nodeType === 3 ? node.parentElement : node;
    const messageElement = element.closest('.claude-plus-message');
    return messageElement ? this.#session.messages[Number(messageElement.dataset.messageIndex)] : null;
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
    if (this.#isEditable(this.#session.messages[index])) this.#startEdit(index);
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
   * Shows a message's thinking and tool-call steps.
   * @param {HTMLElement} button The clicked lightbulb button.
   * @returns {void}
   */
  #showToolSteps(button) {
    const message = this.#session.messages[MessageListView.#indexOf(button)];
    if (message) this.#onShowToolSteps(message);
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

}
