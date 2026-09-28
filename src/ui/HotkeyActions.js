import { ConversationListPanel } from './panels/ConversationListPanel.js';
import { SearchPanel } from './panels/SearchPanel.js';

/**
 * The actions of the app's own hotkey commands (see HOTKEY_COMMANDS).
 */
export class HotkeyActions {
  /**
   * Workspace used to find and reveal panels.
   * @type {DockWorkspace}
   */
  #workspace;

  /**
   * Creates panels that are not docked yet.
   * @type {PanelFactory}
   */
  #panelFactory;

  /**
   * Chat panes, for the active chat.
   * @type {ChatPaneManager}
   */
  #paneManager;

  /**
   * Creates the actions.
   * @param {object} services What the actions work with.
   * @param {DockWorkspace} services.workspace Workspace used to find and reveal panels.
   * @param {PanelFactory} services.panelFactory Creates panels that are not docked yet.
   * @param {ChatPaneManager} services.paneManager Chat panes, for the active chat.
   */
  constructor({ workspace, panelFactory, paneManager }) {
    this.#workspace = workspace;
    this.#panelFactory = panelFactory;
    this.#paneManager = paneManager;
  }

  /**
   * The actions by command id.
   * @returns {Map<string, function(): void>} The actions.
   */
  toMap() {
    return new Map([
      ['findInChat', () => this.#paneManager.focusedPanel.toggleFind()],
      ['globalSearch', () => this.#openGlobalSearch()],
      ['focusChatList', () => this.#focusChatListSearch()],
    ]);
  }

  /**
   * Shows the first docked conversation list and focuses its search box; does nothing when none is docked.
   * @returns {void}
   */
  #focusChatListSearch() {
    const docked = this.#workspace.findDockedPanel(panel => panel instanceof ConversationListPanel);
    if (docked && this.#workspace.revealPanel(docked.panelId)) docked.panel.focusSearch();
  }

  /**
   * Shows the first docked search panel and focuses its query field, adding a search panel next to
   * the active chat when none is docked.
   * @returns {void}
   */
  #openGlobalSearch() {
    const docked = this.#workspace.findDockedPanel(panel => panel instanceof SearchPanel);
    if (docked) {
      this.#workspace.revealPanel(docked.panelId);
      docked.panel.focusQuery();
      return;
    }
    const { panelId, panel } = this.#panelFactory.createInstance('search');
    this.#workspace.addPanel(panelId, panel, this.#paneManager.focusedPaneId);
    panel.focusQuery();
  }
}
