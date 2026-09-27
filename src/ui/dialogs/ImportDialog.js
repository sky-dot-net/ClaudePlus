import { AlertDialog } from './AlertDialog.js';
import { Dialog } from './Dialog.js';
import { ImportFileClassifier } from '../../import/ImportFileClassifier.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { collectNamedElements } from '../../dom/collectNamedElements.js';
import { createElement } from '../../dom/createElement.js';
import stylesheet from './ImportDialog.css';

StyleRegistry.register(stylesheet);

/**
 * Imports a claude.ai data export: the user selects the files they extracted (conversations.json
 * is required; memories, Artifacts, Projects, Feedback and light_metadata files are each
 * independently optional, and detected by content, not filename), reviews what was found, then
 * imports. Nothing is written until Import is clicked.
 */
export class ImportDialog extends Dialog {
  /**
   * Runs the import once files are confirmed.
   * @type {ImportOrchestrator}
   */
  #orchestrator;

  /**
   * Called once an import has actually written anything, so the Chats list can refresh.
   * @type {function(): void}
   */
  #onImported;

  /**
   * The dialog's named elements, set once the content is built.
   * @type {?Object<string, HTMLElement>}
   */
  #elements = null;

  /**
   * The files currently selected, classified and ready to import.
   * @type {?File[]}
   */
  #selectedFiles = null;

  /**
   * Creates the dialog without showing it.
   * @param {ImportOrchestrator} orchestrator Runs the import once files are confirmed.
   * @param {function(): void} onImported Called once an import has actually written anything.
   */
  constructor(orchestrator, onImported) {
    super();
    this.#orchestrator = orchestrator;
    this.#onImported = onImported;
  }

  /**
   * Opens the import screen.
   * @param {ImportOrchestrator} orchestrator Runs the import once files are confirmed.
   * @param {function(): void} onImported Called once an import has actually written anything.
   * @returns {Promise<void>} Resolves once closed.
   */
  static open(orchestrator, onImported) {
    return new ImportDialog(orchestrator, onImported).show();
  }

  /**
   * CSS class of the dimmed overlay centering the screen.
   * @returns {string} The class name.
   */
  get overlayClassName() {
    return 'claude-plus-import-overlay';
  }

  /**
   * Builds the screen.
   * @returns {HTMLElement[]} The screen.
   */
  createContent() {
    const box = createElement('div', { className: 'claude-plus-import-dialog', innerHTML: ImportDialog.#bodyHtml() });
    this.#elements = collectNamedElements(box);
    this.#bindEvents();
    return [box];
  }

  /**
   * The screen's static markup.
   * @returns {string} The HTML.
   */
  static #bodyHtml() {
    return `
      <div class="claude-plus-import-dialog__header">
        <h2>Import chat export</h2>
        <button class="claude-plus-toolbar__close-button" data-name="closeButton" title="Close">✕</button>
      </div>
      <p>Select the files you extracted from claude.ai's "Export my data" download: conversations.json is required; memory, Artifact, Project and account files are each optional and detected automatically.</p>
      <div class="claude-plus-import-dialog__row">
        <button class="claude-plus-toolbar__button" data-name="chooseButton">Choose files…</button>
      </div>
      <div data-name="summary"></div>
      <div class="claude-plus-import-dialog__row">
        <button class="claude-plus-primary-button" data-name="importButton" disabled>Import</button>
      </div>`;
  }

  /**
   * Wires the file picker and the buttons.
   * @returns {void}
   */
  #bindEvents() {
    const elements = this.#elements;
    elements.closeButton.addEventListener('click', () => this.close());
    elements.chooseButton.addEventListener('click', () => this.#chooseFiles());
    elements.importButton.addEventListener('click', () => this.#runImport());
  }

  /**
   * Opens a native multi-file picker and classifies whatever was selected.
   * @returns {void}
   */
  #chooseFiles() {
    const input = createElement('input', { type: 'file', multiple: true, accept: 'application/json,.json,.html' });
    input.addEventListener('change', () => this.#onFilesChosen([...input.files]));
    input.click();
  }

  /**
   * Classifies the chosen files and shows what was found; Import stays disabled without a
   * conversations.json among them.
   * @param {File[]} files The chosen files.
   * @returns {Promise<void>} Resolves once the summary is shown.
   */
  async #onFilesChosen(files) {
    this.#selectedFiles = files;
    const classified = await ImportFileClassifier.classify(files);
    this.#elements.summary.innerHTML = ImportDialog.#detectionSummaryHtml(files.length, classified);
    this.#elements.importButton.disabled = !classified.conversationsJson;
  }

  /**
   * HTML listing what was detected among the chosen files.
   * @param {number} fileCount Number of files chosen.
   * @param {object} classified The classification result.
   * @returns {string} The summary.
   */
  static #detectionSummaryHtml(fileCount, classified) {
    const lines = ImportDialog.#DETECTION_LINES.map(line => line(classified));
    return `<p class="claude-plus-import-dialog__file-count">${fileCount} file(s) selected:</p><ul class="claude-plus-import-dialog__detection-list">${lines.map(line => `<li>${line}</li>`).join('')}</ul>`;
  }

