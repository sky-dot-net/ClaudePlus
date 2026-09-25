import { ConversationExporter } from '../../export/ConversationExporter.js';
import { EFFORTS } from '../../config/EFFORTS.js';
import { MODELS } from '../../config/MODELS.js';
import { Panel } from './Panel.js';
import { PopupMenu } from '../PopupMenu.js';
import { THINKING_MODES } from '../../config/THINKING_MODES.js';
import { alertDialog } from '../dialogs/alertDialog.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import { optionsHtml } from '../html/optionsHtml.js';

/**
 * The single message composer. It always targets the active chat (the focused chat pane) and can
 * be docked anywhere. Enter sends and Shift+Enter inserts a line break; there is no send button,
 * only a Stop button while a reply streams. Its toolbar holds the model options, buttons opening
 * the active chat's files and sources sub-panes, and the chat export.
 */
export class ComposerPanel extends Panel {
  /**
   * Chat panes; the focused one is the active chat.
   * @type {ChatPaneManager}
   */
  #paneManager;

  /**
   * Shared model options.
   * @type {ComposerSettings}
   */
  #settings;

  /**
   * Exports the active chat.
   * @type {ConversationExporter}
   */
  #exporter;

  /**
   * Menu listing the export formats.
   * @type {PopupMenu}
   */
  #exportMenu = new PopupMenu();

  /**
   * Undoes the subscriptions to the active chat's session.
   * @type {Array<function(): void>}
   */
  #sessionUnsubscribers = [];

  /**
   * Files pasted or dropped in, attached to the next prompt. Each entry is
   * {key: string, name: string, isUploading: boolean, upload: ?UploadedFile}; a failed upload is
   * dropped from the list rather than kept as an entry.
   * @type {Array<object>}
   */
  #stagedFiles = [];

  /**
   * Creates the panel.
   * @param {object} services Panel dependencies.
   * @param {ChatPaneManager} services.paneManager Chat panes; the focused one is the active chat.
   * @param {ComposerSettings} services.settings Shared model options.
   * @param {ConversationExporter} services.exporter Exports the active chat.
   */
  constructor({ paneManager, settings, exporter }) {
    super('Message');
    this.#paneManager = paneManager;
    this.#settings = settings;
    this.#exporter = exporter;
  }

  /**
   * HTML of the panel body.
   * @returns {string} Toolbar, prompt input and Stop button.
   */
  createBodyHtml() {
    return `
      <div class="claude-plus-composer__options">
        <select data-name="modelSelect">${optionsHtml(MODELS, '')}</select>
        <select data-name="effortSelect">${optionsHtml(EFFORTS, '')}</select>
        <label class="claude-plus-composer__thinking-toggle"><input type="checkbox" data-name="thinkingCheckbox" /> Extended thinking</label>
        <div class="claude-plus-fill-remaining"></div>
        <button class="claude-plus-toolbar__button" data-name="filesButton" title="Files in the active chat">📁</button>
        <button class="claude-plus-toolbar__button" data-name="sourcesButton" title="Web sources of the active chat">🌐</button>
        <button class="claude-plus-toolbar__button" data-name="exportButton" title="Export the active chat">Export ▾</button>
      </div>
      <div class="claude-plus-staged-files" data-name="stagedFiles" hidden></div>
      <textarea class="claude-plus-composer__input" data-name="promptInput" placeholder="Message Claude… (Enter sends, Shift+Enter adds a line — paste or drop files to attach them)" rows="3"></textarea>
      <button class="claude-plus-primary-button claude-plus-composer__stop-button" data-name="stopButton" hidden>Stop</button>`;
  }

