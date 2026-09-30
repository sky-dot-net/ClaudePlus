import { currentBranchMessages } from '../../vendors/anthropic/chat/currentBranchMessages.js';

/**
 * What one chat session shows: the open conversation, its messages and whether a prompt is being
 * sent. Every change is published through the owning session, so its panels can re-render.
 */
export class ChatSessionState {
  /**
   * Publishes a session event with an optional payload.
   * @type {function(string, *=): void}
   */
  #publish;

  /**
   * Open conversation id, or null for a new chat.
   * @type {?string}
   */
  #openConversationId = null;

  /**
   * Id generated for a new chat's conversation as soon as a file is uploaded to it, so the upload
   * and the first prompt land in the same conversation. Cleared once the open conversation changes.
   * @type {?string}
   */
  #draftConversationId = null;

  /**
   * Messages of the open conversation's current branch.
   * @type {ChatMessage[]}
   */
  #messages = [];

  /**
   * The full conversation last fetched, with every branch; null for a new chat or before the first
   * load. Used to find a message's sibling versions and switch between them.
   * @type {?ApiConversation}
   */
  #conversation = null;

  /**
   * Whether the open conversation is an imported one, with no model to reply to.
   * @type {boolean}
   */
  #isImported = false;

  /**
   * Whether a prompt is being sent.
   * @type {boolean}
   */
  #isSending = false;

  /**
   * Prompt queued to send automatically once the reply in progress finishes, or null.
   * @type {?{prompt: string, files: UploadedFile[], quote: ?{text: string, sender: string}}}
   */
  #queuedPrompt = null;

  /**
   * Creates the state of an empty new chat.
   * @param {function(string, *=): void} publish Publishes a session event with an optional payload.
   */
  constructor(publish) {
    this.#publish = publish;
  }

  /**
   * Open conversation.
   * @returns {?string} Its id, or null for a new chat.
   */
  get openConversationId() {
    return this.#openConversationId;
  }

  /**
   * Messages of the open conversation.
   * @returns {ChatMessage[]} The current branch, oldest first.
   */
  get messages() {
    return this.#messages;
  }

  /**
   * The full conversation last fetched.
   * @returns {?ApiConversation} It, or null for a new chat or before the first load.
   */
  get conversation() {
    return this.#conversation;
  }

  /**
   * Whether the open conversation is an imported one.
   * @returns {boolean} True for an imported conversation.
   */
  get isImported() {
    return this.#isImported;
  }

  /**
   * Whether a prompt is being sent.
   * @returns {boolean} True while sending.
   */
  get isSending() {
    return this.#isSending;
  }

  /**
   * Prompt queued to send once the reply in progress finishes.
   * @returns {?{prompt: string, files: UploadedFile[], quote: ?{text: string, sender: string}}} It, or null.
   */
  get queuedPrompt() {
    return this.#queuedPrompt;
  }

  /**
   * Id of the conversation a file uploaded right now would belong to: the open conversation, or a
   * stable id generated on first use so an upload and the prompt that follows it share one
   * conversation, even before that conversation exists on the server.
   * @returns {string} The conversation id.
   */
  get targetConversationId() {
    return this.#openConversationId ?? (this.#draftConversationId ??= crypto.randomUUID());
  }

  /**
   * Makes a conversation (or a new chat) open, with no messages until it is shown.
   * @param {?string} conversationId Conversation id, or null for a new chat.
   * @returns {void}
   */
  reset(conversationId) {
    this.setOpenConversation(conversationId);
    this.#conversation = null;
    this.#isImported = false;
    this.setMessages([]);
    this.setQueuedPrompt(null);
  }

  /**
   * Shows a fetched conversation's current branch and publishes it for the stats.
   * @param {ApiConversation} conversation The conversation.
   * @param {boolean} isImported Whether it came from the imported store rather than the live API.
   * @returns {void}
   */
  showConversation(conversation, isImported) {
    this.#isImported = isImported;
    this.showBranchOf(conversation);
    this.#publish('conversationLoaded', { conversation, isImported });
  }

  /**
   * Shows the current branch of a conversation, keeping it for later branch switches.
   * @param {ApiConversation} conversation The conversation.
   * @returns {void}
   */
  showBranchOf(conversation) {
    this.#conversation = conversation;
    this.setMessages(currentBranchMessages(conversation));
  }

  /**
   * Changes the open conversation.
   * @param {?string} conversationId Conversation id, or null for a new chat.
   * @returns {void}
   */
  setOpenConversation(conversationId) {
    if (this.#openConversationId === conversationId) return;
    this.#openConversationId = conversationId;
    this.#draftConversationId = null;
    this.#publish('openConversation');
  }

  /**
   * Replaces the message list.
   * @param {ChatMessage[]} messages New list.
   * @returns {void}
   */
  setMessages(messages) {
    this.#messages = messages;
    this.#publish('messages');
  }

  /**
   * Changes the sending state.
   * @param {boolean} isSending Whether a prompt is being sent.
   * @returns {void}
   */
  setSending(isSending) {
    this.#isSending = isSending;
    this.#publish('sending');
  }

  /**
   * Replaces the queued prompt.
   * @param {?{prompt: string, files: UploadedFile[], quote: ?{text: string, sender: string}}} queuedPrompt The new queued prompt, or null to clear it.
   * @returns {void}
   */
  setQueuedPrompt(queuedPrompt) {
    this.#queuedPrompt = queuedPrompt;
    this.#publish('queuedPrompt');
  }

  /**
   * Whether a conversation is open here and not sending.
   * @param {string} conversationId Conversation id.
   * @returns {boolean} True when its messages can be replaced safely.
   */
  isOpenAndIdle(conversationId) {
    return this.#openConversationId === conversationId && !this.#isSending;
  }

  /**
   * Id of the last persisted message before a position.
   * @param {number} index Position to search backwards from (exclusive).
   * @returns {?string} The id, or null when there is none.
   */
  lastPersistedMessageIdBefore(index) {
    const message = this.#messages.slice(0, index).findLast(candidate => candidate.isPersisted);
    return message ? message.id : null;
  }
}
