import { ChatMessage } from './ChatMessage.js';
import { ConversationTree } from './ConversationTree.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { LOG_PREFIX } from '../config/LOG_PREFIX.js';
import { ROOT_MESSAGE_UUID } from '../config/ROOT_MESSAGE_UUID.js';
import { STREAM_START } from '../config/STREAM_START.js';
import { Turn } from './Turn.js';
import { createLocalMessageId } from './createLocalMessageId.js';

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
   * Incremented on every navigation, so late responses for an old one are dropped.
   * @type {number}
   */
  #navigationCount = 0;

  /**
   * Handler per stream event type.
   * @type {Map<string, function(Turn, object): void>}
   */
  #streamEventHandlers = new Map([
    [STREAM_START, (turn, event) => this.#onStreamStart(turn, event)],
    ['content_block_delta', (turn, event) => this.#onContentDelta(turn, event)],
    ['message_limit', (turn, event) => this.#onMessageLimit(event)],
    ['message_stop', turn => this.#onMessageStop(turn)],
  ]);

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
   * Opens a conversation, stopping any reply in progress. A load failure is shown as an error notice.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<void>} Resolves once the messages or the error notice are shown.
   */
  async openConversation(conversationId) {
    const navigation = this.#beginNavigation(conversationId);
    try {
      const conversation = await this.#api.getConversation(conversationId);
      if (this.#isLatestNavigation(navigation)) this.#showConversation(conversation);
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
    this.#navigationCount += 1;
    this.#setOpenConversation(conversationId);
    this.#setMessages([]);
    return this.#navigationCount;
  }

  /**
   * Whether a navigation is still the latest one.
   * @param {number} navigation Number returned by #beginNavigation.
   * @returns {boolean} True if no navigation happened since.
   */
  #isLatestNavigation(navigation) {
    return navigation === this.#navigationCount;
  }

  /**
   * Shows a conversation load failure, unless the user has navigated away since.
   * @param {number} navigation Number of the failed navigation.
   * @param {Error} error The failure.
   * @returns {void}
   */
  #showLoadError(navigation, error) {
    if (!this.#isLatestNavigation(navigation)) return;
    console.warn(LOG_PREFIX, 'loading conversation failed', error);
    this.#setMessages([ChatSession.#createErrorNotice(`Could not load this conversation (${error.message}).`)]);
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
    for await (const event of events) this.#handleStreamEvent(turn, event);
  }

  /**
   * Applies one stream event; unknown types are ignored.
   * @param {Turn} turn The turn.
   * @param {StreamEvent} event The event.
   * @returns {void}
   */
  #handleStreamEvent(turn, event) {
    const handleEvent = this.#streamEventHandlers.get(event.type);
    if (handleEvent) handleEvent(turn, event);
  }

  /**
   * Marks the prompt as accepted and adds the empty reply; registers a new conversation.
   * @param {Turn} turn The turn.
   * @param {{humanMessageId: string, assistantMessageId: string}} event The STREAM_START event.
   * @returns {void}
   */
  #onStreamStart(turn, event) {
    turn.promptMessage.id = event.humanMessageId;
    turn.promptMessage.isPersisted = true;
    turn.replyMessage = new ChatMessage({ id: event.assistantMessageId, parentId: event.humanMessageId, sender: 'assistant', isStreaming: true });
    if (turn.isNewConversation) this.#registerNewConversation(turn.conversationId, turn.prompt);
    this.#setMessages([...this.#messages, turn.replyMessage]);
  }

  /**
   * Appends streamed reply text.
   * @param {Turn} turn The turn.
   * @param {{delta: ?{type: string, text: string}}} event A content_block_delta event.
   * @returns {void}
   */
  #onContentDelta(turn, event) {
    if (!turn.replyMessage || !ChatSession.#isTextDelta(event)) return;
    turn.replyMessage.appendText(event.delta.text);
    this.publish('messageContent', turn.replyMessage);
  }

  /**
   * Whether a content_block_delta event carries text.
   * @param {{delta: ?{type: string}}} event The event.
   * @returns {boolean} True for text deltas.
   */
  static #isTextDelta(event) {
    return Boolean(event.delta) && event.delta.type === 'text_delta';
  }

  /**
   * Publishes the usage windows reported during the stream.
   * @param {{message_limit: ?{windows: ?Object<string, UsageWindow>}}} event A message_limit event.
   * @returns {void}
   */
  #onMessageLimit(event) {
    const windows = event.message_limit ? event.message_limit.windows : null;
    if (windows) this.publish('rateLimits', { fiveHour: windows['5h'], sevenDay: windows['7d'] });
  }

  /**
   * Marks the reply as complete.
   * @param {Turn} turn The turn.
   * @returns {void}
   */
  #onMessageStop(turn) {
    if (!turn.replyMessage) return;
    turn.replyMessage.isStreaming = false;
    this.publish('messageContent', turn.replyMessage);
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
    else this.#messages.push(ChatSession.#createErrorNotice(error.message));
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
      if (replaceMessages && this.#isOpenAndIdle(conversationId)) this.#setMessages(ChatSession.#branchMessages(conversation));
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
    this.#setMessages(ChatSession.#branchMessages(conversation));
    this.publish('conversationLoaded', conversation);
  }

  /**
   * Chat messages of a conversation's current branch.
   * @param {ApiConversation} conversation The conversation.
   * @returns {ChatMessage[]} The messages, oldest first.
   */
  static #branchMessages(conversation) {
    return ConversationTree.currentBranch(conversation).map(apiMessage => ChatMessage.fromApi(apiMessage));
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
   * Creates a local assistant message showing an error.
   * @param {string} errorText Error text.
   * @returns {ChatMessage} The notice.
   */
  static #createErrorNotice(errorText) {
    return new ChatMessage({ id: createLocalMessageId(), sender: 'assistant', isPersisted: false, errorText });
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
