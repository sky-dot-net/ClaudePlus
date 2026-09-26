import { LAYOUT } from '../config/LAYOUT.js';
import { StyleRegistry } from '../styles/StyleRegistry.js';
import { createElement } from '../dom/createElement.js';
import { placeElement } from '../dom/placeElement.js';
import stylesheet from './ZoneChromeRenderer.css';

StyleRegistry.register(stylesheet);

/**
 * Draws each zone's frame and tab strip on a layer below the panels. A tab shows its panel's
 * title and an optional close button; the strip ends with a "+" button. What pressing, clicking
 * and closing do is left to the callbacks.
 */
export class ZoneChromeRenderer {
  /**
   * Layer holding every frame and tab strip.
   * @type {HTMLElement}
   */
  #layer = createElement('div', { className: 'claude-plus-themed claude-plus-zone-chrome-layer' });

  /**
   * Callbacks answering questions about panels and handling tab interaction.
   * @type {ZoneChromeCallbacks}
   */
  #callbacks;

  /**
   * Creates the renderer.
   * @param {ZoneChromeCallbacks} callbacks Callbacks answering questions about panels and handling tab interaction.
   */
  constructor(callbacks) {
    this.#callbacks = callbacks;
  }

  /**
   * The layer element, to add to the page.
   * @returns {HTMLElement} The layer.
   */
  get layer() {
    return this.#layer;
  }

  /**
   * Removes every drawn zone.
   * @returns {void}
   */
  clear() {
    this.#layer.replaceChildren();
  }

  /**
   * Draws a zone's frame and tab strip.
   * @param {LeafPlacement} placement The zone and its area.
   * @returns {void}
   */
  render({ leaf, rect }) {
    const borderKind = this.#callbacks.chatBorderKindOf(leaf.activeTab);
    const frame = createElement('div', { className: 'claude-plus-zone-frame' });
    const tabStrip = createElement('div', { className: 'claude-plus-tab-strip' });
    placeElement(frame, rect);
    placeElement(tabStrip, { ...rect, height: LAYOUT.tabStripHeight });
    tabStrip.append(
      ...leaf.tabs.map(panelId => this.#createTab(leaf, panelId, borderKind)),
      this.#createAddPanelButton(leaf.id, borderKind),
      ZoneChromeRenderer.#createFiller(borderKind),
    );
    this.#layer.append(frame, tabStrip);
  }

  /**
   * The border-bottom modifier every element along the strip shares, so their lines - a plain
   * tab's, the "+" button's, the trailing filler's - stay one continuous, matching-colored border
   * except where the active tab of a bordered zone leaves a real gap in it (see the CSS: only
   * that one tab omits this class, replacing it with its own bordered-flap look instead).
   * @param {?('active'|'inactive')} borderKind The zone's chat border kind, or null for none.
   * @returns {string} The class name.
   */
  static #stripBorderClassName(borderKind) {
    return `claude-plus-tab-strip__border--${borderKind ?? 'neutral'}`;
  }

  /**
   * Creates a tab that reports presses and clicks.
   * @param {LeafNode} leaf Zone of the tab.
   * @param {string} panelId Panel id.
   * @param {?('active'|'inactive')} borderKind The zone's chat border kind, or null for none.
   * @returns {HTMLElement} The tab.
   */
  #createTab(leaf, panelId, borderKind) {
    const title = this.#callbacks.titleOf(panelId);
    const isActiveTab = panelId === leaf.activeTab;
    const className = this.#tabClassName(panelId, isActiveTab, borderKind);
    const tab = createElement('div', { className, title });
    tab.append(createElement('span', { className: 'claude-plus-tab__label', textContent: title }));
    tab.addEventListener('mousedown', event => this.#callbacks.onTabPress(event, panelId));
    tab.addEventListener('click', () => this.#callbacks.onTabActivate(leaf.id, panelId));
    if (this.#callbacks.canClose(panelId)) tab.append(this.#createCloseButton(panelId));
    return tab;
  }

  /**
   * A tab's class names: the base one, plus modifiers for being the strip's active tab, a chat
   * pane, its shared border-bottom color, and (only for a zone's active tab with a chat border)
   * its own bordered-flap look, which replaces that shared border with a real gap instead.
   * @param {string} panelId Panel id.
   * @param {boolean} isActiveTab Whether this is the strip's active tab.
   * @param {?('active'|'inactive')} borderKind The zone's chat border kind, or null for none.
   * @returns {string} The class names.
   */
  #tabClassName(panelId, isActiveTab, borderKind) {
    const classNames = ['claude-plus-tab', ZoneChromeRenderer.#stripBorderClassName(borderKind)];
    if (isActiveTab) classNames.push('claude-plus-tab--active');
    if (this.#callbacks.isChatPane(panelId)) classNames.push('claude-plus-tab--chat');
    if (isActiveTab && borderKind) classNames.push(`claude-plus-tab--border-${borderKind}`);
    return classNames.join(' ');
  }

  /**
   * Creates a tab's close button; pressing it neither activates nor drags the tab.
   * @param {string} panelId Panel id.
   * @returns {HTMLElement} The button.
   */
  #createCloseButton(panelId) {
    const button = createElement('span', { className: 'claude-plus-tab__close-button', textContent: '×', title: 'Close' });
    button.addEventListener('mousedown', event => event.stopPropagation());
    button.addEventListener('click', event => {
      event.stopPropagation();
      this.#callbacks.onTabClose(panelId);
    });
    return button;
  }

  /**
   * Creates the "+" button that offers panels to add to a zone.
   * @param {string} leafId Zone id.
   * @param {?('active'|'inactive')} borderKind The zone's chat border kind, or null for none.
   * @returns {HTMLElement} The button.
   */
  #createAddPanelButton(leafId, borderKind) {
    const className = `claude-plus-tab-strip__add-button ${ZoneChromeRenderer.#stripBorderClassName(borderKind)}`;
    const button = createElement('div', { className, textContent: '+', title: 'Add a chat or panel to this zone' });
    button.addEventListener('click', event => this.#callbacks.onAddClick(event, leafId));
    return button;
  }

  /**
   * Creates the strip's trailing filler, carrying the shared border-bottom onward across any
   * space left of the strip once its tabs and "+" button don't fill it.
   * @param {?('active'|'inactive')} borderKind The zone's chat border kind, or null for none.
   * @returns {HTMLElement} The filler.
   */
  static #createFiller(borderKind) {
    return createElement('div', { className: `claude-plus-tab-strip__filler ${ZoneChromeRenderer.#stripBorderClassName(borderKind)}` });
  }
}
