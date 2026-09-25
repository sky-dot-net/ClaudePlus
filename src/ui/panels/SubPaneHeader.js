import { escapeHtml } from '../../text/escapeHtml.js';

/**
 * The header shared by every dockable sub-pane: a title, dock-edge arrows and a close button.
 */
export class SubPaneHeader {
  /**
   * HTML of the header.
   * @param {string} title Header title.
   * @returns {string} The header element's HTML.
   */
  static html(title) {
    return `
      <header class="claude-plus-subpane__header">
        <span class="claude-plus-subpane__title">${escapeHtml(title)}</span>
        <button class="claude-plus-subpane__button" data-edge="left" title="Dock left">←</button>
        <button class="claude-plus-subpane__button" data-edge="top" title="Dock top">↑</button>
        <button class="claude-plus-subpane__button" data-edge="right" title="Dock right">→</button>
        <button class="claude-plus-subpane__button" data-action="close" title="Close">×</button>
      </header>`;
  }

  /**
   * Runs the clicked header button: a dock arrow or close.
   * @param {MouseEvent} event Click inside the header.
   * @param {function(): void} onClose Close callback.
   * @param {function(string): void} onMove Redock callback, called with 'left', 'top' or 'right'.
   * @returns {void}
   */
  static onClick(event, onClose, onMove) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.edge) onMove(button.dataset.edge);
    else onClose();
  }
}
