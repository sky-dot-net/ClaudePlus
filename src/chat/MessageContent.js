import { ATTACHMENT_NAME_FIELDS } from '../config/ATTACHMENT_NAME_FIELDS.js';
import { LIMITS } from '../config/LIMITS.js';
import { Markdown } from '../text/Markdown.js';
import { StyleRegistry } from '../styles/StyleRegistry.js';
import { escapeHtml } from '../text/escapeHtml.js';
import stylesheet from './MessageContent.css';

StyleRegistry.register(stylesheet);

/**
 * Reads text, uploads and renderable HTML from API messages.
 */
export class MessageContent {
  /**
   * Shown for an API message with nothing to render.
   * @type {string}
   */
  static #NO_CONTENT_HTML = '<div class="claude-plus-message-text claude-plus-empty-state">(no content)</div>';

  /**
   * HTML renderer per content block type.
   * @type {Map<string, function(ContentBlock): string>}
   */
  static #BLOCK_RENDERERS = new Map([
    ['text', block => MessageContent.textHtml(block.text)],
    ['tool_use', block => MessageContent.#toolCallHtml(block)],
    ['tool_result', block => MessageContent.#toolResultHtml(block)],
  ]);

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
   * HTML of a whole API message: uploads, text and tool blocks.
   * @param {ApiMessage} apiMessage The message.
   * @returns {string} The HTML, or a "(no content)" placeholder.
   */
  static toHtml(apiMessage) {
    const parts = [
      ...MessageContent.uploads(apiMessage).map(upload => MessageContent.#uploadHtml(upload)),
      MessageContent.#textFieldHtml(apiMessage),
      ...(apiMessage.content ?? []).map(block => MessageContent.#contentBlockHtml(block)),
    ];
    return parts.join('') || MessageContent.#NO_CONTENT_HTML;
  }

  /**
   * HTML of one upload: an inline, clickable image for an image upload, else a plain attachment chip.
   * @param {object} upload The upload.
   * @returns {string} The HTML.
   */
  static #uploadHtml(upload) {
    return MessageContent.#isImageUpload(upload) ? MessageContent.#imageUploadHtml(upload) : MessageContent.#fileAttachmentHtml(upload);
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

  /**
   * HTML of one content block.
   * @param {ContentBlock} block The block.
   * @returns {string} The HTML; empty for unsupported block types.
   */
  static #contentBlockHtml(block) {
    const renderBlock = MessageContent.#BLOCK_RENDERERS.get(block.type);
    return renderBlock ? renderBlock(block) : '';
  }

  /**
   * HTML of a tool call: its name, with the input in a collapsible section.
   * @param {ContentBlock} block A tool_use block.
   * @returns {string} The HTML.
   */
  static #toolCallHtml(block) {
    return MessageContent.#collapsibleHtml(`🔧 ${escapeHtml(block.name || 'tool')}`, JSON.stringify(block.input ?? {}, null, 2));
  }

  /**
   * HTML of a tool result: the titles of its items, with the truncated JSON in a collapsible section.
   * @param {ContentBlock} block A tool_result block.
   * @returns {string} The HTML.
   */
  static #toolResultHtml(block) {
    const items = Array.isArray(block.content) ? block.content : [];
    const itemLabels = items.map(item => MessageContent.#resultItemLabel(item)).filter(Boolean).join(', ');
    const summaryHtml = itemLabels ? `📄 result: ${escapeHtml(itemLabels)}` : '📄 result';
    return MessageContent.#collapsibleHtml(summaryHtml, JSON.stringify(items, null, 2).slice(0, LIMITS.toolResultCharacters));
  }

  /**
   * Short label of a tool result item.
   * @param {?object} item The item.
   * @returns {string} Its title, else its type, else an empty string.
   */
  static #resultItemLabel(item) {
    return item ? item.title || item.type || '' : '';
  }

  /**
   * HTML of a collapsible section with preformatted content.
   * @param {string} summaryHtml HTML of the always-visible summary.
   * @param {string} detailText Plain text shown when expanded.
   * @returns {string} The HTML.
   */
  static #collapsibleHtml(summaryHtml, detailText) {
    return `<details class="claude-plus-tool-details"><summary>${summaryHtml}</summary><pre>${escapeHtml(detailText)}</pre></details>`;
  }
}
