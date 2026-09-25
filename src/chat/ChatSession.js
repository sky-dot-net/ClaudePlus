import { ChatMessage } from './ChatMessage.js';
import { ConversationTree } from './ConversationTree.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { LOG_PREFIX } from '../config/LOG_PREFIX.js';
import { NavigationCounter } from './NavigationCounter.js';
import { ROOT_MESSAGE_UUID } from '../config/ROOT_MESSAGE_UUID.js';
import { StreamEventApplier } from './StreamEventApplier.js';
import { Turn } from './Turn.js';
import { createErrorNotice } from './createErrorNotice.js';
import { createLocalMessageId } from './createLocalMessageId.js';
import { currentBranchMessages } from './currentBranchMessages.js';

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
   * Model options for new prompts.
   * @type {ComposerSettings}
   */
  #settings;

  /**
   * Shared conversation list, updated when this session creates or reloads a conversation.
   * @type {ConversationDirectory}
   */
  #directory;

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
   * Whether a prompt is being sent.
   * @type {boolean}
   */
  #isSending = false;

  /**
   * Aborts the prompt being sent.
   * @type {?AbortController}
   */
  #abortController = null;

  /**
   * Numbers navigations, so late responses for an old one are dropped.
   * @type {NavigationCounter}
   */
  #navigations = new NavigationCounter();

  /**
   * Applies completion stream events to the turn being sent.
   * @type {StreamEventApplier}
   */
  #streamEvents = new StreamEventApplier({
    appendMessage: message => this.#setMessages([...this.#messages, message]),
    registerNewConversation: (conversationId, prompt) => this.#registerNewConversation(conversationId, prompt),
    publish: (eventName, payload) => this.publish(eventName, payload),
  });

  /**
   * Creates an empty session showing a new chat.
   * @param {ClaudeApi} api API client.
   * @param {ComposerSettings} settings Model options for new prompts.
   * @param {ConversationDirectory} directory Shared conversation list.
   */
  constructor(api, settings, directory) {
    super();
    this.#api = api;
    this.#settings = settings;
    this.#directory = directory;
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
   * Whether a prompt is being sent.
   * @returns {boolean} True while sending.
   */
  get isSending() {
    return this.#isSending;
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
   * Uploads a file to the conversation a prompt sent right now would use.
   * @param {File} file File to upload.
   * @returns {Promise<UploadedFile>} The server's record of the upload.
   * @throws {ApiError} When the request fails.
   */
  uploadFile(file) {
    return this.#api.uploadFile(this.targetConversationId, file);
  }

  /**
   * Position of a message among its siblings (its other edits or retries), for a branch-switch
   * control. Null when it has no siblings besides itself, or before the conversation has loaded.
   * @param {string} messageId Message id.
   * @returns {?{index: number, count: number}} Its zero-based position and the sibling count, or null.
   */
  branchInfoFor(messageId) {
    if (!this.#conversation) return null;
    const siblings = ConversationTree.siblingsOf(this.#conversation, messageId);
    if (siblings.length <= 1) return null;
    return { index: siblings.findIndex(sibling => sibling.uuid === messageId), count: siblings.length };
  }

  /**
   * Switches to a sibling version of a message (an edit or a retried reply), landing on that
   * version's latest leaf, and persists the choice server-side. Ignored while sending, before the
   * conversation has loaded, or when there is no sibling in that direction.
   * @param {string} messageId Message id.
   * @param {number} step -1 for the previous version, +1 for the next.
   * @returns {Promise<void>} Resolves once switched.
   */
  async switchBranch(messageId, step) {
    if (this.#isSending || !this.#conversation) return;
    const siblings = ConversationTree.siblingsOf(this.#conversation, messageId);
    const target = siblings[siblings.findIndex(sibling => sibling.uuid === messageId) + step];
    if (!target) return;
    const leafId = ConversationTree.latestLeafFrom(this.#conversation, target.uuid);
    await this.#api.setCurrentLeafMessage(this.#openConversationId, leafId);
    this.#conversation = { ...this.#conversation, current_leaf_message_uuid: leafId };
    this.#setMessages(currentBranchMessages(this.#conversation));
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
    const message = this.#messages[index];
    if (this.#isSending || !newText.trim() || !ChatSession.#isEditableHumanMessage(message)) return Promise.resolve();
    this.#setMessages(this.#messages.slice(0, index));
    return this.#sendPromptAfter(newText, message.parentId, []);
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
  async openConversation(conversationId) {
    const navigation = this.#beginNavigation(conversationId);
    try {
      const conversation = await this.#api.getConversation(conversationId);
      if (this.#navigations.isLatest(navigation)) this.#showConversation(conversation);
    } catch (error) {
      this.#showLoadError(navigation, error);
    }
  }

  /**
   * Switches to an empty new chat, stopping any reply in progress.
   * @returns {void}
   */
  startNewConversation() {
    this.#beginNavigation(null);
  }

  /**
   * Aborts the reply in progress, keeping the text received so far.
   * @returns {void}
   */
  stopReply() {
    if (this.#abortController) this.#abortController.abort();
  }

  /**
   * Sends a prompt as a reply to the last persisted message. Ignored while sending or for blank prompts.
   * @param {string} prompt Prompt text.
   * @param {UploadedFile[]} [files] Files uploaded beforehand to attach.
   * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
   */
  sendPrompt(prompt, files = []) {
    return this.#sendPromptAfter(prompt, this.#lastPersistedMessageIdBefore(this.#messages.length), files);
  }

  /**
   * Asks the last prompt again as a new branch from the same parent, replacing the answer shown.
   * Ignored while sending.
   * @returns {void}
   */
  retryLastPrompt() {
    if (this.#isSending) return;
    const promptIndex = this.#messages.findLastIndex(message => message.sender === 'human');
    if (promptIndex === -1) return;
    const promptMessage = this.#messages[promptIndex];
    this.#setMessages(this.#messages.slice(0, promptIndex));
    this.#sendPromptAfter(promptMessage.text, promptMessage.parentId ?? this.#lastPersistedMessageIdBefore(promptIndex), []);
  }

  /**
   * Stops any reply, clears the messages and makes a conversation (or a new chat) open.
   * @param {?string} conversationId Conversation to open, or null for a new chat.
   * @returns {number} Number identifying this navigation.
   */
  #beginNavigation(conversationId) {
    this.stopReply();
    const navigation = this.#navigations.begin();
    this.#setOpenConversation(conversationId);
    this.#conversation = null;
    this.#setMessages([]);
    return navigation;
  }

  /**
   * Shows a conversation load failure, unless the user has navigated away since.
   * @param {number} navigation Number of the failed navigation, from NavigationCounter.begin().
   * @param {Error} error The failure.
   * @returns {void}
   */
  #showLoadError(navigation, error) {
    if (!this.#navigations.isLatest(navigation)) return;
    console.warn(LOG_PREFIX, 'loading conversation failed', error);
    this.#setMessages([createErrorNotice(`Could not load this conversation (${error.message}).`)]);
  }

  /**
   * Sends a prompt as a reply to a given message and streams the answer into the chat.
   * @param {string} prompt Prompt text; ignored if blank.
   * @param {?string} parentMessageId Message to reply to; null for the conversation root.
   * @param {UploadedFile[]} files Files uploaded beforehand to attach.
   * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
   */
  async #sendPromptAfter(prompt, parentMessageId, files) {
    if (!prompt.trim() || this.#isSending) return;
    const turn = this.#beginTurn(prompt, parentMessageId, files);
    try {
      await this.#streamReply(turn);
    } catch (error) {
      this.#showSendFailure(turn, error);
    } finally {
      this.#finishTurn(turn);
    }
  }

  /**
   * Shows the prompt and marks the session as sending.
   * @param {string} prompt Prompt text.
   * @param {?string} parentMessageId Message to reply to.
   * @param {UploadedFile[]} files Files uploaded beforehand to attach.
   * @returns {Turn} The new turn.
   */
  #beginTurn(prompt, parentMessageId, files) {
    const promptMessage = new ChatMessage({
      id: createLocalMessageId(), parentId: parentMessageId, sender: 'human', text: prompt, isPersisted: false,
      apiMessage: files.length ? { text: prompt, attachments: [], files, content: [] } : null,
    });
    const turn = new Turn({
      conversationId: this.targetConversationId,
      isNewConversation: this.#openConversationId === null,
      prompt,
      promptMessage,
      files,
      abortController: new AbortController(),
    });
    this.#abortController = turn.abortController;
    this.#setMessages([...this.#messages, promptMessage]);
    this.#setSending(true);
    return turn;
  }

  /**
   * Sends the turn's prompt and applies each stream event.
   * @param {Turn} turn The turn.
   * @returns {Promise<void>} Resolves when the stream ends.
   * @throws {ApiError|DOMException} When the request fails or is aborted.
   */
  async #streamReply(turn) {
    const events = this.#api.streamCompletion({
      conversationId: turn.conversationId,
      prompt: turn.prompt,
      parentMessageId: turn.promptMessage.parentId ?? ROOT_MESSAGE_UUID,
      isNew: turn.isNewConversation,
      settings: this.#settings.snapshot(),
      fileUuids: turn.files.map(file => file.file_uuid),
      signal: turn.abortController.signal,
    });
    for await (const event of events) this.#streamEvents.apply(turn, event);
  }

  /**
   * Shows a send failure under the reply, or as a separate notice when no reply exists yet. A user
   * stop (AbortError) isn't a failure.
   * @param {Turn} turn The turn.
   * @param {Error} error The failure.
   * @returns {void}
   */
  #showSendFailure(turn, error) {
    if (error.name === 'AbortError') return;
    turn.hasFailed = true;
    console.warn(LOG_PREFIX, 'send failed', error);
    if (turn.replyMessage) turn.replyMessage.errorText = error.message;
    else this.#messages.push(createErrorNotice(error.message));
  }

  /**
   * Ends sending and, if the server accepted the prompt, reloads the conversation from the server.
   * @param {Turn} turn The turn.
   * @returns {void}
   */
  #finishTurn(turn) {
    if (turn.replyMessage) turn.replyMessage.isStreaming = false;
    if (this.#abortController === turn.abortController) this.#abortController = null;
    this.#setSending(false);
    this.publish('messages');
    if (turn.promptMessage.isPersisted) this.#reloadAfterSend(turn.conversationId, !turn.hasFailed);
  }

  /**
   * Fetches the conversation after a send to update the list and the stats, and replaces the
   * optimistic messages with the server's copy (real tool blocks and parent ids).
   * @param {string} conversationId Conversation id.
   * @param {boolean} replaceMessages False after a failure, so the error stays on screen.
   * @returns {Promise<void>} Resolves once done; failures are logged.
   */
  async #reloadAfterSend(conversationId, replaceMessages) {
    try {
      const conversation = await this.#api.getConversation(conversationId);
      this.#directory.updateListing(conversation);
      this.publish('conversationLoaded', conversation);
      if (replaceMessages && this.#isOpenAndIdle(conversationId)) {
        this.#conversation = conversation;
        this.#setMessages(currentBranchMessages(conversation));
      }
    } catch (error) {
      console.warn(LOG_PREFIX, 'refreshing conversation failed', error);
    }
  }

  /**
   * Whether a conversation is open here and not sending.
   * @param {string} conversationId Conversation id.
   * @returns {boolean} True when its messages can be replaced safely.
   */
  #isOpenAndIdle(conversationId) {
    return this.#openConversationId === conversationId && !this.#isSending;
  }

  /**
   * Shows a fetched conversation's current branch and publishes it for the stats.
   * @param {ApiConversation} conversation The conversation.
   * @returns {void}
   */
  #showConversation(conversation) {
    this.#conversation = conversation;
    this.#setMessages(currentBranchMessages(conversation));
    this.publish('conversationLoaded', conversation);
  }

  /**
   * Lists a just-created conversation and makes it the open one.
   * @param {string} conversationId Conversation id.
   * @param {string} prompt First prompt, used as a provisional title.
   * @returns {void}
   */
  #registerNewConversation(conversationId, prompt) {
    this.#directory.registerNewConversation(conversationId, prompt);
    this.#setOpenConversation(conversationId);
  }

  /**
   * Id of the last persisted message before a position.
   * @param {number} index Position to search backwards from (exclusive).
   * @returns {?string} The id, or null when there is none.
   */
  #lastPersistedMessageIdBefore(index) {
    const message = this.#messages.slice(0, index).findLast(candidate => candidate.isPersisted);
    return message ? message.id : null;
  }

  /**
   * Changes the open conversation.
   * @param {?string} conversationId Conversation id, or null for a new chat.
   * @returns {void}
   */
  #setOpenConversation(conversationId) {
    if (this.#openConversationId === conversationId) return;
    this.#openConversationId = conversationId;
    this.#draftConversationId = null;
    this.publish('openConversation');
  }

  /**
   * Replaces the message list.
   * @param {ChatMessage[]} messages New list.
   * @returns {void}
   */
  #setMessages(messages) {
    this.#messages = messages;
    this.publish('messages');
  }

  /**
   * Changes the sending state.
   * @param {boolean} isSending Whether a prompt is being sent.
   * @returns {void}
   */
  #setSending(isSending) {
    this.#isSending = isSending;
    this.publish('sending');
  }
}
