import { ComposerOptionsView } from '../composer/ComposerOptionsView.js';
import { EFFORTS } from '../../config/EFFORTS.js';
import { ExportMenuButton } from '../composer/ExportMenuButton.js';
import { MODELS } from '../../config/MODELS.js';
import { Panel } from './Panel.js';
import { StagedFileList } from '../composer/StagedFileList.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { optionsHtml } from '../html/optionsHtml.js';
import stylesheet from './ComposerPanel.css';

StyleRegistry.register(stylesheet);

/**
 * The single message composer. It always targets the active chat (the focused chat pane) and can
 * be docked anywhere. Enter sends and Shift+Enter inserts a line break; there is no send button,
 * only a Stop button while a reply streams. Files pasted or dropped in are uploaded and attached
 * to the next prompt. Its toolbar holds the model options, buttons opening the active chat's files
 * and sources sub-panes, and the chat export.
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
   * The model option controls; created once the body is built.
   * @type {?ComposerOptionsView}
   */
  #optionsView = null;

  /**
   * The export button; created once the body is built.
   * @type {?ExportMenuButton}
   */
  #exportButton = null;

  /**
   * Files attached to the next prompt; created once the body is built.
   * @type {?StagedFileList}
   */
  #stagedFiles = null;

  /**
   * Undoes the subscriptions to the active chat's session.
   * @type {Array<function(): void>}
   */
  #sessionUnsubscribers = [];

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
   * Creates the controls' views, wires the prompt input and follows the settings and the active chat.
   * @returns {void}
   */
  bindEvents() {
    const { promptInput, stopButton, filesButton, sourcesButton, exportButton, stagedFiles } = this.elements;
    this.#optionsView = new ComposerOptionsView(this.elements, this.#settings);
    this.#exportButton = new ExportMenuButton(exportButton, this.#exporter);
    this.#stagedFiles = new StagedFileList(stagedFiles, file => this.#paneManager.focusedSession.uploadFile(file));
    promptInput.addEventListener('keydown', event => this.#onPromptKeydown(event));
    promptInput.addEventListener('paste', event => this.#onPaste(event));
    this.element.addEventListener('dragover', event => event.preventDefault());
    this.element.addEventListener('drop', event => this.#onDrop(event));
    stopButton.addEventListener('click', () => this.#paneManager.focusedSession.stopReply());
    filesButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('files'));
    sourcesButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('sources'));
    this.listenTo(this.#settings, 'settings', () => this.#optionsView.showSettings());
    this.listenTo(this.#paneManager, 'focus', () => this.#followActiveChat());
    this.listenTo(this.#paneManager, 'paneConversations', () => this.render());
    this.#followActiveChat();
  }

  /**
   * Shows Stop only while the active chat streams a reply, and enables export only for a saved conversation.
   * @returns {void}
   */
  render() {
    const session = this.#paneManager.focusedSession;
    this.elements.stopButton.hidden = !session.isSending;
    this.#exportButton.setEnabled(Boolean(session.openConversationId));
  }

  /**
   * Ends the subscriptions, including those to the active chat, and closes the export menu.
   * @returns {void}
   */
  dispose() {
    this.#unsubscribeFromSession();
    this.#exportButton?.close();
    super.dispose();
  }

  /**
   * Subscribes to the newly active chat's sending state and drops the files staged for the previous one.
   * @returns {void}
   */
  #followActiveChat() {
    this.#unsubscribeFromSession();
    this.#sessionUnsubscribers = [this.#paneManager.focusedSession.subscribe('sending', () => this.render())];
    this.#stagedFiles.clear();
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
   * Sends the typed prompt and the staged files to the active chat, then clears both; ignored for
   * blank input, while the active chat is sending, or while a file is still uploading.
   * @returns {void}
   */
  #sendTypedPrompt() {
    const { promptInput } = this.elements;
    const session = this.#paneManager.focusedSession;
    if (!promptInput.value.trim() || session.isSending || this.#stagedFiles.isUploading) return;
    const prompt = promptInput.value;
    promptInput.value = '';
    session.sendPrompt(prompt, this.#stagedFiles.takeUploads());
  }

  /**
   * Attaches the files of a paste that carries any, leaving pasted text to paste normally. A paste
   * without files is left alone.
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
    files.forEach(file => this.#stagedFiles.attach(file));
  }

  /**
   * Attaches every file dropped onto the composer.
   * @param {DragEvent} event The drop.
   * @returns {void}
   */
  #onDrop(event) {
    event.preventDefault();
    [...(event.dataTransfer?.files ?? [])].forEach(file => this.#stagedFiles.attach(file));
  }
}
