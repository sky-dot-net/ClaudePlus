import { ChatMessage } from '../../vendors/anthropic/chat/ChatMessage.js';
import { LOG_PREFIX } from '../../config/LOG_PREFIX.js';
import { ROOT_MESSAGE_UUID } from '../../vendors/anthropic/config/ROOT_MESSAGE_UUID.js';
import { StreamEventApplier } from '../../vendors/anthropic/chat/StreamEventApplier.js';
import { Turn } from '../Turn.js';
import { createErrorNotice } from '../createErrorNotice.js';
import { createLocalMessageId } from '../createLocalMessageId.js';

/**
 * Sends a chat session's prompts: shows the prompt, streams the reply into the chat, reports a
 * failure and, once the server has the prompt, reloads the conversation from the server.
 */
export class ChatReplySender {
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
   * The session's state.
   * @type {ChatSessionState}
   */
  #state;

  /**
   * Refreshes the conversation from the server once a send has ended.
   * @type {function(string, boolean): Promise<void>}
   */
  #reloadAfterSend;

  /**
   * Aborts the prompt being sent.
   * @type {?AbortController}
   */
  #abortController = null;

  /**
   * Applies completion stream events to the turn being sent.
   * @type {StreamEventApplier}
   */
  #streamEvents;

  /**
   * Creates the sender.
   * @param {object} parts Sender parts.
   * @param {ClaudeApi} parts.api API client.
   * @param {ComposerSettings} parts.settings Model options for new prompts.
   * @param {ChatSessionState} parts.state The session's state.
   * @param {function(string, string): void} parts.registerNewConversation Lists a just-created conversation and makes it the open one.
   * @param {function(string, boolean): Promise<void>} parts.reloadAfterSend Refreshes the conversation from the server once a send has ended.
   * @param {function(string, *=): void} parts.publish Publishes a session event with an optional payload.
   */
  constructor({ api, settings, state, registerNewConversation, reloadAfterSend, publish }) {
    this.#api = api;
    this.#settings = settings;
    this.#state = state;
    this.#reloadAfterSend = reloadAfterSend;
    this.#streamEvents = new StreamEventApplier({ appendMessage: message => state.setMessages([...state.messages, message]), registerNewConversation, publish });
  }

  /**
   * Aborts the reply in progress, keeping the text received so far.
   * @returns {void}
   */
  stop() {
    if (this.#abortController) this.#abortController.abort();
  }

  /**
   * Sends a prompt as a reply to a given message and streams the answer into the chat. Ignored for
   * a blank prompt, while sending, or in an imported conversation.
   * @param {string} prompt Prompt text.
   * @param {?string} parentMessageId Message to reply to; null for the conversation root.
   * @param {UploadedFile[]} files Files uploaded beforehand to attach.
   * @param {?{text: string, sender: string}} quote Text quoted from an earlier message, if any.
   * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
   */
  async sendAfter(prompt, parentMessageId, files, quote) {
    if (!prompt.trim() || this.#state.isSending || this.#state.isImported) return;
    const turn = this.#beginTurn(prompt, parentMessageId, files, quote);
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
   * @param {?{text: string, sender: string}} quote Text quoted from an earlier message, if any.
   * @returns {Turn} The new turn.
   */
  #beginTurn(prompt, parentMessageId, files, quote) {
    const promptMessage = new ChatMessage({
      id: createLocalMessageId(), parentId: parentMessageId, sender: 'human', text: prompt, isPersisted: false,
      apiMessage: files.length || quote ? ChatMessage.draftApiMessage(prompt, files, quote) : null,
    });
    const turn = new Turn({
      conversationId: this.#state.targetConversationId,
      isNewConversation: this.#state.openConversationId === null,
      prompt,
      promptMessage,
      files,
      quote,
      abortController: new AbortController(),
    });
    this.#abortController = turn.abortController;
    this.#state.setMessages([...this.#state.messages, promptMessage]);
    this.#state.setSending(true);
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
      fileUuids: ChatMessage.fileUuidsOf(turn.files),
      attachments: turn.quote ? [ChatMessage.quoteAttachment(turn.quote)] : [],
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
    else this.#state.messages.push(createErrorNotice(error.message));
  }

  /**
   * Ends sending and, if the server accepted the prompt, reloads the conversation from the server.
   * @param {Turn} turn The turn.
   * @returns {void}
   */
  #finishTurn(turn) {
    if (turn.replyMessage) turn.replyMessage.isStreaming = false;
    if (this.#abortController === turn.abortController) this.#abortController = null;
    this.#state.setSending(false);
    this.#state.setMessages(this.#state.messages);
    if (turn.promptMessage.isPersisted) this.#reloadAfterSend(turn.conversationId, !turn.hasFailed);
  }
}
