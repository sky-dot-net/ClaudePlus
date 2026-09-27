import { ColumnTable } from '../tables/ColumnTable.js';
import { Panel } from './Panel.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { createFileColumns } from '../tables/createFileColumns.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import { formatTimestamp } from '../../time/formatTimestamp.js';
import stylesheet from './FilesPanel.css';

StyleRegistry.register(stylesheet);

/**
 * Uploaded and produced files: a table of conversations with files, and per conversation a table
 * of its files; both with configurable columns, sorting and filters. Double-clicking a file opens
 * its conversation and jumps to the message it belongs to.
 */
export class FilesPanel extends Panel {
  /**
   * Conversation statistics.
   * @type {StatsIndex}
   */
  #stats;

  /**
   * Table settings storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Navigation.
   * @type {Router}
   */
  #router;

  /**
   * Conversation id of the open folder, or null for the folder table.
   * @type {?string}
   */
  #openFolderId = null;

  /**
   * Table of conversations with files; created with the DOM.
   * @type {?ColumnTable}
   */
  #folderTable = null;

  /**
   * Table of the open folder's files; created with the DOM.
   * @type {?ColumnTable}
   */
  #fileTable = null;

  /**
   * Creates the panel.
   * @param {object} services Panel dependencies.
   * @param {StatsIndex} services.stats Conversation statistics.
   * @param {Preferences} services.preferences Table settings storage.
   * @param {Router} services.router Navigation.
   */
  constructor({ stats, preferences, router }) {
    super('Files');
    this.#stats = stats;
    this.#preferences = preferences;
    this.#router = router;
  }

  /**
   * HTML of the panel body.
   * @returns {string} Breadcrumb and the two table hosts.
   */
  createBodyHtml() {
    return `
      <div class="claude-plus-breadcrumb" data-name="breadcrumb"></div>
      <div class="claude-plus-table-host" data-name="folderTableHost"></div>
      <div class="claude-plus-table-host" data-name="fileTableHost" hidden></div>`;
  }

  /**
   * Creates both tables, wires navigation and follows aggregate changes.
   * @returns {void}
   */
  bindEvents() {
    this.#folderTable = new ColumnTable({
      container: this.elements.folderTableHost,
      tableId: 'fileFolders',
      columns: FilesPanel.#folderColumns(),
      preferences: this.#preferences,
      defaultSort: { column: 'date', direction: -1 },
      rowAttributes: folder => `class="claude-plus-folder" data-conversation-id="${escapeHtml(folder.conversationId)}"`,
      emptyText: 'No files or attachments indexed yet.',
    });
    this.#fileTable = new ColumnTable({
      container: this.elements.fileTableHost,
      tableId: 'files',
      columns: createFileColumns(false),
      preferences: this.#preferences,
      defaultSort: { column: 'date', direction: -1 },
      rowAttributes: file => `data-message-id="${escapeHtml(file.messageId ?? '')}"`,
      emptyText: 'No files here.',
    });
    this.#folderTable.bodyElement.addEventListener('click', event => this.#onFolderClick(event));
    this.#fileTable.bodyElement.addEventListener('dblclick', event => this.#onFileDoubleClick(event));
    this.elements.breadcrumb.addEventListener('click', event => this.#onBreadcrumbClick(event));
    this.listenTo(this.#stats, 'aggregate', () => this.render());
  }

  /**
   * Shows the open folder's files, or the folder table when none is open or it no longer exists.
   * @returns {void}
   */
  render() {
    const openFolder = this.#stats.aggregate.folders.find(folder => folder.conversationId === this.#openFolderId);
    if (openFolder) this.#showFiles(openFolder);
    else this.#showFolders();
  }

  /**
   * Closes the tables' typeaheads and ends the subscriptions.
   * @returns {void}
   */
  dispose() {
    [this.#folderTable, this.#fileTable].filter(Boolean).forEach(table => table.dispose());
    super.dispose();
  }

  /**
   * Columns of the folder table.
   * @returns {TableColumn[]} Chat, file count and newest file date.
   */
  static #folderColumns() {
    return [
      { id: 'conversation', label: 'Chat', isAlwaysVisible: true, filter: 'values', sortValue: folder => folder.conversationTitle.toLowerCase(), filterValue: folder => folder.conversationTitle, cellHtml: folder => `📁 ${escapeHtml(folder.conversationTitle)}` },
      { id: 'fileCount', label: 'Files', isVisibleByDefault: true, sortValue: folder => folder.files.length, cellHtml: folder => String(folder.files.length) },
      { id: 'date', label: 'Newest', isVisibleByDefault: true, filter: 'date', sortValue: folder => folder.newestFileTime, filterValue: folder => new Date(folder.newestFileTime).toISOString(), cellHtml: folder => escapeHtml(formatTimestamp(new Date(folder.newestFileTime).toISOString())) },
    ];
  }

  /**
   * Opens the clicked folder.
   * @param {MouseEvent} event Click in the folder table body.
   * @returns {void}
   */
  #onFolderClick(event) {
    const row = event.target.closest('[data-conversation-id]');
    if (row) this.#openFolder(row.dataset.conversationId);
  }

  /**
   * Opens the open folder's conversation and jumps to a double-clicked file's message.
   * @param {MouseEvent} event The double-click.
   * @returns {Promise<void>} Resolves once opened and scrolled to.
   */
  async #onFileDoubleClick(event) {
    const messageId = event.target.closest('[data-message-id]')?.dataset.messageId;
    if (!messageId) return;
    await this.#router.openConversation(this.#openFolderId);
    this.#router.scrollToMessage(messageId);
  }

  /**
   * Returns to the folder table when the back link is clicked.
   * @param {MouseEvent} event Click in the breadcrumb.
   * @returns {void}
   */
  #onBreadcrumbClick(event) {
    if (event.target.closest('[data-action="back"]')) this.#openFolder(null);
  }

  /**
   * Opens a folder, or the folder table.
   * @param {?string} conversationId Folder to open, or null for the folder table.
   * @returns {void}
   */
  #openFolder(conversationId) {
    this.#openFolderId = conversationId;
    this.render();
  }

  /**
   * Shows the folder table.
   * @returns {void}
   */
  #showFolders() {
    this.#openFolderId = null;
    this.elements.breadcrumb.innerHTML = '<span>All folders</span>';
    this.elements.folderTableHost.hidden = false;
    this.elements.fileTableHost.hidden = true;
    this.#folderTable.setRows(this.#stats.aggregate.folders);
  }

  /**
   * Shows a folder's files.
   * @param {FileFolder} folder The folder.
   * @returns {void}
   */
  #showFiles(folder) {
    this.elements.breadcrumb.innerHTML = `<span class="claude-plus-breadcrumb__back-link" data-action="back">← All folders</span> / ${escapeHtml(folder.conversationTitle)}`;
    this.elements.folderTableHost.hidden = true;
    this.elements.fileTableHost.hidden = false;
    this.#fileTable.setRows(folder.files);
  }
}
