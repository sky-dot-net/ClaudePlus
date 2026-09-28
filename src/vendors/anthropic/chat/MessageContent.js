import { ATTACHMENT_NAME_FIELDS } from '../config/ATTACHMENT_NAME_FIELDS.js';
import { Markdown } from '../../../text/Markdown.js';
import { QUOTE_ATTACHMENT_NAME_PATTERN } from '../config/QUOTE_ATTACHMENT_NAME_PATTERN.js';
import { StyleRegistry } from '../../../styles/StyleRegistry.js';
import { WidgetToolCall } from './widgets/WidgetToolCall.js';
import { escapeHtml } from '../../../text/escapeHtml.js';
import stylesheet from '../../../chat/MessageContent.css';

StyleRegistry.register(stylesheet);

/**
 * Reads text, uploads and renderable HTML from API messages. Thinking and ordinary tool-call
 * blocks are deliberately not rendered here: they show in the message's "thinking and tool calls"
 * sub-pane instead (see MessageToolSteps), not inline in the chat log. A widget tool call (see
 * WIDGET_TOOL_NAMES) is different: it IS the reply, so it gets a placeholder slot here, filled in
 * later by WidgetExtractor once its real card has been extracted.
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
   * inside it: its uploads (image gallery, then file chips), and separately its text, in original
   * order with a placeholder slot wherever a widget tool call belongs.
   * @param {ApiMessage} apiMessage The message.
   * @returns {{attachmentsHtml: string, bodyHtml: string, widgets: Array<{toolName: string, data: object, toolUseId: string}>}}
   * The uploads' HTML (empty if none), the text/slots' HTML (a "(no content)" placeholder if the
   * message has neither), and the widgets awaiting extraction, in the order their slots appear.
   */
  static contentParts(apiMessage) {
    const uploads = MessageContent.uploads(apiMessage);
    const attachmentsHtml = [
      MessageContent.#imageGalleryHtml(uploads.filter(upload => MessageContent.#isImageUpload(upload))),
      ...uploads.filter(upload => !MessageContent.#isImageUpload(upload)).map(upload => MessageContent.#fileAttachmentHtml(upload)),
    ].join('');
    const blocks = apiMessage.content ?? [];
    const resultByUseId = MessageContent.#resultsByUseId(blocks);
    const rendered = blocks.map(block => MessageContent.#bodyBlock(block, resultByUseId));
    const blocksHtml = rendered.map(item => item.html).join('');
    const bodyHtml = blocksHtml || MessageContent.textHtml(apiMessage.text);
    const widgets = rendered.map(item => item.widget).filter(Boolean);
    return { attachmentsHtml, bodyHtml: bodyHtml || (attachmentsHtml ? '' : MessageContent.#NO_CONTENT_HTML), widgets };
  }

  /**
   * Tool results by the id of the call they answer, to tell a widget call that actually rendered
   * a card from one that didn't (still pending, or a failed attempt superseded by a retry).
   * @param {ContentBlock[]} blocks The message's content blocks.
   * @returns {Map<string, ContentBlock>} The results, by tool_use_id.
   */
  static #resultsByUseId(blocks) {
    return new Map(blocks.filter(block => block.type === 'tool_result').map(block => [block.tool_use_id, block]));
  }

  /**
   * HTML (and, for a rendered widget, the extraction job) of one content block.
   * @param {ContentBlock} block The block.
   * @param {Map<string, ContentBlock>} resultByUseId Tool results by the id of the call they answer.
   * @returns {{html: string, widget: ?{toolName: string, data: object, toolUseId: string}}} The
   * block's HTML, and its widget job if it is one.
   */
  static #bodyBlock(block, resultByUseId) {
    if (block.type === 'text' && block.text) return { html: MessageContent.textHtml(block.text), widget: null };
    const resultBlock = resultByUseId.get(block.id);
    if (block.type === 'tool_use' && WidgetToolCall.isRendered(block, resultBlock)) return MessageContent.#renderedToolBlock(block, resultBlock);
    return { html: '', widget: null };
  }

  /**
   * HTML (and, for a widget, the extraction job) of a tool call already known to have a card:
   * an Artifact's real HTML, resolved at import time, or an ordinary widget awaiting extraction.
   * @param {ContentBlock} useBlock The tool_use block.
   * @param {ContentBlock} resultBlock Its tool_result block.
   * @returns {{html: string, widget: ?{toolName: string, data: object, toolUseId: string}}} The block's HTML and its widget job, if it has one.
   */
  static #renderedToolBlock(useBlock, resultBlock) {
    return useBlock.name === 'Artifact' ? MessageContent.#artifactBlock(useBlock, resultBlock) : MessageContent.#widgetBlock(useBlock);
  }

  /**
   * HTML of an Artifact whose real HTML was resolved at import time: a sandboxed iframe given the
   * document directly, with no extraction step, since the whole file is already known.
   * @param {ContentBlock} useBlock The tool_use block.
   * @param {ContentBlock} resultBlock Its tool_result block, carrying the resolved HTML.
   * @returns {{html: string, widget: null}} The iframe's HTML.
   */
  static #artifactBlock(useBlock, resultBlock) {
    const srcdoc = escapeHtml(resultBlock.structured_content.resolvedArtifactHtml);
    const title = escapeHtml(useBlock.input?.title || 'Artifact');
    return { html: `<iframe class="claude-plus-artifact-frame" srcdoc="${srcdoc}" sandbox="allow-scripts" title="${title}"></iframe>`, widget: null };
  }

  /**
   * HTML and extraction job of a widget tool call's placeholder slot. The job's data is the call's
   * own input, since every widget wrapper mirrors that back as a prop and it's what the extractor
   * matches against (a tool call id isn't consistently exposed across widget types).
   * @param {ContentBlock} useBlock The tool_use block.
   * @returns {{html: string, widget: {toolName: string, data: object, toolUseId: string}}} The slot's HTML and its job.
   */
  static #widgetBlock(useBlock) {
    const widget = { toolName: useBlock.name, data: useBlock.input || {}, toolUseId: useBlock.id };
    const key = escapeHtml(widget.toolUseId);
    return { html: `<div class="claude-plus-widget-slot" data-widget-key="${key}">Loading widget…</div>`, widget };
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
   * HTML of a non-image upload: a quoted passage's own chip, or a plain named chip for anything else.
   * @param {object} upload The upload.
   * @returns {string} The HTML.
   */
  static #fileAttachmentHtml(upload) {
    return QUOTE_ATTACHMENT_NAME_PATTERN.test(MessageContent.uploadName(upload))
      ? MessageContent.#quoteAttachmentHtml(upload) : `<div class="claude-plus-message-attachment">📎 ${escapeHtml(MessageContent.uploadName(upload))}</div>`;
  }

  /**
   * HTML of a quoted passage: a small chip naming its line count, the full text available as a
   * native tooltip rather than a raw filename.
   * @param {object} upload The quote attachment.
   * @returns {string} The HTML.
   */
  static #quoteAttachmentHtml(upload) {
    const text = upload.extracted_content || '';
    const lineCount = text ? text.split('\n').length : 0;
    return `<div class="claude-plus-message-attachment claude-plus-message-attachment--quote" title="${escapeHtml(text)}">💬 Quote, ${lineCount} line${lineCount === 1 ? '' : 's'}</div>`;
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
