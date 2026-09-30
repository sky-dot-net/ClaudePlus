import { CommandButtons } from '../CommandButtons.js';
import { ComposerOptionsView } from '../composer/ComposerOptionsView.js';
import { ExportMenuButton } from '../composer/ExportMenuButton.js';
import { Panel } from './Panel.js';
import { PendingQuoteView } from '../composer/PendingQuoteView.js';
import { StagedFileList } from '../composer/StagedFileList.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { optionsHtml } from '../html/optionsHtml.js';
import stylesheet from './ComposerPanel.css';

StyleRegistry.register(stylesheet);

/**
 * The single message composer. It always targets the active chat (the focused chat pane) and can
 * be docked anywhere. Enter sends and Shift+Enter inserts a line break; there is no send button,
 * only a Stop button while a reply streams. Files pasted or dropped in are uploaded and attached
 * to the next prompt; selecting text in a message and clicking its Reply button attaches a quote
 * of it instead. Its toolbar holds the model options, buttons opening the active chat's files and
 * sources sub-panes, and the chat export.
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
   * Conversation statistics, to hide the files/sources buttons when the active chat has none.
   * @type {StatsIndex}
   */
  #stats;

  /**
   * Exports the active chat.
   * @type {ConversationExporter}
   */
  #exporter;

  /**
   * The selectable models and effort levels.
   * @type {ModelCatalog}
   */
  #modelCatalog;

  /**
   * The commands the panel's command buttons run.
   * @type {Commands}
   */
  #commands;

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
   * The quote (if any) attached to the next prompt; created once the body is built.
   * @type {?PendingQuoteView}
   */
  #pendingQuote = null;

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
   * @param {StatsIndex} services.stats Conversation statistics, to hide the files/sources buttons when empty.
   * @param {ConversationExporter} services.exporter Exports the active chat.
   * @param {ModelCatalog} services.modelCatalog The selectable models and effort levels.
   * @param {Commands} services.commands The commands the panel's command buttons run.
   */
  constructor({ paneManager, settings, stats, exporter, modelCatalog, commands }) {
    super('Message');
    this.#paneManager = paneManager;
    this.#settings = settings;
    this.#stats = stats;
    this.#exporter = exporter;
    this.#modelCatalog = modelCatalog;
    this.#commands = commands;
  }

  /**
   * HTML of the panel body.
   * @returns {string} Toolbar, prompt input and Stop button.
   */
  createBodyHtml() {
    return `
      <div class="claude-plus-composer__options" data-name="optionsRow">
        <select data-name="modelSelect">${optionsHtml(this.#modelCatalog.models, '')}</select>
        <select data-name="effortSelect">${optionsHtml(this.#modelCatalog.efforts, '')}</select>
        <label class="claude-plus-composer__thinking-toggle"><input type="checkbox" data-name="thinkingCheckbox" /> Extended thinking</label>
        <div class="claude-plus-fill-remaining"></div>
        <button class="claude-plus-toolbar__button" data-name="findButton" data-command="findInChat">🔍</button>
        <button class="claude-plus-toolbar__button" data-name="filesButton" title="Files in the active chat">📁</button>
        <button class="claude-plus-toolbar__button" data-name="sourcesButton" title="Web sources of the active chat">🌐</button>
        <button class="claude-plus-toolbar__button" data-name="statsButton" title="Stats for the active chat">📈</button>
        <button class="claude-plus-toolbar__button" data-name="exportButton" title="Export the active chat">Export ▾</button>
      </div>
      <div class="claude-plus-staged-files" data-name="stagedFiles" hidden></div>
      <div data-name="pendingQuote" hidden></div>
      <div class="claude-plus-composer__readonly-notice" data-name="readonlyNotice" hidden>This is an imported chat — read-only, there's no model to reply to.</div>
      <textarea class="claude-plus-composer__input" data-name="promptInput" placeholder="Message Claude… (Enter sends, Shift+Enter adds a line — paste or drop files to attach them)" rows="3"></textarea>
      <div class="claude-plus-composer__queued" data-name="queuedPromptRow" hidden>
        <span class="claude-plus-composer__queued-label">⏳ Queued:</span>
        <span class="claude-plus-composer__queued-text" data-name="queuedPromptText"></span>
        <button class="claude-plus-toolbar__button" data-name="sendQueuedNowButton" title="Stop the current reply and send this now">Send now</button>
        <button class="claude-plus-composer__queued-remove" data-name="cancelQueuedButton" title="Remove the queued message">✕</button>
      </div>
      <button class="claude-plus-primary-button claude-plus-composer__stop-button" data-name="stopButton" hidden>Stop</button>`;
  }

  /**
   * Creates the controls' views, wires the prompt input and follows the settings and the active chat.
   * @returns {void}
   */
  bindEvents() {
    const { promptInput, stopButton, filesButton, sourcesButton, statsButton, exportButton, stagedFiles, pendingQuote } = this.elements;
    CommandButtons.bind(this, this.element, this.#commands);
    this.#optionsView = new ComposerOptionsView(this.elements, this.#settings);
    this.#exportButton = new ExportMenuButton(exportButton, this.#exporter);
    this.#stagedFiles = new StagedFileList(stagedFiles, file => this.#paneManager.focusedSession.uploadFile(file));
    this.#pendingQuote = new PendingQuoteView(pendingQuote);
    promptInput.addEventListener('keydown', event => this.#onPromptKeydown(event));
    promptInput.addEventListener('paste', event => this.#onPaste(event));
    this.element.addEventListener('dragover', event => event.preventDefault());
    this.element.addEventListener('drop', event => this.#onDrop(event));
    stopButton.addEventListener('click', () => this.#paneManager.focusedSession.stopReply());
    filesButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('files'));
    sourcesButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('sources'));
    statsButton.addEventListener('click', () => this.#paneManager.focusedPanel.openSubPane('stats'));
    this.elements.sendQueuedNowButton.addEventListener('click', () => this.#paneManager.focusedSession.sendQueuedPromptNow());
    this.elements.cancelQueuedButton.addEventListener('click', () => this.#paneManager.focusedSession.clearQueuedPrompt());
    this.listenTo(this.#settings, 'settings', () => this.#optionsView.showSettings());
    this.listenTo(this.#modelCatalog, 'catalog', () => this.#optionsView.refreshChoices(this.#modelCatalog));
    this.listenTo(this.#paneManager, 'focus', () => this.#followActiveChat());
    this.listenTo(this.#paneManager, 'paneConversations', () => this.render());
    this.listenTo(this.#paneManager, 'conversationLoaded', () => this.render());
    this.listenTo(this.#stats, 'aggregate', () => this.render());
    this.#followActiveChat();
  }

  /**
   * Shows Stop only while the active chat streams a reply, enables export only for a saved
   * conversation, shows the files/sources buttons only when the active chat has any, and replaces
   * just the send box (not the whole toolbar) with a read-only notice for an imported chat, whose
   * model/effort/thinking choosers are disabled rather than hidden since there's nothing to send.
   * @returns {void}
   */
  render() {
    const session = this.#paneManager.focusedSession;
    const { promptInput, stopButton, readonlyNotice, filesButton, sourcesButton } = this.elements;
    promptInput.hidden = session.isReadOnly;
    readonlyNotice.hidden = !session.isReadOnly;
    stopButton.hidden = session.isReadOnly || !session.isSending;
    this.#optionsView.setDisabled(session.isReadOnly);
    this.#exportButton.setEnabled(Boolean(session.openConversationId));
    filesButton.hidden = !this.#activeChatHas('folders');
    sourcesButton.hidden = !this.#activeChatHas('sources');
    this.#renderQueuedPrompt(session.queuedPrompt);
  }

  /**
   * Shows the prompt queued for after the current reply, if there is one.
   * @param {?{prompt: string, files: UploadedFile[], quote: ?{text: string, sender: string}}} queuedPrompt The queued prompt.
   * @returns {void}
   */
  #renderQueuedPrompt(queuedPrompt) {
    const { queuedPromptRow, queuedPromptText } = this.elements;
    queuedPromptRow.hidden = !queuedPrompt;
    if (!queuedPrompt) return;
    queuedPromptText.textContent = queuedPrompt.prompt;
    queuedPromptText.title = queuedPrompt.prompt;
  }

  /**
   * Whether the active chat has any entries in an aggregate list.
   * @param {'folders'|'sources'} listName The aggregate list to check.
   * @returns {boolean} True while a conversation is open and it has a matching entry.
   */
  #activeChatHas(listName) {
    const conversationId = this.#paneManager.focusedSession.openConversationId;
    return Boolean(conversationId) && this.#stats.aggregate[listName].some(entry => entry.conversationId === conversationId);
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
   * Subscribes to the newly active chat's sending state and quote requests, and drops the files and
   * quote staged for the previous one.
   * @returns {void}
   */
  #followActiveChat() {
    this.#unsubscribeFromSession();
    const session = this.#paneManager.focusedSession;
    this.#sessionUnsubscribers = [
      session.subscribe('sending', () => this.render()),
      session.subscribe('queuedPrompt', () => this.render()),
      session.subscribe('quoteRequested', ({ text, sender }) => this.#pendingQuote.set(text, sender)),
    ];
    this.#stagedFiles.clear();
    this.#pendingQuote.clear();
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
   * Sends the typed prompt, the staged files and any pending quote to the active chat, then clears
   * all three; ignored for blank input or while a file is still uploading. While the active chat is
   * already sending, this queues the prompt instead, replacing whatever was queued before - it
   * sends automatically the moment the current reply finishes, or right away if "Send now" is used.
   * @returns {void}
   */
  #sendTypedPrompt() {
    const { promptInput } = this.elements;
    const session = this.#paneManager.focusedSession;
    if (!promptInput.value.trim() || this.#stagedFiles.isUploading) return;
    const prompt = promptInput.value;
    const files = this.#stagedFiles.takeUploads();
    const quote = this.#pendingQuote.take();
    promptInput.value = '';
    if (session.isSending) session.queuePrompt(prompt, files, quote);
    else session.sendPrompt(prompt, files, quote);
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
