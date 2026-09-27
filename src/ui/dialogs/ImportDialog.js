import { AlertDialog } from './AlertDialog.js';
import { ColumnTable } from '../tables/ColumnTable.js';
import { Dialog } from './Dialog.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { UNTITLED } from '../../config/UNTITLED.js';
import { collectNamedElements } from '../../dom/collectNamedElements.js';
import { createDateColumn } from '../tables/createDateColumn.js';
import { createElement } from '../../dom/createElement.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import stylesheet from './ImportDialog.css';

StyleRegistry.register(stylesheet);

/**
 * Imports a claude.ai data export: the user selects the files they extracted (conversations.json
 * is required; memories, Artifact, Project and account files are each independently optional, and
 * detected by content, not filename), reviews every conversation found - sortable, filterable,
 * individually selectable, classified against what's already imported - and the other categories as
 * simple toggles, then imports. Nothing is written until Import is clicked. conversations.json is
 * never read whole into memory: it's classified from a small prefix, previewed and imported by
 * streaming through it (see StreamingJsonArrayReader/ImportOrchestrator), so a real export's file -
 * routinely hundreds of megabytes - never blocks the tab or is held whole either way.
 */
export class ImportDialog extends Dialog {
  /**
   * Rows pre-checked by default: every classification except a truly unchanged conversation.
   * @type {ReadonlySet<string>}
   */
  static #DEFAULT_SELECTED_CLASSIFICATIONS = new Set(['new', 'changed', 'renamedOnly']);

  /**
   * Label shown for each classification.
   * @type {Readonly<Record<string, string>>}
   */
  static #CLASSIFICATION_LABELS = Object.freeze({ new: 'New', changed: 'Changed', renamedOnly: 'Renamed', unchanged: 'Unchanged' });

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
   * Ids of the conversations currently checked for import.
   * @type {Set<string>}
   */
  #selectedIds = new Set();

  /**
   * The conversation review table; created once scanning finishes.
   * @type {?ColumnTable}
   */
  #table = null;

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
   * Wires the file picker and the buttons.
   * @returns {void}
   */
  #bindEvents() {
    const elements = this.#elements;
    elements.closeButton.addEventListener('click', () => this.close());
    elements.chooseButton.addEventListener('click', () => this.#chooseFiles());
    elements.selectAllButton.addEventListener('click', () => this.#setAllSelected(true));
    elements.selectNoneButton.addEventListener('click', () => this.#setAllSelected(false));
    elements.importButton.addEventListener('click', () => this.#runImport());
    elements.dropZone.addEventListener('dragover', event => ImportDialog.#onDragOver(event));
    elements.dropZone.addEventListener('dragenter', () => elements.dropZone.classList.add('claude-plus-import-dialog__drop-zone--active'));
    elements.dropZone.addEventListener('dragleave', event => this.#onDragLeave(event));
    elements.dropZone.addEventListener('drop', event => this.#onDrop(event));
  }

  /**
   * Allows a drop by preventing the browser's default (opening the file instead of dropping it).
   * @param {DragEvent} event The drag-over.
   * @returns {void}
   */
  static #onDragOver(event) {
    event.preventDefault();
  }

  /**
   * Clears the drop zone's active styling once the drag actually leaves it, ignoring the events
   * fired for merely entering a child element.
   * @param {DragEvent} event The drag-leave.
   * @returns {void}
   */
  #onDragLeave(event) {
    if (!this.#elements.dropZone.contains(event.relatedTarget)) this.#elements.dropZone.classList.remove('claude-plus-import-dialog__drop-zone--active');
  }

  /**
   * Scans the files dropped onto the drop zone, the same as if they'd been chosen.
   * @param {DragEvent} event The drop.
   * @returns {Promise<void>} Resolves once the review table is shown or a failure is reported.
   */
  #onDrop(event) {
    event.preventDefault();
    this.#elements.dropZone.classList.remove('claude-plus-import-dialog__drop-zone--active');
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) return this.#onFilesChosen(files);
    return Promise.resolve();
  }

  /**
   * Opens a native multi-file picker and scans whatever was selected.
   * @returns {void}
   */
  #chooseFiles() {
    const input = createElement('input', { type: 'file', multiple: true, accept: 'application/json,.json,.html' });
    input.addEventListener('change', () => this.#onFilesChosen([...input.files]));
    input.click();
  }

  /**
   * Classifies the chosen files, then previews every conversation found; reports progress as it
   * streams, since a large export can take a while to scan.
   * @param {File[]} files The chosen files.
   * @returns {Promise<void>} Resolves once the review table is shown or a failure is reported.
   */
  async #onFilesChosen(files) {
    this.#elements.importButton.disabled = true;
    this.#elements.status.innerHTML = `<p class="claude-plus-import-dialog__progress">Scanning ${files.length} file(s)…</p>`;
    try {
      const preview = await this.#orchestrator.previewClassified(files, count => this.#showScanProgress(count));
      this.#preview = preview;
      this.#showReview(preview);
    } catch (error) {
      this.#elements.status.innerHTML = `<p class="claude-plus-import-dialog__progress">${escapeHtml(error.message)}</p>`;
    }
  }

  /**
   * Updates the scanning progress line.
   * @param {number} count Conversations classified so far.
   * @returns {void}
   */
  #showScanProgress(count) {
    this.#elements.status.innerHTML = `<p class="claude-plus-import-dialog__progress">Scanning… ${count} conversation(s) found so far.</p>`;
  }

  /**
   * Shows the category summary, builds the conversation review table with a smart default
   * selection, and enables Import.
   * @param {object} preview A previewClassified() result.
   * @returns {void}
   */
  #showReview(preview) {
    const { classified, conversationRows } = preview;
    this.#elements.status.innerHTML = ImportDialog.#categoryCountsHtml(conversationRows, classified);
    this.#elements.categories.hidden = false;
    this.#elements.categories.innerHTML = ImportDialog.#categoryToggleHtml(classified);
    this.#selectedIds = new Set(conversationRows.filter(row => ImportDialog.#DEFAULT_SELECTED_CLASSIFICATIONS.has(row.classification)).map(row => row.conversationId));
    this.#elements.selectionRow.hidden = false;
    this.#elements.tableHost.hidden = false;
    this.#buildTable(conversationRows);
    this.#refreshImportButton();
  }

