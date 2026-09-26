import { ActivityTracker } from '../stats/ActivityTracker.js';
import { ChatPaneManager } from '../chat/ChatPaneManager.js';
import { ClaudeApi } from '../api/ClaudeApi.js';
import { ComposerPanel } from '../ui/panels/ComposerPanel.js';
import { ComposerSettings } from '../chat/ComposerSettings.js';
import { ConversationDirectory } from '../chat/ConversationDirectory.js';
import { ConversationExporter } from '../export/ConversationExporter.js';
import { DATABASE } from '../config/DATABASE.js';
import { DockTree } from '../dock/DockTree.js';
import { DockWorkspace } from '../dock/DockWorkspace.js';
import { IndexedDbStore } from '../core/IndexedDbStore.js';
import { KeyboardShortcuts } from '../ui/KeyboardShortcuts.js';
import { LAYOUT } from '../config/LAYOUT.js';
import { LOG_PREFIX } from '../config/LOG_PREFIX.js';
import { LayoutLibrary } from '../dock/LayoutLibrary.js';
import { ModelCatalog } from '../models/ModelCatalog.js';
import { PanelFactory } from '../dock/PanelFactory.js';
import { Preferences } from '../core/Preferences.js';
import { RateLimitMonitor } from '../stats/RateLimitMonitor.js';
import { Router } from '../routing/Router.js';
import { STORAGE_KEYS } from '../config/STORAGE_KEYS.js';
import { SettingsTransfer } from '../settings/SettingsTransfer.js';
import { StatsIndex } from '../stats/StatsIndex.js';
import { StyleRegistry } from '../styles/StyleRegistry.js';
import { Theme } from '../settings/Theme.js';
import { Toolbar } from '../ui/Toolbar.js';
import { WidgetExtractor } from '../chat/widgets/WidgetExtractor.js';
import { conversationIdFromPath } from '../routing/conversationIdFromPath.js';
import { createElement } from '../dom/createElement.js';
import nativeAppHidingStylesheet from './nativeAppHiding.css';
import themeStylesheet from '../ui/theme.css';

/**
 * Composes every part of the UI and starts it, only once the launcher button is clicked.
 */
export class ClaudePlusApp {
  /**
   * Whether the one-time heavy boot (services, panels, data) has already run.
   * @type {boolean}
   */
  #isStarted = false;

  /**
   * The stylesheet hiding claude.ai's native app; toggled (not removed) so hiding ClaudePlus
   * again never loses any state.
   * @type {?HTMLStyleElement}
   */
  #nativeHidingStyle = null;

  /**
   * Shows the interface: runs the one-time heavy boot on the first call, or just reveals it
   * again with all state intact on a later one.
   * @returns {Promise<void>} Resolves once shown.
   */
  async launch() {
    if (this.#isStarted) {
      this.show();
      return;
    }
    await this.start();
    this.#isStarted = Boolean(this.#nativeHidingStyle);
  }

