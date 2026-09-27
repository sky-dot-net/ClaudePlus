import { ChatPanel } from '../../ui/panels/ChatPanel.js';
import { ChatSession } from '../ChatSession.js';

/**
 * Builds a chat pane: its session, its panel, and the forwarding of the session's events.
 */
export class ChatPaneFactory {
  /**
   * Shared services the sessions and panels need.
   * @type {{api: ClaudeApi, settings: ComposerSettings, directory: CombinedConversationDirectory, preferences: Preferences, stats: StatsIndex, widgetExtractor: WidgetExtractor, importedConversations: ImportedConversationStore}}
   */
  #services;

  /**
   * The pane manager, handed to every panel.
   * @type {ChatPaneManager}
   */
  #paneManager;

  /**
   * Called with a pane id when that pane opens another conversation.
   * @type {function(string): void}
   */
  #onPaneConversationChanged;

  /**
   * Creates the factory.
   * @param {object} services Shared services the sessions and panels need.
   * @param {ChatPaneManager} paneManager The pane manager, handed to every panel.
   * @param {function(string): void} onPaneConversationChanged Called with a pane id when that pane opens another conversation.
   */
  constructor(services, paneManager, onPaneConversationChanged) {
    this.#services = services;
    this.#paneManager = paneManager;
    this.#onPaneConversationChanged = onPaneConversationChanged;
  }

  /**
   * Creates a pane's session and panel and forwards the session's fetched conversations and usage
   * windows through the pane manager.
   * @param {string} paneId Pane id.
   * @returns {{session: ChatSession, panel: ChatPanel}} The pane.
   */
  create(paneId) {
    const { api, settings, directory, preferences, stats, widgetExtractor, importedConversations } = this.#services;
    const session = new ChatSession(api, settings, directory, importedConversations);
    const panel = new ChatPanel({ paneId, session, directory, paneManager: this.#paneManager, stats, preferences, widgetExtractor });
    session.subscribe('openConversation', () => this.#onPaneConversationChanged(paneId));
    session.subscribe('conversationLoaded', payload => this.#paneManager.publish('conversationLoaded', payload));
    session.subscribe('rateLimits', limits => this.#paneManager.publish('rateLimits', limits));
    return { session, panel };
  }
}