  /**
   * Wires the controls and follows the settings and the active chat.
   * @returns {void}
   */
  bindEvents() {
    const { modelSelect, effortSelect, thinkingCheckbox, promptInput, stopButton, filesButton, sourcesButton, exportButton, stagedFiles } = this.elements;
    modelSelect.addEventListener('change', () => { this.#settings.model = modelSelect.value; });
    effortSelect.addEventListener('change', () => { this.#settings.effort = effortSelect.value; });
    thinkingCheckbox.addEventListener('change', () => { this.#settings.thinkingMode = thinkingCheckbox.checked ? THINKING_MODES.extended : THINKING_MODES.off; });
    promptInput.addEventListener('keydown', event => this.#onPromptKeydown(event));
    promptInput.addEventListener('paste', event => this.#onPaste(event));
    this.element.addEventListener('dragover', event => event.preventDefault());
    this.element.addEventListener('drop', event => this.#onDrop(event));
    stagedFiles.addEventListener('click', event => this.#onStagedFilesClick(event));
    stopButton.addEventListener('click', () => this.#paneManager.focusedSession.stopReply());
    filesButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('files'));
    sourcesButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('sources'));
    exportButton.addEventListener('click', () => this.#showExportMenu());
    this.listenTo(this.#settings, 'settings', () => this.#showSettings());
    this.listenTo(this.#paneManager, 'focus', () => this.#followActiveChat());
    this.listenTo(this.#paneManager, 'paneConversations', () => this.render());
    this.#showSettings();
    this.#followActiveChat();
  }

  /**
   * Shows Stop only while the active chat streams a reply, and enables export only for a saved conversation.
   * @returns {void}
   */
  render() {
    const session = this.#paneManager.focusedSession;
    this.elements.stopButton.hidden = !session.isSending;
    this.elements.exportButton.disabled = !session.openConversationId;
  }

  /**
   * Ends the subscriptions, including those to the active chat.
   * @returns {void}
   */
  dispose() {
    this.#unsubscribeFromSession();
    this.#exportMenu.close();
    super.dispose();
  }

  /**
   * Subscribes to the newly active chat's sending state.
   * @returns {void}
   */
  #followActiveChat() {
    this.#unsubscribeFromSession();
    this.#sessionUnsubscribers = [this.#paneManager.focusedSession.subscribe('sending', () => this.render())];
    this.#clearStagedFiles();
    this.render();
  }

  /**
   * Ends the subscriptions to the previously active chat.
   * @returns {void}
   */
  #unsubscribeFromSession() {
    this.#sessionUnsubscribers.forEach(unsubscribe => unsubscribe());
    this.#sessionUnsubscribers = [];
  }

  /**
   * Shows the current shared options.
   * @returns {void}
   */
  #showSettings() {
    this.elements.modelSelect.value = this.#settings.model;
    this.elements.effortSelect.value = this.#settings.effort;
    this.elements.thinkingCheckbox.checked = this.#settings.thinkingMode === THINKING_MODES.extended;
  }

  /**
   * Opens the export format menu below the export button.
   * @returns {void}
   */
  #showExportMenu() {
    const bounds = this.elements.exportButton.getBoundingClientRect();
    this.#exportMenu.open({
      left: bounds.left,
      top: bounds.bottom + 4,
      entries: [...ConversationExporter.FORMATS].map(([formatId, format]) => ({ id: formatId, label: format.label })),
      onSelect: formatId => this.#exporter.exportOpenConversation(formatId),
    });
  }

  /**
   * Sends on Enter; Shift+Enter inserts a line break and IME composition is left alone.
   * @param {KeyboardEvent} event Key press in the text area.
   * @returns {void}
   */
  #onPromptKeydown(event) {
    if (!ComposerPanel.#isSendShortcut(event)) return;
    event.preventDefault();
    this.#sendTypedPrompt();
  }

  /**
   * Whether a key press sends the prompt.
   * @param {KeyboardEvent} event The key press.
   * @returns {boolean} True for Enter without Shift outside IME composition.
   */
  static #isSendShortcut(event) {
    return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
  }

  /**
   * Sends the typed prompt and any successfully staged files to the active chat, then clears both;
   * ignored for blank input, while the active chat is sending, or while a file is still uploading.
   * @returns {void}
   */
  #sendTypedPrompt() {
    const { promptInput } = this.elements;
    const session = this.#paneManager.focusedSession;
    if (!promptInput.value.trim() || session.isSending || this.#stagedFiles.some(entry => entry.isUploading)) return;
    const prompt = promptInput.value;
    const files = this.#stagedFiles.map(entry => entry.upload);
    promptInput.value = '';
    this.#stagedFiles = [];
    this.#renderStagedFiles();
    session.sendPrompt(prompt, files);
  }

  /**
   * Intercepts a paste that carries one or more files, uploading each and leaving any pasted text
   * to paste normally. A paste with no files is left alone.
   * @param {ClipboardEvent} event The paste.
   * @returns {void}
   */
  #onPaste(event) {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    files.forEach(file => this.#attachFile(file));
  }

  /**
   * Uploads every file dropped onto the composer.
   * @param {DragEvent} event The drop.
   * @returns {void}
   */
  #onDrop(event) {
    event.preventDefault();
    [...(event.dataTransfer?.files ?? [])].forEach(file => this.#attachFile(file));
  }

  /**
   * Uploads a file to the active chat's conversation and shows it as a staged attachment chip,
   * replacing the placeholder once the upload settles.
   * @param {File} file File to upload.
   * @returns {Promise<void>} Resolves once uploaded or failed.
   */
  async #attachFile(file) {
    const key = crypto.randomUUID();
    this.#stagedFiles = [...this.#stagedFiles, { key, name: file.name, isUploading: true, upload: null }];
    this.#renderStagedFiles();
    try {
      const upload = await this.#paneManager.focusedSession.uploadFile(file);
      this.#updateStagedFile(key, { isUploading: false, upload });
    } catch (error) {
      this.#stagedFiles = this.#stagedFiles.filter(entry => entry.key !== key);
      this.#renderStagedFiles();
      await alertDialog(`Uploading "${file.name}" failed: ${error.message}`);
    }
  }

  /**
   * Merges changes into a staged file entry, unless it was removed while the upload was in flight.
   * @param {string} key Entry key.
   * @param {object} changes Fields to merge in.
   * @returns {void}
   */
  #updateStagedFile(key, changes) {
    if (!this.#stagedFiles.some(entry => entry.key === key)) return;
    this.#stagedFiles = this.#stagedFiles.map(entry => (entry.key === key ? { ...entry, ...changes } : entry));
    this.#renderStagedFiles();
  }

  /**
   * Removes a staged file the user clicked the remove button of.
   * @param {MouseEvent} event Click inside the staged files row.
   * @returns {void}
   */
  #onStagedFilesClick(event) {
    const button = event.target.closest('[data-key]');
    if (!button) return;
    this.#stagedFiles = this.#stagedFiles.filter(entry => entry.key !== button.dataset.key);
    this.#renderStagedFiles();
  }

  /**
   * Discards every staged file, without cancelling uploads already in flight; a late response is
   * ignored by #updateStagedFile once its entry is gone.
   * @returns {void}
   */
  #clearStagedFiles() {
    if (!this.#stagedFiles.length) return;
    this.#stagedFiles = [];
    this.#renderStagedFiles();
  }

  /**
   * Shows the staged files as removable chips, hiding the row when there are none.
   * @returns {void}
   */
  #renderStagedFiles() {
    const { stagedFiles } = this.elements;
    stagedFiles.hidden = this.#stagedFiles.length === 0;
    stagedFiles.innerHTML = this.#stagedFiles.map(entry => ComposerPanel.#stagedFileHtml(entry)).join('');
  }

  /**
   * HTML of one staged file chip: a thumbnail for an uploaded image, else a generic file icon.
   * @param {object} entry A #stagedFiles entry.
   * @returns {string} The chip.
   */
  static #stagedFileHtml(entry) {
    const thumbnailHtml = entry.upload?.thumbnail_url
      ? `<img class="claude-plus-staged-file__thumb" src="${escapeHtml(entry.upload.thumbnail_url)}" alt="" />`
      : '<span class="claude-plus-staged-file__icon">📎</span>';
    const stateClass = entry.isUploading ? ' claude-plus-staged-file--uploading' : '';
    return `
      <span class="claude-plus-staged-file${stateClass}">
        ${thumbnailHtml}
        <span class="claude-plus-staged-file__name">${escapeHtml(entry.name)}</span>
        <button class="claude-plus-staged-file__remove" data-key="${escapeHtml(entry.key)}" title="Remove">×</button>
      </span>`;
  }
}
