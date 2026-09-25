/**
 * Exports a conversation as JSON: the ExportedConversation, pretty-printed.
 */
export class JsonConversationFormat {
  /**
   * Name shown in the export menu.
   * @type {string}
   */
  static label = 'JSON';

  /**
   * File extension.
   * @type {string}
   */
  static extension = 'json';

  /**
   * MIME type.
   * @type {string}
   */
  static mimeType = 'application/json';

  /**
   * Converts a conversation to JSON.
   * @param {ExportedConversation} conversation The conversation.
   * @returns {string} The JSON document.
   */
  static serialize(conversation) {
    return `${JSON.stringify(conversation, null, 2)}\n`;
  }
}
