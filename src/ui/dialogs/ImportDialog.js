import { AlertDialog } from './AlertDialog.js';
import { Dialog } from './Dialog.js';
import { ImportCategoryToggles } from './import/ImportCategoryToggles.js';
import { ImportFilePicker } from './import/ImportFilePicker.js';
import { ImportReviewTable } from './import/ImportReviewTable.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { collectNamedElements } from '../../dom/collectNamedElements.js';
import { createElement } from '../../dom/createElement.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import { importFoundSummaryHtml } from './import/importFoundSummaryHtml.js';
import { importResultHtml } from './import/importResultHtml.js';
import stylesheet from './ImportDialog.css';

StyleRegistry.register(stylesheet);

/**
 * Imports a claude.ai data export: the user selects the files they extracted (conversations.json
 * is required; memories, Artifact, Project and account files are each independently optional, and
 * detected by content, not filename), reviews every conversation found and the other categories as
 * simple toggles, then imports. Nothing is written until Import is clicked. conversations.json is
 * never read whole into memory: it's classified from a small prefix, previewed and imported by
 * streaming through it (see StreamingJsonArrayReader/ImportOrchestrator), so a real export's file -
 * routinely hundreds of megabytes - never blocks the tab or is held whole either way.
 */
export class ImportDialog extends Dialog {
  /**
   * Runs the import once files are confirmed.
   * @type {ImportOrchestrator}
   */
  #orchestrator;

  /**
   * Table settings storage.
   * @type {Preferences}
   */
  #preferences;

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
   * A previewClassified() result, once scanning has finished.
   * @type {?object}
   */
  #preview = null;

  /**
   * Opt-out checkboxes of the optional categories; set once the content is built.
   * @type {?ImportCategoryToggles}
   */
  #toggles = null;

  /**
   * The conversation review table; set once the content is built.
   * @type {?ImportReviewTable}
   */
  #reviewTable = null;

  /**
   * Creates the dialog without showing it.
   * @param {ImportOrchestrator} orchestrator Runs the import once files are confirmed.
   * @param {Preferences} preferences Table settings storage.
   * @param {function(): void} onImported Called once an import has actually written anything.
   */
  constructor(orchestrator, preferences, onImported) {
    super();
    this.#orchestrator = orchestrator;
    this.#preferences = preferences;
    this.#onImported = onImported;
  }

  /**
   * Opens the import screen.
   * @param {ImportOrchestrator} orchestrator Runs the import once files are confirmed.
   * @param {Preferences} preferences Table settings storage.
   * @param {function(): void} onImported Called once an import has actually written anything.
   * @returns {Promise<void>} Resolves once closed.
   */
  static open(orchestrator, preferences, onImported) {
    return new ImportDialog(orchestrator, preferences, onImported).show();
  }

  /**
   * CSS class of the dimmed overlay centering the screen.
   * @returns {string} The class name.
   */
  get overlayClassName() {
    return 'claude-plus-import-overlay';
  }

  /**
   * Builds the screen and its parts.
   * @returns {HTMLElement[]} The screen.
   */
  createContent() {
    const box = createElement('div', { className: 'claude-plus-import-dialog', innerHTML: ImportDialog.#bodyHtml() });
    const elements = collectNamedElements(box);
    this.#elements = elements;
    this.#toggles = new ImportCategoryToggles(elements.categories);
    this.#reviewTable = new ImportReviewTable({
      host: elements.tableHost, selectionRow: elements.selectionRow, selectAllButton: elements.selectAllButton, selectNoneButton: elements.selectNoneButton,
      preferences: this.#preferences, onSelectionChange: () => this.#refreshImportButton(),
    });
    new ImportFilePicker({ dropZone: elements.dropZone, chooseButton: elements.chooseButton, onFiles: files => this.#onFilesChosen(files) }).install();
    elements.closeButton.addEventListener('click', () => this.close());
    elements.importButton.addEventListener('click', () => this.#runImport());
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
      <div class="claude-plus-import-dialog__drop-zone" data-name="dropZone">
        <button class="claude-plus-toolbar__button" data-name="chooseButton">Choose files…</button>
        <span>or drag and drop them here</span>
      </div>
      <div data-name="status"></div>
      <div class="claude-plus-import-dialog__categories" data-name="categories" hidden></div>
      <div class="claude-plus-import-dialog__row" data-name="selectionRow" hidden>
        <button class="claude-plus-toolbar__button" data-name="selectAllButton">Select all</button>
        <button class="claude-plus-toolbar__button" data-name="selectNoneButton">Select none</button>
      </div>
      <div class="claude-plus-import-dialog__table-host" data-name="tableHost" hidden></div>
      <div class="claude-plus-import-dialog__row">
        <button class="claude-plus-primary-button" data-name="importButton" disabled>Import</button>
      </div>`;
  }

  /**
   * Classifies the chosen files, then previews every conversation found; reports progress as it
   * streams, since a large export can take a while to scan.
   * @param {File[]} files The chosen files.
   * @returns {Promise<void>} Resolves once the review table is shown or a failure is reported.
   */
  async #onFilesChosen(files) {
    this.#elements.importButton.disabled = true;
    this.#showProgress(`Scanning ${files.length} file(s)…`);
    try {
      this.#preview = await this.#orchestrator.previewClassified(files, count => this.#showProgress(`Scanning… ${count} conversation(s) found so far.`));
      this.#showReview();
    } catch (error) {
      this.#showProgress(error.message);
    }
  }

  /**
   * Shows the category summary and toggles and the conversation review table, and enables Import.
   * @returns {void}
   */
  #showReview() {
    this.#elements.status.innerHTML = importFoundSummaryHtml(this.#preview);
    this.#toggles.show(this.#preview.classified);
    this.#reviewTable.show(this.#preview.conversationRows);
    this.#refreshImportButton();
  }

  /**
   * Updates the Import button's label with the current selection count.
   * @returns {void}
   */
  #refreshImportButton() {
    this.#elements.importButton.textContent = `Import selected (${this.#reviewTable.selectedIds.size})`;
    this.#elements.importButton.disabled = false;
  }

  /**
   * Runs the import over the current selection, shows progress while it writes, then the result.
   * @returns {Promise<void>} Resolves once the result is shown or a failure is reported.
   */
  async #runImport() {
    this.#elements.importButton.disabled = true;
    this.#showProgress('Importing…');
    try {
      const classified = this.#toggles.applyTo(this.#preview.classified);
      const result = await this.#orchestrator.apply(classified, this.#preview.artifactRecords, this.#reviewTable.selectedIds, count => this.#showProgress(`Importing… scanned ${count} conversation(s) so far.`));
      this.#showResult(result);
      this.#onImported();
    } catch (error) {
      await AlertDialog.inform(`Import failed: ${error.message}`);
      this.#refreshImportButton();
    }
  }

  /**
   * Replaces the status line with a progress or failure message.
   * @param {string} text The message.
   * @returns {void}
   */
  #showProgress(text) {
    this.#elements.status.innerHTML = `<p class="claude-plus-import-dialog__progress">${escapeHtml(text)}</p>`;
  }

  /**
   * Replaces the screen with the result summary.
   * @param {object} result The orchestrator's apply() result.
   * @returns {void}
   */
  #showResult(result) {
    this.#elements.status.innerHTML = importResultHtml(result);
    this.#toggles.hide();
    this.#reviewTable.hide();
    this.#elements.chooseButton.hidden = true;
    this.#elements.importButton.hidden = true;
  }
}
