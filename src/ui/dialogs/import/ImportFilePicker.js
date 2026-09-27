import { createElement } from '../../../dom/createElement.js';

/**
 * The import screen's file intake: a native multi-file picker behind a button, plus a drop zone
 * accepting the same files dragged in. Either way the files go to one callback.
 */
export class ImportFilePicker {
  /**
   * CSS class marking the drop zone while files are dragged over it.
   * @type {string}
   */
  static #ACTIVE_CLASS = 'claude-plus-import-dialog__drop-zone--active';

  /**
   * Area accepting dropped files.
   * @type {HTMLElement}
   */
  #dropZone;

  /**
   * Button opening the native picker.
   * @type {HTMLElement}
   */
  #chooseButton;

  /**
   * Called with the chosen or dropped files.
   * @type {function(File[]): Promise<void>}
   */
  #onFiles;

  /**
   * Creates the picker without wiring it.
   * @param {object} parts Picker parts.
   * @param {HTMLElement} parts.dropZone Area accepting dropped files.
   * @param {HTMLElement} parts.chooseButton Button opening the native picker.
   * @param {function(File[]): Promise<void>} parts.onFiles Called with the chosen or dropped files.
   */
  constructor({ dropZone, chooseButton, onFiles }) {
    this.#dropZone = dropZone;
    this.#chooseButton = chooseButton;
    this.#onFiles = onFiles;
  }

  /**
   * Wires the choose button and the drop zone.
   * @returns {void}
   */
  install() {
    const dropZone = this.#dropZone;
    this.#chooseButton.addEventListener('click', () => this.#chooseFiles());
    dropZone.addEventListener('dragover', event => ImportFilePicker.#onDragOver(event));
    dropZone.addEventListener('dragenter', () => dropZone.classList.add(ImportFilePicker.#ACTIVE_CLASS));
    dropZone.addEventListener('dragleave', event => this.#onDragLeave(event));
    dropZone.addEventListener('drop', event => this.#onDrop(event));
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
    if (!this.#dropZone.contains(event.relatedTarget)) this.#dropZone.classList.remove(ImportFilePicker.#ACTIVE_CLASS);
  }

  /**
   * Hands the files dropped onto the drop zone over, the same as if they'd been chosen.
   * @param {DragEvent} event The drop.
   * @returns {Promise<void>} Resolves once the dropped files are handled.
   */
  #onDrop(event) {
    event.preventDefault();
    this.#dropZone.classList.remove(ImportFilePicker.#ACTIVE_CLASS);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) return this.#onFiles(files);
    return Promise.resolve();
  }

  /**
   * Opens a native multi-file picker and hands whatever was selected over.
   * @returns {void}
   */
  #chooseFiles() {
    const input = createElement('input', { type: 'file', multiple: true, accept: 'application/json,.json,.html' });
    input.addEventListener('change', () => this.#onFiles([...input.files]));
    input.click();
  }
}
