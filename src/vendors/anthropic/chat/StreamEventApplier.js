import { ChatMessage } from './ChatMessage.js';
import { STREAM_START } from '../config/STREAM_START.js';

/**
 * Applies the events of a completion stream to a turn: the start adds the empty reply, text deltas
 * extend it, usage windows are published and the stop completes it. Unknown event types are ignored.
 */
export class StreamEventApplier {
  /**
   * Handler per stream event type.
   * @type {Map<string, function(Turn, object): void>}
   */
  #handlersByType = new Map([
    [STREAM_START, (turn, event) => this.#onStreamStart(turn, event)],
    ['content_block_delta', (turn, event) => this.#onContentDelta(turn, event)],
    ['message_limit', (turn, event) => this.#onMessageLimit(event)],
    ['message_stop', turn => this.#onMessageStop(turn)],
  ]);

  /**
   * Adds a message to the end of the session's message list.
   * @type {function(ChatMessage): void}
   */
  #appendMessage;

  /**
   * Lists a just-created conversation and makes it the open one.
   * @type {function(string, string): void}
   */
  #registerNewConversation;

  /**
   * Publishes a session event.
   * @type {function(string, *): void}
   */
  #publish;

  /**
   * Creates the applier.
   * @param {object} callbacks Effects on the session.
   * @param {function(ChatMessage): void} callbacks.appendMessage Adds a message to the end of the session's message list.
   * @param {function(string, string): void} callbacks.registerNewConversation Lists a just-created conversation by id and first prompt, and makes it the open one.
   * @param {function(string, *): void} callbacks.publish Publishes a session event with a payload.
   */
  constructor({ appendMessage, registerNewConversation, publish }) {
    this.#appendMessage = appendMessage;
    this.#registerNewConversation = registerNewConversation;
    this.#publish = publish;
  }

  /**
   * Applies one stream event.
   * @param {Turn} turn The turn the stream belongs to.
   * @param {StreamEvent} event The event.
   * @returns {void}
   */
  apply(turn, event) {
    const handleEvent = this.#handlersByType.get(event.type);
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
    this.#appendMessage(turn.replyMessage);
  }

  /**
   * Appends streamed reply text.
   * @param {Turn} turn The turn.
   * @param {{delta: ?{type: string, text: string}}} event A content_block_delta event.
   * @returns {void}
   */
  #onContentDelta(turn, event) {
    if (!turn.replyMessage || !StreamEventApplier.#isTextDelta(event)) return;
    turn.replyMessage.appendText(event.delta.text);
    this.#publish('messageContent', turn.replyMessage);
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
    if (windows) this.#publish('rateLimits', { fiveHour: windows['5h'], sevenDay: windows['7d'] });
  }

  /**
   * Marks the reply as complete.
   * @param {Turn} turn The turn.
   * @returns {void}
   */
  #onMessageStop(turn) {
    if (!turn.replyMessage) return;
    turn.replyMessage.isStreaming = false;
    this.#publish('messageContent', turn.replyMessage);
  }
}
