import { placeElement } from '../dom/placeElement.js';

/**
 * The panels known to the workspace, by id, docked or not. Adds a panel's element to the page on
 * first show, positions it, and hides the ones not visible in the current layout.
 */
export class PanelHost {
  /**
   * Panels by id.
   * @type {Map<string, Panel>}
   */
  #panelsById;

  /**
   * Creates the host.
   * @param {Map<string, Panel>} panelsById Initial panels by id; the map is taken over, not copied.
   */
  constructor(panelsById) {
    this.#panelsById = panelsById;
  }

  /**
   * Ids of all known panels.
   * @returns {string[]} The ids.
   */
  get panelIds() {
    return [...this.#panelsById.keys()];
  }

  /**
   * All known panels with their ids.
   * @returns {Array<[string, Panel]>} Id and panel pairs.
   */
  get entries() {
    return [...this.#panelsById];
  }

  /**
   * Makes a panel known, replacing one with the same id.
   * @param {string} panelId Panel id.
   * @param {Panel} panel The panel.
   * @returns {void}
   */
  add(panelId, panel) {
    this.#panelsById.set(panelId, panel);
  }

  /**
   * Whether a panel is known.
   * @param {string} panelId Panel id.
   * @returns {boolean} True when it is known.
   */
  has(panelId) {
    return this.#panelsById.has(panelId);
  }

  /**
   * Forgets a panel and disposes it.
   * @param {string} panelId Panel id.
   * @returns {boolean} True when the panel was known.
   */
  remove(panelId) {
    const panel = this.#panelsById.get(panelId);
    if (!panel) return false;
    this.#panelsById.delete(panelId);
    panel.dispose();
    return true;
  }

  /**
   * Title of a panel.
   * @param {string} panelId Panel id.
   * @returns {string} Its title, or the id for an unknown panel.
   */
  titleOf(panelId) {
    const panel = this.#panelsById.get(panelId);
    return panel ? panel.title : panelId;
  }

  /**
   * Whether a panel may be closed by the user.
   * @param {string} panelId Panel id.
   * @returns {boolean} True when the panel is known and allows closing.
   */
  canClose(panelId) {
    const panel = this.#panelsById.get(panelId);
    return Boolean(panel) && panel.canClose();
  }

  /**
   * Asks a panel to close itself.
   * @param {string} panelId Panel id.
   * @returns {void}
   */
  close(panelId) {
    this.#panelsById.get(panelId)?.close();
  }

  /**
   * Positions and shows a panel, adding it to the page on first use. Unknown ids are ignored.
   * @param {string} panelId Panel id.
   * @param {Rect} contentRect Area the panel fills.
   * @returns {void}
   */
  show(panelId, contentRect) {
    const panel = this.#panelsById.get(panelId);
    if (!panel) return;
    const { element } = panel;
    if (!element.isConnected) document.body.append(element);
    placeElement(element, contentRect);
    element.style.visibility = 'visible';
  }

  /**
   * Hides every built panel that isn't visible.
   * @param {Set<string>} visiblePanelIds Ids of the visible panels.
   * @returns {void}
   */
  hideAllExcept(visiblePanelIds) {
    for (const [panelId, panel] of this.#panelsById) {
      if (!visiblePanelIds.has(panelId) && panel.isBuilt) panel.element.style.visibility = 'hidden';
    }
  }
}
