import { ChatBranchSwitcher } from './session/ChatBranchSwitcher.js';
import { ChatConversationLoader } from './session/ChatConversationLoader.js';
import { ChatDirectorySync } from './session/ChatDirectorySync.js';
import { ChatReplySender } from './session/ChatReplySender.js';
import { ChatSessionState } from './session/ChatSessionState.js';
import { EventEmitter } from '../core/EventEmitter.js';

/**
 * One chat: the conversation open in a chat pane, its messages and the prompt being sent. Every
 * chat pane has its own session, so several conversations can be open and streaming at once.
 * @fires ChatSession#openConversation The open conversation changed.
 * @fires ChatSession#messages The message list changed.
 * @fires ChatSession#messageContent One message's content changed; payload is the ChatMessage.
 * @fires ChatSession#sending Sending started or ended.
 * @fires ChatSession#conversationLoaded A conversation was fetched; payload is the ApiConversation.
 * @fires ChatSession#rateLimits Usage windows arrived in a stream; payload is RateLimits.
 */
export class ChatSession extends EventEmitter {
  /**
   * API client.
   * @type {ClaudeApi}
   */
  #api;

  /**
   * The open conversation, its messages and the sending state.
   * @type {ChatSessionState}
   */
  #state = new ChatSessionState((eventName, payload) => this.publish(eventName, payload));

  /**
   * Sends prompts and streams their replies.
   * @type {ChatReplySender}
   */
  #sender;

  /**
   * Switches between conversations.
   * @type {ChatConversationLoader}
   */
  #loader;

  /**
   * Switches between sibling versions of a message.
   * @type {ChatBranchSwitcher}
   */
  #branches;

  /**
   * Creates an empty session showing a new chat.
   * @param {ClaudeApi} api API client.
   * @param {ComposerSettings} settings Model options for new prompts.
   * @param {CombinedConversationDirectory} directory Shared conversation list.
   * @param {ImportedConversationStore} importedConversations Imported conversations, checked before the live API when opening one.
   */
  constructor(api, settings, directory, importedConversations) {
    super();
    const state = this.#state;
    const publish = (eventName, payload) => this.publish(eventName, payload);
    const sync = new ChatDirectorySync({ api, directory, state, publish });
    this.#api = api;
    this.#sender = new ChatReplySender({
      api, settings, state, publish,
      registerNewConversation: (conversationId, prompt) => sync.registerNewConversation(conversationId, prompt),
      reloadAfterSend: (conversationId, replaceMessages) => sync.reloadAfterSend(conversationId, replaceMessages),
    });
    this.#loader = new ChatConversationLoader({ api, importedConversations, state, stopReply: () => this.stopReply() });
    this.#branches = new ChatBranchSwitcher(api, state);
  }

  /**
   * Open conversation.
   * @returns {?string} Its id, or null for a new chat.
   */
  get openConversationId() {
    return this.#state.openConversationId;
  }

  /**
   * Messages of the open conversation.
   * @returns {ChatMessage[]} The current branch, oldest first.
   */
  get messages() {
    return this.#state.messages;
  }

  /**
   * Whether a prompt is being sent.
   * @returns {boolean} True while sending.
   */
  get isSending() {
    return this.#state.isSending;
  }

  /**
   * Whether the open conversation is read-only: an imported chat, with no model to reply to.
   * @returns {boolean} True for an imported conversation.
   */
  get isReadOnly() {
    return this.#state.isImported;
  }

  /**
   * Id of the conversation a file uploaded right now would belong to.
   * @returns {string} The conversation id.
   */
  get targetConversationId() {
    return this.#state.targetConversationId;
  }

  /**
   * Uploads a file to the conversation a prompt sent right now would use.
   * @param {File} file File to upload.
   * @returns {Promise<UploadedFile>} The server's record of the upload.
   * @throws {ApiError} When the request fails.
   */
  uploadFile(file) {
    return this.#api.uploadFile(this.targetConversationId, file);
  }

  /**
   * Position of a message among its siblings (its other edits or retries), for a branch-switch control.
   * @param {string} messageId Message id.
   * @returns {?{index: number, count: number}} Its zero-based position and the sibling count, or null.
   */
  branchInfoFor(messageId) {
    return this.#branches.branchInfoFor(messageId);
  }

  /**
   * Switches to a sibling version of a message (an edit or a retried reply).
   * @param {string} messageId Message id.
   * @param {number} step -1 for the previous version, +1 for the next.
   * @returns {Promise<void>} Resolves once switched.
   */
  switchBranch(messageId, step) {
    return this.#branches.switchBranch(messageId, step);
  }

  /**
   * Edits a persisted human message: sends the new text as a sibling reply to the same parent,
   * branching the conversation there instead of replacing what the server has. Ignored while
   * sending, for an assistant message, or for a message the server hasn't accepted yet.
   * @param {number} index Position of the message in the current branch.
   * @param {string} newText Edited text; ignored if blank.
   * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
   */
  editMessage(index, newText) {
    const message = this.#state.messages[index];
    if (this.#state.isSending || !newText.trim() || !ChatSession.#isEditableHumanMessage(message)) return Promise.resolve();
    this.#state.setMessages(this.#state.messages.slice(0, index));
    return this.#sender.sendAfter(newText, message.parentId, []);
  }

  /**
   * Whether a message can be edited: a persisted prompt from the human.
   * @param {?ChatMessage} message The message.
   * @returns {boolean} True when it can be edited.
   */
  static #isEditableHumanMessage(message) {
    return Boolean(message) && message.sender === 'human' && message.isPersisted;
  }

  /**
   * Opens a conversation, stopping any reply in progress. A load failure is shown as an error notice.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<void>} Resolves once the messages or the error notice are shown.
   */
  openConversation(conversationId) {
    return this.#loader.open(conversationId);
  }

  /**
   * Switches to an empty new chat, stopping any reply in progress.
   * @returns {void}
   */
  startNewConversation() {
    this.#loader.beginNavigation(null);
  }

  /**
   * Aborts the reply in progress, keeping the text received so far.
   * @returns {void}
   */
  stopReply() {
    this.#sender.stop();
  }

  /**
   * Sends a prompt as a reply to the last persisted message. Ignored while sending or for blank prompts.
   * @param {string} prompt Prompt text.
   * @param {UploadedFile[]} [files] Files uploaded beforehand to attach.
   * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
   */
  sendPrompt(prompt, files = []) {
    return this.#sender.sendAfter(prompt, this.#state.lastPersistedMessageIdBefore(this.#state.messages.length), files);
  }

  /**
   * Asks the last prompt again as a new branch from the same parent, replacing the answer shown.
   * Ignored while sending.
   * @returns {void}
   */
  retryLastPrompt() {
    const messages = this.#state.messages;
    const promptIndex = messages.findLastIndex(message => message.sender === 'human');
    if (this.#state.isSending || promptIndex === -1) return;
    const promptMessage = messages[promptIndex];
    this.#state.setMessages(messages.slice(0, promptIndex));
    this.#sender.sendAfter(promptMessage.text, promptMessage.parentId ?? this.#state.lastPersistedMessageIdBefore(promptIndex), []);
  }
}
