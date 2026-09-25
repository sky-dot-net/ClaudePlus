import { Dialog } from './Dialog.js';
import { ImageZoomPan } from './ImageZoomPan.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { createElement } from '../../dom/createElement.js';
import stylesheet from './ImageViewerDialog.css';

StyleRegistry.register(stylesheet);

/**
 * Shows an image at full size over a dark backdrop, capped at 90% of the viewport. Scrolling zooms;
 * dragging pans. A button below opens the same image in a new browser tab.
 */
export class ImageViewerDialog extends Dialog {
  /**
   * Image URL.
   * @type {string}
   */
  #imageUrl;

  /**
   * Alt text of the image.
   * @type {string}
   */
  #altText;

  /**
   * Creates the viewer without showing it.
   * @param {string} imageUrl Image URL.
   * @param {string} altText Alt text of the image.
   */
  constructor(imageUrl, altText) {
    super();
    this.#imageUrl = imageUrl;
    this.#altText = altText;
  }

  /**
   * CSS class of the dark overlay stacking the image and the button.
   * @returns {string} The class name.
   */
  get overlayClassName() {
    return 'claude-plus-image-viewer-overlay';
  }

  /**
   * Builds the zoomable image frame and the button opening the image in a new tab.
   * @returns {HTMLElement[]} The frame and the button.
   */
  createContent() {
    const image = createElement('img', { className: 'claude-plus-image-viewer__image', src: this.#imageUrl, alt: this.#altText });
    const frame = createElement('div', { className: 'claude-plus-image-viewer__frame' });
    frame.append(image);
    new ImageZoomPan(frame, image);
    const openButton = createElement('button', {
      className: 'claude-plus-toolbar__button claude-plus-image-viewer__open-button',
      textContent: 'Open in new window',
    });
    openButton.addEventListener('click', () => window.open(this.#imageUrl, '_blank', 'noopener'));
    return [frame, openButton];
  }
}
