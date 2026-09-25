import { ConversationExportBuilder } from './ConversationExportBuilder.js';
import { JsonConversationFormat } from './formats/JsonConversationFormat.js';
import { LOG_PREFIX } from '../config/LOG_PREFIX.js';
import { MarkdownConversationFormat } from './formats/MarkdownConversationFormat.js';
import { XmlConversationFormat } from './formats/XmlConversationFormat.js';
import { alertDialog } from '../ui/dialogs/alertDialog.js';
import { downloadTextFile } from '../browser/downloadTextFile.js';
import { fileNameFromTitle } from '../text/fileNameFromTitle.js';

/**
 * Exports the focused pane's conversation to a file, fetching it fresh so the export is complete.
 */
export class ConversationExporter {
  /**
   * Available formats by id, in menu order.
   * @type {Map<string, ExportFormat>}
   */
  static FORMATS = new Map([
    ['markdown', MarkdownConversationFormat],
    ['json', JsonConversationFormat],
    ['xml', XmlConversationFormat],
  ]);

  /**
   * API client.
   * @type {ClaudeApi}
   */
  #api;

  /**
   * Chat panes, for the focused pane's conversation.
   * @type {ChatPaneManager}
   */
  #paneManager;

  /**
   * Creates the exporter.
   * @param {ClaudeApi} api API client.
   * @param {ChatPaneManager} paneManager Chat panes, for the focused pane's conversation.
   */
  constructor(api, paneManager) {
    this.#api = api;
    this.#paneManager = paneManager;
  }

  /**
   * Downloads the focused pane's conversation in a format. Does nothing in an unsaved new chat; a
   * failure is logged and shown in an alert.
   * @param {string} formatId Key of ConversationExporter.FORMATS.
   * @returns {Promise<void>} Resolves once the download has started or failed.
   */
  async exportOpenConversation(formatId) {
    const conversationId = this.#paneManager.focusedSession.openConversationId;
    if (!conversationId) return;
    try {
      const conversation = ConversationExportBuilder.build(await this.#api.getConversation(conversationId));
      ConversationExporter.#download(conversation, ConversationExporter.FORMATS.get(formatId));
    } catch (error) {
      console.warn(LOG_PREFIX, 'export failed', error);
      await alertDialog(`Export failed: ${error.message}`);
    }
  }

  /**
   * Serializes a conversation and lets the browser save it as "<title> <date>.<extension>".
   * @param {ExportedConversation} conversation The conversation.
   * @param {ExportFormat} format Target format.
   * @returns {void}
   */
  static #download(conversation, format) {
    const fileName = `${fileNameFromTitle(conversation.title)} ${conversation.updatedAt.slice(0, 10)}.${format.extension}`;
    downloadTextFile(fileName, format.serialize(conversation), format.mimeType);
  }
}
