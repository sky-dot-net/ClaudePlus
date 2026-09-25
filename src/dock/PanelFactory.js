import { ConversationListPanel } from '../ui/panels/ConversationListPanel.js';
import { FilesPanel } from '../ui/panels/FilesPanel.js';
import { SearchPanel } from '../ui/panels/SearchPanel.js';
import { StatsPanel } from '../ui/panels/StatsPanel.js';
import { WebSourcesPanel } from '../ui/panels/WebSourcesPanel.js';

/**
 * Creates view panels (chats list, stats, sources, files, search). Any number of instances of a
 * type can exist; they are independent views of the same shared data. Instance ids are the type
 * ("stats") for the first instance and "type#uuid" for added ones, so instances stored in a layout
 * can be recreated on the next visit.
 */
export class PanelFactory {
  /**
   * Menu label and constructor per view panel type, in menu order.
   * @type {Map<string, {label: string, create: function(object): Panel}>}
   */
  static #VIEW_TYPES = new Map([
    ['conversations', { label: 'Chats-list', create: services => new ConversationListPanel(services) }],
    ['stats', { label: 'Stats', create: services => new StatsPanel(services.stats, services.activity, services.rateLimits) }],
    ['webSources', { label: 'Sources', create: services => new WebSourcesPanel(services) }],
    ['files', { label: 'Files', create: services => new FilesPanel(services) }],
    ['search', { label: 'Search', create: services => new SearchPanel(services) }],
  ]);

  /**
   * Services passed to the panel constructors.
   * @type {object}
   */
  #services;

  /**
   * Workspace the panels live in; set by attachWorkspace.
   * @type {?DockWorkspace}
   */
  #workspace = null;

  /**
   * Creates the factory.
   * @param {object} services Services passed to the panel constructors.
   * @param {ConversationDirectory} services.directory Shared conversation list.
   * @param {Router} services.router Navigation.
   * @param {ChatPaneManager} services.paneManager Chat panes.
   * @param {StatsIndex} services.stats Conversation statistics.
   * @param {ActivityTracker} services.activity Active-time tracking.
   * @param {RateLimitMonitor} services.rateLimits Usage windows.
   * @param {Preferences} services.preferences Settings storage.
   */
  constructor(services) {
    this.#services = services;
  }

  /**
   * Ids of the default instance of every view type.
   * @returns {string[]} The ids.
   */
  static get defaultPanelIds() {
    return [...PanelFactory.#VIEW_TYPES.keys()];
  }

  /**
   * Connects the workspace, which removes panels when they are closed.
   * @param {DockWorkspace} workspace The workspace.
   * @returns {void}
   */
  attachWorkspace(workspace) {
    this.#workspace = workspace;
  }

  /**
   * Whether an id belongs to a view panel instance.
   * @param {string} panelId Panel id.
   * @returns {boolean} True when its type is a view type.
   */
  isViewPanelId(panelId) {
    return PanelFactory.#VIEW_TYPES.has(PanelFactory.#typeOf(panelId));
  }

  /**
   * Creates the view panel with an id; closing it removes it from the workspace.
   * @param {string} panelId Panel id of a view type.
   * @returns {Panel} The panel.
   */
  create(panelId) {
    const panel = PanelFactory.#VIEW_TYPES.get(PanelFactory.#typeOf(panelId)).create(this.#services);
    panel.setCloseHandler(() => this.#workspace.removePanel(panelId));
    return panel;
  }

  /**
   * Creates a new instance of a view type with a new id.
   * @param {string} type View type.
   * @returns {{panelId: string, panel: Panel}} The id and the panel.
   */
  createInstance(type) {
    const panelId = `${type}#${crypto.randomUUID()}`;
    return { panelId, panel: this.create(panelId) };
  }

  /**
   * Entries of a zone's "+" menu.
   * @returns {ChoiceOption[]} "Add chat", then one "Add … panel" entry per view type.
   */
  addMenuEntries() {
    return [{ id: 'chat', label: 'Add chat' }, ...[...PanelFactory.#VIEW_TYPES].map(([type, definition]) => ({ id: type, label: `Add ${definition.label} panel` }))];
  }

  /**
   * Type part of a panel id.
   * @param {string} panelId Panel id.
   * @returns {string} Everything before the first "#".
   */
  static #typeOf(panelId) {
    return String(panelId).split('#')[0];
  }
}
