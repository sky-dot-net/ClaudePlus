import { escapeXml } from '../../text/escapeXml.js';

/**
 * Exports a conversation as an XML document. Tool inputs, tool results and unrecognised blocks are
 * stored as escaped JSON text; text content is escaped, never wrapped in CDATA.
 */
export class XmlConversationFormat {
  /**
   * Name shown in the export menu.
   * @type {string}
   */
  static label = 'XML';

  /**
   * File extension.
   * @type {string}
   */
  static extension = 'xml';

  /**
   * MIME type.
   * @type {string}
   */
  static mimeType = 'application/xml';

  /**
   * Writer per exported block type.
   * @type {Map<string, function(ExportedBlock): string>}
   */
  static #BLOCK_WRITERS = new Map([
    ['text', block => XmlConversationFormat.#element('text', {}, block.text)],
    ['toolCall', block => XmlConversationFormat.#element('toolCall', { name: block.name }, JSON.stringify(block.input, null, 2))],
    ['toolResult', block => XmlConversationFormat.#element('toolResult', { name: block.name }, JSON.stringify(block.content, null, 2))],
    ['other', block => XmlConversationFormat.#element('contentBlock', { type: block.originalType }, JSON.stringify(block.content, null, 2))],
  ]);

  /**
   * Converts a conversation to XML.
   * @param {ExportedConversation} conversation The conversation.
   * @returns {string} The XML document with a conversation root element holding one message element per message.
   */
  static serialize(conversation) {
    const { id, title, createdAt, updatedAt, exportedAt } = conversation;
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<conversation${XmlConversationFormat.#attributes({ id, title, createdAt, updatedAt, exportedAt })}>`,
      ...conversation.messages.map(message => XmlConversationFormat.#messageXml(message)),
      '</conversation>',
      '',
    ].join('\n');
  }

  /**
   * One message element with its attachments and blocks.
   * @param {ExportedMessage} message The message.
   * @returns {string} The element.
   */
  static #messageXml(message) {
    const { id, parentId, sender, createdAt } = message;
    const children = [
      ...message.attachments.map(name => `<attachment${XmlConversationFormat.#attributes({ name })}/>`),
      ...message.blocks.map(block => XmlConversationFormat.#BLOCK_WRITERS.get(block.type)(block)),
    ];
    return [`  <message${XmlConversationFormat.#attributes({ id, parentId, sender, createdAt })}>`, ...children.map(child => `    ${child}`), '  </message>'].join('\n');
  }

  /**
   * An element with attributes and escaped text content.
   * @param {string} name Element name.
   * @param {Object<string, ?string>} attributes Attributes; null and undefined values are left out.
   * @param {?string} text Text content.
   * @returns {string} The element.
   */
  static #element(name, attributes, text) {
    return `<${name}${XmlConversationFormat.#attributes(attributes)}>${escapeXml(text)}</${name}>`;
  }

  /**
   * Attribute list of an element.
   * @param {Object<string, ?string>} attributes Attributes; null and undefined values are left out.
   * @returns {string} The attributes, each preceded by a space.
   */
  static #attributes(attributes) {
    return Object.entries(attributes)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
      .join('');
  }
}
