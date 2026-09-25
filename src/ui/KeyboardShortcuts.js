import { ConversationListPanel } from './panels/ConversationListPanel.js';

/**
 * Global keyboard shortcuts. Cmd+K (Ctrl+K elsewhere) reveals a conversation list and focuses
 * its search. Shortcuts are handled in the capture phase and stopped there, so claude.ai's own
 * hidden app never reacts to them.
 */
export class KeyboardShortcuts {
  /**
   * Workspace used to reveal panels.
   * @type {DockWorkspace}
   */
  #workspace;

  /**
   * Creates the shortcuts.
   * @param {DockWorkspace} workspace Workspace used to find and reveal panels.
   */
  constructor(workspace) {
    this.#workspace = workspace;
  }

  /**
   * Starts listening for the shortcuts.
   * @returns {void}
   */
  install() {
    window.addEventListener('keydown', this.#handleKeydown, true);
  }

  /**
   * Runs the shortcut matching a key press.
   * @param {KeyboardEvent} event The key press.
   * @returns {void}
   */
  #handleKeydown = (event) => {
    if (!KeyboardShortcuts.#isSearchShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.#focusConversationSearch();
  };

  /**
   * Whether a key press is the search shortcut.
   * @param {KeyboardEvent} event The key press.
   * @returns {boolean} True for Cmd+K or Ctrl+K without Shift or Alt.
   */
  static #isSearchShortcut(event) {
    return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k';
  }

  /**
   * Shows the first docked conversation list and focuses its search box; does nothing when none is docked.
   * @returns {void}
   */
  #focusConversationSearch() {
    const docked = this.#workspace.findDockedPanel(panel => panel instanceof ConversationListPanel);
    if (docked && this.#workspace.revealPanel(docked.panelId)) docked.panel.focusSearch();
  }
}
