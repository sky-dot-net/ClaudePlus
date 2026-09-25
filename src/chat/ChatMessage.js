import { MessageContent } from './MessageContent.js';

/**
 * One message as shown in the chat. Messages with isPersisted = false exist only locally (a
 * prompt the server never accepted, or an error notice) and are never used as a parent.
 */
export class ChatMessage {
  /**
   * Values of fields not given to the constructor.
   * @type {object}
   */
  static #DEFAULTS = Object.freeze({ parentId: null, text: '', apiMessage: null, isPersisted: true, isStreaming: false, errorText: null });

  /**
   * Cached HTML; null when it must be re-rendered.
   * @type {?string}
   */
  #cachedHtml = null;

  /**
   * Creates a message.
   * @param {object} fields Message fields; omitted ones take the defaults in parentheses.
   * @param {string} fields.id Message id.
   * @param {string} fields.sender 'human' or 'assistant'.
   * @param {?string} [fields.parentId] Parent message id (null).
   * @param {string} [fields.text] Plain text ('').
   * @param {?ApiMessage} [fields.apiMessage] API message to render instead of the text (null).
   * @param {boolean} [fields.isPersisted] Whether the server has the message (true).
   * @param {boolean} [fields.isStreaming] Whether text is still arriving (false).
   * @param {?string} [fields.errorText] Error shown under the message (null).
   */
  constructor(fields) {
    const values = { ...ChatMessage.#DEFAULTS, ...fields };
    this.id = values.id;
    this.sender = values.sender;
    this.parentId = values.parentId;
    this.text = values.text;
    this.apiMessage = values.apiMessage;
    this.isPersisted = values.isPersisted;
    this.isStreaming = values.isStreaming;
    this.errorText = values.errorText;
  }

  /**
   * Creates a message from its API representation.
   * @param {ApiMessage} apiMessage The API message.
   * @returns {ChatMessage} The persisted message.
   */
  static fromApi(apiMessage) {
    return new ChatMessage({
      id: apiMessage.uuid,
      parentId: apiMessage.parent_message_uuid ?? null,
      sender: apiMessage.sender,
      text: MessageContent.plainText(apiMessage),
      apiMessage,
    });
  }

  /**
   * Rendered content, cached until the text changes.
   * @returns {string} HTML of the API message, or of the plain text for local messages.
   */
  get html() {
    this.#cachedHtml ??= this.apiMessage ? MessageContent.toHtml(this.apiMessage) : MessageContent.textHtml(this.text);
    return this.#cachedHtml;
  }

  /**
   * Appends streamed text.
   * @param {string} addedText Text to append.
   * @returns {void}
   */
  appendText(addedText) {
    this.text += addedText;
    this.#cachedHtml = null;
  }
}