  /**
   * Reveals the interface and hides claude.ai's native app again.
   * @returns {void}
   */
  show() {
    if (this.#nativeHidingStyle) this.#nativeHidingStyle.disabled = false;
    ClaudePlusApp.#setInterfaceVisible(true);
  }

  /**
   * Hides the interface and reveals claude.ai's native app, without unmounting anything.
   * @returns {void}
   */
  hide() {
    if (this.#nativeHidingStyle) this.#nativeHidingStyle.disabled = true;
    ClaudePlusApp.#setInterfaceVisible(false);
  }

  /**
   * Shows or hides every element this script added, other than the launcher button, which stays
   * on top regardless.
   * @param {boolean} visible Whether to show them.
   * @returns {void}
   */
  static #setInterfaceVisible(visible) {
    document.querySelectorAll('body > [class*="claude-plus-"]:not(.claude-plus-launcher)').forEach((element) => {
      element.style.display = visible ? '' : 'none';
    });
  }

  /**
   * Creates the object stores that don't exist yet.
   * @param {IDBDatabase} database Database being upgraded.
   * @returns {void}
   */
  static #createMissingStores(database) {
    for (const [storeKey, storeName] of Object.entries(DATABASE.stores)) {
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: DATABASE.keyPaths[storeKey] });
    }
  }

  /**
   * The stylesheet of the whole UI: the theme variables, the toolbar height from the layout
   * configuration, then the stylesheets every component registered.
   * @returns {string} The stylesheet text.
   */
  static #interfaceStylesheet() {
    const layoutVariables = `:root { --claude-plus-toolbar-height: ${LAYOUT.toolbarHeight}px; }`;
    return [themeStylesheet, layoutVariables, StyleRegistry.combinedCss].join('\n');
  }

  /**
   * Mounts the UI, then hides claude.ai and loads the data. If mounting fails, everything this
   * script added is removed again, so claude.ai stays usable instead of turning into a blank page.
   * @returns {Promise<void>} Resolves once the first conversation is shown, or after a failed mount.
   */
  async start() {
    const mounted = this.#mountOrRestore();
    if (!mounted) return;
    this.#nativeHidingStyle = mounted.nativeHidingStyle;
    await ClaudePlusApp.#loadData(mounted.services);
  }

  /**
   * Mounts the UI and hides the native app, or undoes everything when mounting throws.
   * @returns {?{services: object, nativeHidingStyle: HTMLStyleElement}} The services needing data
   * (directory, router, paneManager, stats, activity, rateLimits) and the native-hiding
   * stylesheet, or null after a failure.
   */
  #mountOrRestore() {
    try {
      const services = this.#mountInterface();
      const nativeHidingStyle = createElement('style', { className: 'claude-plus-styles', textContent: nativeAppHidingStylesheet });
      document.head.append(nativeHidingStyle);
      return { services, nativeHidingStyle };
    } catch (error) {
      ClaudePlusApp.#removeInterface();
      console.error(LOG_PREFIX, 'failed to start; claude.ai was left unchanged', error);
      return null;
    }
  }

  /**
   * Injects the styles, builds every component and mounts the toolbar and the workspace.
   * @returns {object} The services needing data: directory, router, paneManager, stats, activity and rateLimits.
   * @throws {Error} When any part fails to build or mount.
   */
  #mountInterface() {
    document.head.append(createElement('style', { className: 'claude-plus-styles', textContent: ClaudePlusApp.#interfaceStylesheet() }));
    const preferences = new Preferences();
    const theme = new Theme(preferences);
    const api = new ClaudeApi();
    const database = new IndexedDbStore({ name: DATABASE.name, version: DATABASE.version, upgrade: ClaudePlusApp.#createMissingStores });
    const modelCatalog = new ModelCatalog(preferences);
    modelCatalog.refresh();
    const settings = new ComposerSettings(preferences, modelCatalog);
    const directory = new ConversationDirectory(api);
    const stats = new StatsIndex(api, database);
    const activity = new ActivityTracker(database);
    const rateLimits = new RateLimitMonitor(api);
    const widgetExtractor = new WidgetExtractor(database);
    const paneManager = new ChatPaneManager({ api, settings, directory, preferences, stats, widgetExtractor });
    const router = new Router(paneManager);
    ClaudePlusApp.#connectServices({ directory, paneManager, stats, rateLimits });
    paneManager.restorePanes(conversationIdFromPath(location.pathname));

    const panelFactory = new PanelFactory({ directory, router, paneManager, stats, activity, rateLimits, preferences });
    const composer = new ComposerPanel({ paneManager, settings, stats, exporter: new ConversationExporter(api, paneManager), modelCatalog });
    const workspace = ClaudePlusApp.#createWorkspace({ preferences, paneManager, panelFactory, composer });
    paneManager.attachWorkspace(workspace);
    panelFactory.attachWorkspace(workspace);
    const layoutLibrary = new LayoutLibrary({ preferences, workspace, paneManager, panelFactory });
    new Toolbar({ preferences, workspace, layoutLibrary, settingsTransfer: new SettingsTransfer(preferences), theme, onHide: () => this.hide() }).mount();
    workspace.mount();
    ClaudePlusApp.#refreshTabTitlesOnChange(workspace, directory, paneManager);
    new KeyboardShortcuts(workspace).install();
    return { directory, router, paneManager, stats, activity, rateLimits };
  }

  /**
   * Creates the workspace with the chat panes, the composer and the view panels of the stored
   * layout (or the default view panels when no layout is stored).
   * @param {object} parts Workspace parts.
   * @param {Preferences} parts.preferences Layout storage.
   * @param {ChatPaneManager} parts.paneManager Chat panes.
   * @param {PanelFactory} parts.panelFactory Creates view panels.
   * @param {ComposerPanel} parts.composer The composer.
   * @returns {DockWorkspace} The workspace, not yet mounted.
   */
  static #createWorkspace({ preferences, paneManager, panelFactory, composer }) {
    const storedPanelIds = DockTree.collectPanelIds(preferences.readJson(STORAGE_KEYS.dockLayout));
    const viewPanelIds = storedPanelIds.size ? [...storedPanelIds].filter(panelId => panelFactory.isViewPanelId(panelId)) : PanelFactory.defaultPanelIds;
    const panels = new Map([...paneManager.panelEntries(), ['composer', composer], ...viewPanelIds.map(panelId => [panelId, panelFactory.create(panelId)])]);
    const workspace = new DockWorkspace({
      panels,
      paneManager,
      preferences,
      createDefaultTree: () => DockTree.createDefault(paneManager.paneIds),
      requiredPanelIds: () => [...paneManager.paneIds, 'composer'],
      placeMissingPanel: ClaudePlusApp.#placeMissingPanel,
      addPanelMenu: {
        entries: () => panelFactory.addMenuEntries(),
        onSelect: (entryId, leafId) => ClaudePlusApp.#addFromMenu({ entryId, leafId, paneManager, panelFactory, workspace }),
      },
      onLayout: visiblePanelIds => paneManager.updateVisiblePanels(visiblePanelIds),
    });
    return workspace;
  }

  /**
   * Docks a required panel missing from the layout: the composer along the bottom edge, anything
   * else as a tab of the first zone.
   * @param {DockTree} tree The layout.
   * @param {string} panelId Panel id.
   * @returns {void}
   */
  static #placeMissingPanel(tree, panelId) {
    if (panelId === 'composer') tree.dockPanelAtEdge(panelId, 'bottom');
    else tree.dockPanel(panelId, tree.firstLeaf().id, 'center');
  }

  /**
   * Runs a "+" menu entry: a new empty chat, or a new instance of a view panel, as a tab of the zone.
   * @param {object} choice The chosen entry and context.
   * @param {string} choice.entryId "chat" or a view panel type.
   * @param {string} choice.leafId Zone whose "+" was clicked.
   * @param {ChatPaneManager} choice.paneManager Chat panes.
   * @param {PanelFactory} choice.panelFactory Creates view panels.
   * @param {DockWorkspace} choice.workspace The workspace.
   * @returns {void}
   */
  static #addFromMenu({ entryId, leafId, paneManager, panelFactory, workspace }) {
    if (entryId === 'chat') {
      paneManager.openPaneInZone(leafId);
      return;
    }
    const { panelId, panel } = panelFactory.createInstance(entryId);
    workspace.addPanelToZone(panelId, panel, leafId);
  }

  /**
   * Feeds loaded and deleted conversations to the stats and streamed usage windows to the monitor.
   * @param {object} services Services to connect.
   * @param {ConversationDirectory} services.directory Shared conversation list.
   * @param {ChatPaneManager} services.paneManager Chat panes.
   * @param {StatsIndex} services.stats Conversation statistics.
   * @param {RateLimitMonitor} services.rateLimits Usage windows.
   * @returns {void}
   */
  static #connectServices({ directory, paneManager, stats, rateLimits }) {
    paneManager.subscribe('conversationLoaded', conversation => stats.indexConversation(conversation));
    paneManager.subscribe('rateLimits', limits => rateLimits.setLimits(limits));
    directory.subscribe('conversationDeleted', conversationId => stats.removeConversation(conversationId));
  }

  /**
   * Redraws the tab strips when a chat pane's title can have changed.
   * @param {DockWorkspace} workspace The workspace.
   * @param {ConversationDirectory} directory Shared conversation list, whose titles the chat tabs show.
   * @param {ChatPaneManager} paneManager Chat panes.
   * @returns {void}
   */
  static #refreshTabTitlesOnChange(workspace, directory, paneManager) {
    directory.subscribe('conversations', () => workspace.layout());
    paneManager.subscribe('paneConversations', () => workspace.layout());
  }

  /**
   * Removes every element and stylesheet this script added, other than the launcher button, so a
   * failed mount can still be retried.
   * @returns {void}
   */
  static #removeInterface() {
    document.querySelectorAll('.claude-plus-styles, body > [class*="claude-plus-"]:not(.claude-plus-launcher)').forEach(element => element.remove());
  }

  /**
   * Starts polling, loads stats, activity and the conversation list, opens the URL's conversation
   * in the focused pane and reopens the other panes' conversations.
   * @param {object} services Services created by #mountInterface.
   * @param {ConversationDirectory} services.directory Shared conversation list.
   * @param {Router} services.router Navigation.
   * @param {ChatPaneManager} services.paneManager Chat panes.
   * @param {StatsIndex} services.stats Conversation statistics.
   * @param {ActivityTracker} services.activity Active-time tracking.
   * @param {RateLimitMonitor} services.rateLimits Usage windows.
   * @returns {Promise<void>} Resolves once the focused pane's conversation is shown.
   */
  static async #loadData({ directory, router, paneManager, stats, activity, rateLimits }) {
    rateLimits.start();
    await Promise.all([stats.refreshAggregate(), activity.start(), directory.refresh()]);
    paneManager.openRestoredConversations();
    await router.start();
  }
}
