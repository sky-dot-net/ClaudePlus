import { ATTACHMENT_NAME_FIELDS } from '../config/ATTACHMENT_NAME_FIELDS.js';
import { Markdown } from '../text/Markdown.js';
import { StyleRegistry } from '../styles/StyleRegistry.js';
import { escapeHtml } from '../text/escapeHtml.js';
import stylesheet from './MessageContent.css';

StyleRegistry.register(stylesheet);

/**
 * Reads text, uploads and renderable HTML from API messages. Thinking and tool-call blocks are
 * deliberately not rendered here: they show in the message's "thinking and tool calls" sub-pane
 * instead (see MessageToolSteps), not inline in the chat log.
 */
export class MessageContent {
  /**
   * Shown for an API message with nothing to render.
   * @type {string}
   */
  static #NO_CONTENT_HTML = '<div class="claude-plus-message-text claude-plus-empty-state">(no content)</div>';

  /**
   * Uploaded attachments and files of a message.
   * @param {ApiMessage} apiMessage The message.
   * @returns {object[]} The uploads, without empty entries.
   */
  static uploads(apiMessage) {
    return [...(apiMessage.attachments ?? []), ...(apiMessage.files ?? [])].filter(Boolean);
  }

  /**
   * Display name of an upload.
   * @param {object} upload The upload.
   * @returns {string} The first name field present, or "(uploaded file)".
   */
  static uploadName(upload) {
    return ATTACHMENT_NAME_FIELDS.map(field => upload[field]).find(Boolean) ?? '(uploaded file)';
  }

  /**
   * Plain text of a message: its text field, or its text blocks joined by line breaks.
   * @param {ApiMessage} apiMessage The message.
   * @returns {string} The text; empty when there is none.
   */
  static plainText(apiMessage) {
    return apiMessage.text || MessageContent.#textBlocks(apiMessage).map(block => block.text).join('\n');
  }

  /**
   * HTML of a text passage rendered as markdown.
   * @param {?string} text The text.
   * @returns {string} The HTML, or an empty string for empty text.
   */
  static textHtml(text) {
    return text ? `<div class="claude-plus-message-text">${Markdown.toHtml(text)}</div>` : '';
  }

  /**
   * HTML of a whole API message, kept apart so uploads can be shown above the message rather than
   * inside it: its uploads (image gallery, then file chips), and separately its text and tool blocks.
   * @param {ApiMessage} apiMessage The message.
   * @returns {{attachmentsHtml: string, bodyHtml: string}} The uploads' HTML (empty if none), and
   * the text/blocks' HTML (a "(no content)" placeholder if the message has neither).
   */
  static contentParts(apiMessage) {
    const uploads = MessageContent.uploads(apiMessage);
    const attachmentsHtml = [
      MessageContent.#imageGalleryHtml(uploads.filter(upload => MessageContent.#isImageUpload(upload))),
      ...uploads.filter(upload => !MessageContent.#isImageUpload(upload)).map(upload => MessageContent.#fileAttachmentHtml(upload)),
    ].join('');
    const bodyHtml = [
      MessageContent.#textFieldHtml(apiMessage),
      ...MessageContent.#textBlocks(apiMessage).map(block => MessageContent.textHtml(block.text)),
    ].join('');
    return { attachmentsHtml, bodyHtml: bodyHtml || (attachmentsHtml ? '' : MessageContent.#NO_CONTENT_HTML) };
  }

  /**
   * HTML of a message's image uploads, laid out in a horizontal row rather than stacked.
   * @param {object[]} imageUploads The image uploads, if any.
   * @returns {string} The gallery, or an empty string when there are none.
   */
  static #imageGalleryHtml(imageUploads) {
    if (imageUploads.length === 0) return '';
    return `<div class="claude-plus-message-images">${imageUploads.map(upload => MessageContent.#imageUploadHtml(upload)).join('')}</div>`;
  }

  /**
   * Whether an upload is an image with a URL to display.
   * @param {object} upload The upload.
   * @returns {boolean} True for an image upload.
   */
  static #isImageUpload(upload) {
    return upload.file_kind === 'image' && Boolean(upload.preview_url);
  }

  /**
   * HTML of an inline image upload: capped at 300px tall, opening the full-size viewer on click.
   * @param {object} upload The image upload.
   * @returns {string} The HTML.
   */
  static #imageUploadHtml(upload) {
    const src = escapeHtml(upload.preview_url);
    const name = escapeHtml(MessageContent.uploadName(upload));
    return `<img class="claude-plus-message-image" src="${src}" data-action="openImage" data-full-src="${src}" alt="${name}" loading="lazy" />`;
  }

  /**
   * HTML of a non-image upload, shown as a plain named chip.
   * @param {object} upload The upload.
   * @returns {string} The HTML.
   */
  static #fileAttachmentHtml(upload) {
    return `<div class="claude-plus-message-attachment">📎 ${escapeHtml(MessageContent.uploadName(upload))}</div>`;
  }

  /**
   * HTML of the text field, used only when the message has no text blocks, so text isn't shown twice.
   * @param {ApiMessage} apiMessage The message.
   * @returns {string} The HTML, or an empty string.
   */
  static #textFieldHtml(apiMessage) {
    return MessageContent.#textBlocks(apiMessage).length === 0 ? MessageContent.textHtml(apiMessage.text) : '';
  }

  /**
   * Text blocks of a message that contain text.
   * @param {ApiMessage} apiMessage The message.
   * @returns {ContentBlock[]} The blocks.
   */
  static #textBlocks(apiMessage) {
    return (apiMessage.content ?? []).filter(block => block.type === 'text' && block.text);
  }

}
