import { DragGesture } from '../../dom/DragGesture.js';
import { clamp } from '../../math/clamp.js';
import { createElement } from '../../dom/createElement.js';

/**
 * Opens a full-size view of an image over a dark backdrop, capped at 90% of the viewport.
 * Scrolling zooms; dragging pans once the image is too big to fit fully. A button below opens the
 * same image in a new browser tab.
 * @param {string} src Image URL.
 * @param {string} altText Alt text for the image.
 * @returns {void}
 */
export function openImageViewer(src, altText) {
  const overlay = createElement('div', { className: 'claude-plus-themed claude-plus-image-viewer-overlay' });
  const frame = createElement('div', { className: 'claude-plus-image-viewer__frame' });
  const image = createElement('img', { className: 'claude-plus-image-viewer__image', src, alt: altText });
  const openButton = createElement('button', {
    className: 'claude-plus-toolbar__button claude-plus-image-viewer__open-button',
    textContent: 'Open in new window',
  });
  frame.append(image);
  overlay.append(frame, openButton);
  document.body.append(overlay);

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  const applyTransform = () => {
    image.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  };
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
  };
  const onKeydown = event => {
    if (event.key === 'Escape') close();
  };

  frame.addEventListener('wheel', event => {
    event.preventDefault();
    const previousScale = scale;
    scale = clamp(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 8);
    const scaleRatio = scale / previousScale;
    offsetX *= scaleRatio;
    offsetY *= scaleRatio;
    applyTransform();
  }, { passive: false });
  image.addEventListener('mousedown', startEvent => {
    startEvent.preventDefault();
    const startOffsetX = offsetX;
    const startOffsetY = offsetY;
    new DragGesture(startEvent, {
      threshold: 0,
      onMove: event => {
        offsetX = startOffsetX + (event.clientX - startEvent.clientX);
        offsetY = startOffsetY + (event.clientY - startEvent.clientY);
        applyTransform();
      },
      onEnd: () => undefined,
    });
  });
  openButton.addEventListener('click', () => window.open(src, '_blank', 'noopener'));
  overlay.addEventListener('mousedown', event => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown);
}
