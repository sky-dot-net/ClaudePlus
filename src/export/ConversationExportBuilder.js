import { ConversationTree } from '../chat/ConversationTree.js';
import { MessageContent } from '../chat/MessageContent.js';
import { UNTITLED } from '../config/UNTITLED.js';

/**
 * Converts an API conversation into the format-neutral ExportedConversation.
 */
export class ConversationExportBuilder {
  /**
   * Converter per API content block type; other types are kept whole as 'other' blocks.
   * @type {Map<string, function(ContentBlock): ExportedBlock>}
   */
  static #BLOCK_CONVERTERS = new Map([
    ['text', block => ({ type: 'text', text: block.text || '' })],
    ['tool_use', block => ({ type: 'toolCall', name: block.name || null, input: block.input ?? null })],
    ['tool_result', block => ({ type: 'toolResult', name: block.name || null, content: block.content ?? null })],
  ]);

  /**
   * Converts the branch of a conversation that claude.ai shows.
   * @param {ApiConversation} conversation The conversation, with every message.
   * @returns {ExportedConversation} The exportable conversation.
   */
  static build(conversation) {
    return {
      id: conversation.uuid,
      title: conversation.name || UNTITLED,
      createdAt: conversation.created_at ?? null,
      updatedAt: conversation.updated_at,
      exportedAt: new Date().toISOString(),
      messages: ConversationTree.currentBranch(conversation).map(message => ConversationExportBuilder.#convertMessage(message)),
    };
  }

  /**
   * Converts one message.
   * @param {ApiMessage} message The message.
   * @returns {ExportedMessage} The exportable message.
   */
  static #convertMessage(message) {
    return {
      id: message.uuid,
      parentId: message.parent_message_uuid ?? null,
      sender: message.sender,
      createdAt: message.created_at ?? null,
      attachments: MessageContent.uploads(message).map(upload => MessageContent.uploadName(upload)),
      blocks: ConversationExportBuilder.#convertBlocks(message),
    };
  }

  /**
   * Converts a message's content blocks; a plain text field becomes a leading text block when the
   * content has no text of its own.
   * @param {ApiMessage} message The message.
   * @returns {ExportedBlock[]} The blocks, in order.
   */
  static #convertBlocks(message) {
    const blocks = (message.content ?? []).map(block => ConversationExportBuilder.#convertBlock(block));
    const hasTextBlock = blocks.some(block => block.type === 'text');
    return message.text && !hasTextBlock ? [{ type: 'text', text: message.text }, ...blocks] : blocks;
  }

  /**
   * Converts one content block.
   * @param {ContentBlock} block The block.
   * @returns {ExportedBlock} The exportable block.
   */
  static #convertBlock(block) {
    const convert = ConversationExportBuilder.#BLOCK_CONVERTERS.get(block.type);
    return convert ? convert(block) : { type: 'other', originalType: block.type, content: block };
  }
}
