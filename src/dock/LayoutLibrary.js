import { ChatPaneManager } from '../chat/ChatPaneManager.js';
import { DockTree } from './DockTree.js';
import { STORAGE_KEYS } from '../config/STORAGE_KEYS.js';

/**
 * Named layouts: saves the current dock arrangement together with each chat pane's conversation,
 * and restores a saved one, recreating the panels it needs.
 */
export class LayoutLibrary {
  /**
   * Storage of the saved layouts.
   * @type {Preferences}
   */
  #preferences;

  /**
   * The workspace.
   * @type {DockWorkspace}
   */
  #workspace;

  /**
   * Chat panes.
   * @type {ChatPaneManager}
   */
  #paneManager;

  /**
   * Creates view panels a layout needs.
   * @type {PanelFactory}
   */
  #panelFactory;

  /**
   * Creates the library.
   * @param {object} services Library dependencies.
   * @param {Preferences} services.preferences Storage of the saved layouts.
   * @param {DockWorkspace} services.workspace The workspace.
   * @param {ChatPaneManager} services.paneManager Chat panes.
   * @param {PanelFactory} services.panelFactory Creates view panels a layout needs.
   */
  constructor({ preferences, workspace, paneManager, panelFactory }) {
    this.#preferences = preferences;
    this.#workspace = workspace;
    this.#paneManager = paneManager;
    this.#panelFactory = panelFactory;
  }

  /**
   * Names of the saved layouts.
   * @returns {string[]} The names, sorted.
   */
  names() {
    return Object.keys(this.#readAll()).sort((first, second) => first.localeCompare(second));
  }

  /**
   * Saves the current arrangement under a name, replacing a layout of the same name.
   * @param {string} name Layout name.
   * @returns {void}
   */
  save(name) {
    const layouts = this.#readAll();
    layouts[name] = { tree: this.#workspace.layoutSnapshot(), chatPanes: this.#paneManager.storedPanes() };
    this.#preferences.writeJson(STORAGE_KEYS.savedLayouts, layouts);
  }

  /**
   * Restores a saved layout: creates the panels it references that don't exist, applies its
   * arrangement and closes the panels it doesn't contain. Unknown names are ignored.
   * @param {string} name Layout name.
   * @returns {void}
   */
  load(name) {
    const layout = this.#readAll()[name];
    if (!layout) return;
    const conversationByPane = new Map((Array.isArray(layout.chatPanes) ? layout.chatPanes : []).map(pane => [pane.paneId, pane.conversationId]));
    DockTree.collectPanelIds(layout.tree).forEach(panelId => this.#ensurePanel(panelId, conversationByPane.get(panelId) ?? null));
    this.#workspace.replaceLayout(layout.tree);
  }

  /**
   * Deletes a saved layout.
   * @param {string} name Layout name.
   * @returns {void}
   */
  remove(name) {
    const layouts = this.#readAll();
    delete layouts[name];
    this.#preferences.writeJson(STORAGE_KEYS.savedLayouts, layouts);
  }

  /**
   * Creates a panel referenced by a layout if it doesn't exist yet; unknown ids are ignored.
   * @param {string} panelId Panel id from the layout.
   * @param {?string} conversationId Conversation of a chat pane, or null.
   * @returns {void}
   */
  #ensurePanel(panelId, conversationId) {
    if (this.#workspace.hasPanel(panelId)) return;
    if (ChatPaneManager.isPaneId(panelId)) this.#workspace.registerPanel(panelId, this.#paneManager.createPaneForLayout(panelId, conversationId));
    else if (this.#panelFactory.isViewPanelId(panelId)) this.#workspace.registerPanel(panelId, this.#panelFactory.create(panelId));
  }

  /**
   * The saved layouts.
   * @returns {Object<string, {tree: DockNode, chatPanes: Array<{paneId: string, conversationId: ?string}>}>} Layouts by name; empty when nothing valid is stored.
   */
  #readAll() {
    const stored = this.#preferences.readJson(STORAGE_KEYS.savedLayouts);
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  }
}