  /**
   * One detection line per export category, each deciding its own found/missing wording.
   * @type {ReadonlyArray<function(object): string>}
   */
  static #DETECTION_LINES = [
    classified => (classified.conversationsJson ? `✓ Conversations (${classified.conversationsJson.length})` : '✕ No conversations.json found - required'),
    classified => (classified.memoriesJsons.length ? `✓ Memory files (${classified.memoriesJsons.flatMap(json => json.memory_files).length})` : '– No memory files'),
    classified => (classified.artifacts.length ? `✓ Artifacts (${classified.artifacts.length})` : '– No Artifacts'),
    classified => (classified.projectsJsons.length ? `✓ Projects (${classified.projectsJsons.length})` : '– No Projects'),
    classified => (classified.feedbackJsons.length ? `✓ Feedback periods (${classified.feedbackJsons.flatMap(json => json.reflections).length})` : '– No Feedback/reflections'),
    classified => (classified.usersJson ? '✓ Account profile' : '– No account profile'),
    classified => (classified.loginHistoryJson ? `✓ Login history (${classified.loginHistoryJson.login_events.length} events)` : '– No login history'),
  ];

  /**
   * Runs the import, shows a progress notice while it writes, then the result summary.
   * @returns {Promise<void>} Resolves once the result is shown or a failure is reported.
   */
  async #runImport() {
    this.#elements.importButton.disabled = true;
    this.#elements.summary.innerHTML = '<p class="claude-plus-import-dialog__progress">Importing…</p>';
    try {
      const result = await this.#orchestrator.importFiles(this.#selectedFiles);
      this.#elements.summary.innerHTML = ImportDialog.#resultSummaryHtml(result);
      this.#elements.chooseButton.hidden = true;
      this.#elements.importButton.hidden = true;
      this.#onImported();
    } catch (error) {
      await AlertDialog.inform(`Import failed: ${error.message}`);
      this.#elements.importButton.disabled = false;
    }
  }

  /**
   * HTML of the result summary shown once the import has written everything.
   * @param {object} result The orchestrator's result.
   * @returns {string} The summary.
   */
  static #resultSummaryHtml(result) {
    const { conversations } = result;
    const lines = [
      `${conversations.new} new conversation(s), ${conversations.changed} with new messages, ${conversations.renamedOnly} renamed, ${conversations.unchanged} unchanged`,
      `${result.memoryFiles.written} of ${result.memoryFiles.total} memory file(s) saved`,
      `${result.artifacts.written} of ${result.artifacts.total} Artifact(s) saved`,
      `${result.projects.written} of ${result.projects.total} Project(s) saved`,
      `${result.feedbackPeriods.written} of ${result.feedbackPeriods.total} Feedback period(s) saved`,
      `${result.loginEvents.written} of ${result.loginEvents.total} login event(s) saved`,
      result.accountProfile ? 'Account profile saved' : null,
    ].filter(Boolean);
    return `<p><strong>Import complete.</strong></p><ul class="claude-plus-import-dialog__detection-list">${lines.map(line => `<li>${line}</li>`).join('')}</ul>`;
  }
}
