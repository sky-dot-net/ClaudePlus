import { AlertDialog } from '../dialogs/AlertDialog.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import stylesheet from './StagedFileList.css';

StyleRegistry.register(stylesheet);

/**
 * The files attached to the next prompt, shown as removable chips. Each file is uploaded as soon
 * as it is attached; a failed upload is dropped and reported rather than kept as a chip.
 */
export class StagedFileList {
  /**
   * Element showing the chips; hidden while the list is empty.
   * @type {HTMLElement}
   */
  #container;

  /**
   * Uploads a file to the conversation of the next prompt.
   * @type {function(File): Promise<UploadedFile>}
   */
  #uploadFile;

  /**
   * Staged files, in attachment order.
   * @type {StagedFile[]}
   */
  #stagedFiles = [];

  /**
   * Creates the list and handles clicks on the chips' remove buttons.
   * @param {HTMLElement} container Element showing the chips.
   * @param {function(File): Promise<UploadedFile>} uploadFile Uploads a file to the conversation of the next prompt.
   */
  constructor(container, uploadFile) {
    this.#container = container;
    this.#uploadFile = uploadFile;
    container.addEventListener('click', event => this.#onRemoveClick(event));
  }

  /**
   * Whether any upload is still in flight.
   * @returns {boolean} True while uploading.
   */
  get isUploading() {
    return this.#stagedFiles.some(stagedFile => stagedFile.isUploading);
  }

  /**
   * Uploads a file and shows it as a chip, updated once the upload settles.
   * @param {File} file File to attach.
   * @returns {Promise<void>} Resolves once uploaded, or once a failure has been reported.
   */
  async attach(file) {
    const key = crypto.randomUUID();
    this.#setStagedFiles([...this.#stagedFiles, { key, name: file.name, isUploading: true, upload: null }]);
    try {
      const upload = await this.#uploadFile(file);
      this.#update(key, { isUploading: false, upload });
    } catch (error) {
      this.#remove(key);
      await AlertDialog.inform(`Uploading "${file.name}" failed: ${error.message}`);
    }
  }

  /**
   * Returns the finished uploads and empties the list.
   * @returns {UploadedFile[]} The uploads, in attachment order.
   */
  takeUploads() {
    const uploads = this.#stagedFiles.map(stagedFile => stagedFile.upload);
    this.#setStagedFiles([]);
    return uploads;
  }

  /**
   * Discards every staged file, without cancelling uploads in flight; a late upload result is
   * ignored once its entry is gone.
   * @returns {void}
   */
  clear() {
    if (this.#stagedFiles.length) this.#setStagedFiles([]);
  }

  /**
   * Merges changes into a staged file, unless it was removed while its upload was in flight.
   * @param {string} key Entry key.
   * @param {Partial<StagedFile>} changes Fields to merge in.
   * @returns {void}
   */
  #update(key, changes) {
    if (!this.#stagedFiles.some(stagedFile => stagedFile.key === key)) return;
    this.#setStagedFiles(this.#stagedFiles.map(stagedFile => (stagedFile.key === key ? { ...stagedFile, ...changes } : stagedFile)));
  }

  /**
   * Removes a staged file.
   * @param {string} key Entry key.
   * @returns {void}
   */
  #remove(key) {
    this.#setStagedFiles(this.#stagedFiles.filter(stagedFile => stagedFile.key !== key));
  }

  /**
   * Removes the staged file whose remove button was clicked.
   * @param {MouseEvent} event Click inside the chip row.
   * @returns {void}
   */
  #onRemoveClick(event) {
    const button = event.target.closest('[data-key]');
    if (button) this.#remove(button.dataset.key);
  }

  /**
   * Replaces the staged files and redraws the chips, hiding the row when there are none.
   * @param {StagedFile[]} stagedFiles New list.
   * @returns {void}
   */
  #setStagedFiles(stagedFiles) {
    this.#stagedFiles = stagedFiles;
    this.#container.hidden = stagedFiles.length === 0;
    this.#container.innerHTML = stagedFiles.map(stagedFile => StagedFileList.#chipHtml(stagedFile)).join('');
  }

  /**
   * HTML of one chip: a thumbnail for an uploaded image, else a generic file icon.
   * @param {StagedFile} stagedFile The staged file.
   * @returns {string} The chip.
   */
  static #chipHtml(stagedFile) {
    const thumbnailHtml = stagedFile.upload?.thumbnail_url
      ? `<img class="claude-plus-staged-file__thumb" src="${escapeHtml(stagedFile.upload.thumbnail_url)}" alt="" />`
      : '<span class="claude-plus-staged-file__icon">📎</span>';
    const stateClass = stagedFile.isUploading ? ' claude-plus-staged-file--uploading' : '';
    return `
      <span class="claude-plus-staged-file${stateClass}">
        ${thumbnailHtml}
        <span class="claude-plus-staged-file__name">${escapeHtml(stagedFile.name)}</span>
        <button class="claude-plus-staged-file__remove" data-key="${escapeHtml(stagedFile.key)}" title="Remove">×</button>
      </span>`;
  }
}
