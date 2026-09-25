import { escapeHtml } from '../../text/escapeHtml.js';
import { markdownCodeFence } from '../../text/markdownCodeFence.js';

/**
 * Exports a conversation as a readable Markdown document. Message text is kept as written; tool
 * calls, tool results and unrecognised blocks become collapsible sections with their JSON.
 */
export class MarkdownConversationFormat {
  /**
   * Name shown in the export menu.
   * @type {string}
   */
  static label = 'Markdown';

  /**
   * File extension.
   * @type {string}
   */
  static extension = 'md';

  /**
   * MIME type.
   * @type {string}
   */
  static mimeType = 'text/markdown';

  /**
   * Heading name per sender.
   * @type {Readonly<Record<string, string>>}
   */
  static #SENDER_NAMES = Object.freeze({ human: 'You', assistant: 'Claude' });

  /**
   * Writer per exported block type.
   * @type {Map<string, function(ExportedBlock): string>}
   */
  static #BLOCK_WRITERS = new Map([
    ['text', block => block.text],
    ['toolCall', block => MarkdownConversationFormat.#collapsibleJson(`Tool call: ${block.name || 'tool'}`, block.input)],
    ['toolResult', block => MarkdownConversationFormat.#collapsibleJson(block.name ? `Tool result: ${block.name}` : 'Tool result', block.content)],
    ['other', block => MarkdownConversationFormat.#collapsibleJson(`Content block: ${block.originalType}`, block.content)],
  ]);

  /**
   * Converts a conversation to Markdown.
   * @param {ExportedConversation} conversation The conversation.
   * @returns {string} The document: a header with the conversation details, then one section per message.
   */
  static serialize(conversation) {
    const sections = [MarkdownConversationFormat.#headerMarkdown(conversation), ...conversation.messages.map(message => MarkdownConversationFormat.#messageMarkdown(message))];
    return `${sections.join('\n\n---\n\n')}\n`;
  }

  /**
   * Title and details of the conversation.
   * @param {ExportedConversation} conversation The conversation.
   * @returns {string} The header.
   */
  static #headerMarkdown(conversation) {
    return [
      `# ${conversation.title}`,
      '',
      `- Conversation: ${conversation.id}`,
      `- Created: ${conversation.createdAt ?? 'unknown'}`,
      `- Last updated: ${conversation.updatedAt}`,
      `- Exported: ${conversation.exportedAt}`,
    ].join('\n');
  }

  /**
   * One message: a heading with sender and time, its attachments and its blocks.
   * @param {ExportedMessage} message The message.
   * @returns {string} The section.
   */
  static #messageMarkdown(message) {
    const heading = `## ${MarkdownConversationFormat.#SENDER_NAMES[message.sender] ?? message.sender} · ${message.createdAt ?? 'unknown time'}`;
    const attachments = message.attachments.length ? `Attachments: ${message.attachments.join(', ')}` : '';
    const blocks = message.blocks.map(block => MarkdownConversationFormat.#BLOCK_WRITERS.get(block.type)(block));
    return [heading, attachments, ...blocks].filter(Boolean).join('\n\n');
  }

  /**
   * A collapsible section holding a value as pretty-printed JSON.
   * @param {string} summary Always-visible summary text.
   * @param {*} value Value to show.
   * @returns {string} The section as HTML details wrapping a JSON code block.
   */
  static #collapsibleJson(summary, value) {
    return `<details>\n<summary>${escapeHtml(summary)}</summary>\n\n${markdownCodeFence(JSON.stringify(value, null, 2), 'json')}\n\n</details>`;
  }
}
