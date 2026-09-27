import { isChatPaneId } from './isChatPaneId.js';

/**
 * Decides which border each chat pane shows: borders only appear while more than one chat pane
 * is visible, so the focused one can be told apart.
 */
export class ChatPaneBorders {
  /**
   * Whether more than one chat pane is visible at the moment.
   * @type {boolean}
   */
  #hasSeveralVisiblePanes = false;

  /**
   * Records which panels are visible after a layout.
   * @param {Set<string>} visiblePanelIds Ids of the visible panels.
   * @param {string[]} paneIds Ids of every chat pane.
   * @returns {boolean} True when the "several chat panes visible" state changed.
   */
  update(visiblePanelIds, paneIds) {
    const hasSeveral = paneIds.filter(paneId => visiblePanelIds.has(paneId)).length > 1;
    if (hasSeveral === this.#hasSeveralVisiblePanes) return false;
    this.#hasSeveralVisiblePanes = hasSeveral;
    return true;
  }

  /**
   * Which border a chat pane's tab and content should show, so its tab strip, frame and content
   * all agree: the focused pane gets the active (green) border, every other one a faint
   * theme-aware border, both only while more than one chat pane is visible. An id that isn't a
   * chat pane, or a chat pane while only one is visible, gets none.
   * @param {string} panelId Panel id.
   * @param {?string} focusedPaneId Id of the focused pane.
   * @returns {?('active'|'inactive')} The border kind, or null for none.
   */
  kindOf(panelId, focusedPaneId) {
    if (!isChatPaneId(panelId) || !this.#hasSeveralVisiblePanes) return null;
    return focusedPaneId === panelId ? 'active' : 'inactive';
  }
}