  /**
   * Optional categories: how to count them in a classified result, their count line's noun phrase,
   * and the toggle they show when present (null for a category with no opt-out, like Artifacts).
   * @type {ReadonlyArray<{isPresent: function(object): boolean, count: function(object): number, countNoun: string, toggleKey: ?string, toggleLabel: ?string}>}
   */
  static #OPTIONAL_CATEGORIES = [
    {
      isPresent: classified => classified.memoriesJsons.length > 0,
      count: classified => classified.memoriesJsons.flatMap(json => json.memory_files).length,
      countNoun: 'memory file(s)', toggleKey: 'memoryFiles', toggleLabel: 'Import memory files',
    },
    {
      isPresent: classified => classified.artifacts.length > 0,
      count: classified => classified.artifacts.length,
      countNoun: 'Artifact(s)', toggleKey: null, toggleLabel: null,
    },
    {
      isPresent: classified => classified.projectsJsons.length > 0,
      count: classified => classified.projectsJsons.length,
      countNoun: 'Project(s)', toggleKey: 'projects', toggleLabel: 'Import Projects',
    },
    {
      isPresent: classified => classified.feedbackJsons.length > 0,
      count: classified => classified.feedbackJsons.flatMap(json => json.reflections).length,
      countNoun: 'Feedback period(s)', toggleKey: 'feedbackPeriods', toggleLabel: 'Import Feedback/reflections',
    },
    {
      isPresent: classified => Boolean(classified.usersJson) || Boolean(classified.loginHistoryJson),
      count: classified => (classified.loginHistoryJson?.login_events.length ?? 0),
      countNoun: 'login event(s), plus the account profile', toggleKey: 'accountMetadata', toggleLabel: 'Import account profile and login history',
    },
  ];

  /**
   * HTML summarizing how many of each category were found.
   * @param {object[]} conversationRows The previewed conversation rows.
   * @param {object} classified The classified files.
   * @returns {string} The summary.
   */
  static #categoryCountsHtml(conversationRows, classified) {
    const present = ImportDialog.#OPTIONAL_CATEGORIES.filter(category => category.isPresent(classified));
    const lines = [`${conversationRows.length} conversation(s)`, ...present.map(category => `${category.count(classified)} ${category.countNoun}`)];
    return `<p class="claude-plus-import-dialog__file-count">Found: ${lines.join(', ')}.</p>`;
  }

  /**
   * HTML of the optional-category toggles, one per toggleable category actually found.
   * @param {object} classified The classified files.
   * @returns {string} The toggles.
   */
  static #categoryToggleHtml(classified) {
    return ImportDialog.#OPTIONAL_CATEGORIES
      .filter(category => category.toggleKey && category.isPresent(classified))
      .map(category => `<label class="claude-plus-import-dialog__toggle"><input type="checkbox" data-category-toggle="${category.toggleKey}" checked /> ${escapeHtml(category.toggleLabel)}</label>`)
      .join('');
  }

  /**
   * Builds the conversation review table, keyed by selection state kept outside the table itself
   * so it survives re-sorting and re-filtering.
   * @param {object[]} conversationRows The previewed conversation rows.
   * @returns {void}
   */
  #buildTable(conversationRows) {
    this.#table = new ColumnTable({
      container: this.#elements.tableHost,
      tableId: 'importReview',
      columns: this.#columns(),
      preferences: this.#preferences,
      defaultSort: { column: 'date', direction: -1 },
      rowAttributes: row => `data-conversation-id="${escapeHtml(row.conversationId)}"`,
      emptyText: 'No conversations found.',
      maxRenderedRows: 2000,
    });
    this.#table.bodyElement.addEventListener('change', event => this.#onRowCheckboxChange(event));
    this.#table.setRows(conversationRows);
  }

  /**
   * The review table's columns.
   * @returns {TableColumn[]} The columns.
   */
  #columns() {
    return [
      { id: 'selected', label: '', isAlwaysVisible: true, isNotSortable: true, sortValue: () => 0, cellHtml: row => ImportDialog.#checkboxHtml(row, this.#selectedIds) },
      { id: 'name', label: 'Name', isAlwaysVisible: true, filter: 'values', sortValue: row => (row.title || '').toLowerCase(), filterValue: row => row.title || UNTITLED, cellHtml: row => escapeHtml(row.title || UNTITLED) },
      createDateColumn(row => row.updatedAt),
      { id: 'turns', label: 'Turns', isVisibleByDefault: true, sortValue: row => row.promptCount, cellHtml: row => String(row.promptCount) },
      { id: 'status', label: 'Status', isVisibleByDefault: true, filter: 'values', sortValue: row => row.classification, filterValue: row => ImportDialog.#CLASSIFICATION_LABELS[row.classification], cellHtml: row => ImportDialog.#statusBadgeHtml(row.classification) },
    ];
  }

  /**
   * HTML of one row's selection checkbox.
   * @param {{conversationId: string}} row The row.
   * @param {Set<string>} selectedIds Currently selected conversation ids.
   * @returns {string} The checkbox.
   */
  static #checkboxHtml(row, selectedIds) {
    const checked = selectedIds.has(row.conversationId) ? ' checked' : '';
    return `<input type="checkbox" data-select-row${checked} />`;
  }

  /**
   * HTML of a classification badge.
   * @param {string} classification The classification.
   * @returns {string} The badge.
   */
  static #statusBadgeHtml(classification) {
    const label = ImportDialog.#CLASSIFICATION_LABELS[classification] ?? classification;
    return `<span class="claude-plus-import-dialog__badge claude-plus-import-dialog__badge--${escapeHtml(classification)}">${escapeHtml(label)}</span>`;
  }

  /**
   * Records a row's checkbox change and refreshes the Import button's count.
   * @param {Event} event Change of a row checkbox.
   * @returns {void}
   */
  #onRowCheckboxChange(event) {
    const checkbox = event.target.closest('[data-select-row]');
    if (!checkbox) return;
    const conversationId = checkbox.closest('[data-conversation-id]').dataset.conversationId;
    if (checkbox.checked) this.#selectedIds.add(conversationId);
    else this.#selectedIds.delete(conversationId);
    this.#refreshImportButton();
  }

  /**
   * Selects or deselects every previewed conversation, then re-renders the table so its checkboxes
   * reflect the change.
   * @param {boolean} selected Whether every conversation should be selected.
   * @returns {void}
   */
  #setAllSelected(selected) {
    const rows = this.#preview.conversationRows;
    this.#selectedIds = selected ? new Set(rows.map(row => row.conversationId)) : new Set();
    this.#table.setRows(rows);
    this.#refreshImportButton();
  }

  /**
   * Updates the Import button's label with the current selection count.
   * @returns {void}
   */
  #refreshImportButton() {
    this.#elements.importButton.textContent = `Import selected (${this.#selectedIds.size})`;
    this.#elements.importButton.disabled = false;
  }

  /**
   * Runs the import over the current selection, shows progress while it writes, then the result.
   * @returns {Promise<void>} Resolves once the result is shown or a failure is reported.
   */
  async #runImport() {
    this.#elements.importButton.disabled = true;
    this.#elements.status.innerHTML = '<p class="claude-plus-import-dialog__progress">Importing…</p>';
    try {
      const classified = this.#classifiedWithToggles();
      const result = await this.#orchestrator.apply(classified, this.#preview.artifactRecords, this.#selectedIds, count => this.#showImportProgress(count));
      this.#showResult(result);
      this.#onImported();
    } catch (error) {
      await AlertDialog.inform(`Import failed: ${error.message}`);
      this.#refreshImportButton();
    }
  }

  /**
   * Classified-file fields cleared when a toggle is unchecked, by toggle key.
   * @type {Readonly<Record<string, string[]>>}
   */
  static #TOGGLE_FIELDS = Object.freeze({
    memoryFiles: ['memoriesJsons'],
    projects: ['projectsJsons'],
    feedbackPeriods: ['feedbackJsons'],
    accountMetadata: ['usersJson', 'loginHistoryJson'],
  });

  /**
   * The classified files, with any unchecked category toggle's data cleared.
   * @returns {object} The classified files to actually import.
   */
  #classifiedWithToggles() {
    const classified = { ...this.#preview.classified };
    for (const [toggleKey, fields] of Object.entries(ImportDialog.#TOGGLE_FIELDS)) {
      if (!this.#isToggleChecked(toggleKey)) fields.forEach(field => { classified[field] = Array.isArray(classified[field]) ? [] : null; });
    }
    return classified;
  }

  /**
   * Whether an optional-category toggle is checked; missing (not shown, since its category wasn't
   * found) counts as checked, since there's nothing for it to exclude.
   * @param {string} toggleKey The toggle's data-category-toggle value.
   * @returns {boolean} True when checked or absent.
   */
  #isToggleChecked(toggleKey) {
    return this.#elements.categories.querySelector(`[data-category-toggle="${toggleKey}"]`)?.checked ?? true;
  }

  /**
   * Updates the importing progress line.
   * @param {number} count Conversations processed so far (selected or not).
   * @returns {void}
   */
  #showImportProgress(count) {
    this.#elements.status.innerHTML = `<p class="claude-plus-import-dialog__progress">Importing… scanned ${count} conversation(s) so far.</p>`;
  }

  /**
   * Replaces the screen with the result summary.
   * @param {object} result The orchestrator's apply() result.
   * @returns {void}
   */
  #showResult(result) {
    const { conversations } = result;
    const lines = [
      `${conversations.new} new, ${conversations.changed} with new messages, ${conversations.renamedOnly} renamed, ${conversations.unchanged} unchanged among the selected conversations`,
      `${result.memoryFiles.written} of ${result.memoryFiles.total} memory file(s) saved`,
      `${result.artifacts.written} of ${result.artifacts.total} Artifact(s) saved`,
      `${result.projects.written} of ${result.projects.total} Project(s) saved`,
      `${result.feedbackPeriods.written} of ${result.feedbackPeriods.total} Feedback period(s) saved`,
      `${result.loginEvents.written} of ${result.loginEvents.total} login event(s) saved`,
      result.accountProfile ? 'Account profile saved' : null,
    ].filter(Boolean);
    this.#elements.status.innerHTML = `<p><strong>Import complete.</strong></p><ul class="claude-plus-import-dialog__detection-list">${lines.map(line => `<li>${line}</li>`).join('')}</ul>`;
    this.#elements.categories.hidden = true;
    this.#elements.selectionRow.hidden = true;
    this.#elements.tableHost.hidden = true;
    this.#elements.chooseButton.hidden = true;
    this.#elements.importButton.hidden = true;
  }
}
