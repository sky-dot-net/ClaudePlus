import { DockTree } from './DockTree.js';
import { DragGesture } from '../dom/DragGesture.js';
import { FrameScheduler } from '../dom/FrameScheduler.js';
import { LAYOUT } from '../config/LAYOUT.js';
import { PopupMenu } from '../ui/PopupMenu.js';
import { STORAGE_KEYS } from '../config/STORAGE_KEYS.js';
import { createElement } from '../dom/createElement.js';
import { placeElement } from '../dom/placeElement.js';

/**
 * Renders the dock tree, positions the panels and handles tab dragging, divider resizing and the
 * add-panel menu.
 */
export class DockWorkspace {
  /**
   * Highlight area for each outer edge drop, given the workspace bounds and the capped width and height.
   * @type {Readonly<Record<string, function(Rect, number, number): Rect>>}
   */
  static #EDGE_HIGHLIGHTS = Object.freeze({
    left: (bounds, width) => ({ ...bounds, width }),
    right: (bounds, width) => ({ ...bounds, left: bounds.left + bounds.width - width, width }),
    top: (bounds, width, height) => ({ ...bounds, height }),
    bottom: (bounds, width, height) => ({ ...bounds, top: bounds.top + bounds.height - height, height }),
  });

  /**
   * Highlight area for each zone drop region, given the zone's area.
   * @type {Readonly<Record<string, function(Rect): Rect>>}
   */
  static #REGION_HIGHLIGHTS = Object.freeze({
    center: rect => rect,
    top: rect => ({ ...rect, height: rect.height / 2 }),
    bottom: rect => ({ ...rect, top: rect.top + rect.height / 2, height: rect.height / 2 }),
    left: rect => ({ ...rect, width: rect.width / 2 }),
    right: rect => ({ ...rect, left: rect.left + rect.width / 2, width: rect.width / 2 }),
  });

  /**
   * Panels by id.
   * @type {Map<string, Panel>}
   */
  #panels;

  /**
   * Layout storage.
   * @type {Preferences}
   */
  #preferences;

  /**
   * Current layout.
   * @type {DockTree}
   */
  #tree;

  /**
   * Zone frames and tab strips, below the panels.
   * @type {HTMLElement}
   */
  #zoneChromeLayer;

  /**
   * Dividers, above the panels so they can be grabbed along their full length.
   * @type {HTMLElement}
   */
  #dividerLayer;

  /**
   * Zone areas from the last layout, used to find drop targets.
   * @type {LeafPlacement[]}
   */
  #leafPlacements = [];

  /**
   * Batches layouts per frame during resizing.
   * @type {FrameScheduler}
   */
  #layoutScheduler = new FrameScheduler(() => this.layout());

  /**
   * The add-panel menu.
   * @type {PopupMenu}
   */
  #addPanelMenu = new PopupMenu();

  /**
   * Creates the default layout.
   * @type {function(): DockTree}
   */
  #createDefaultTree;

  /**
   * Ids of the panels that must always be docked.
   * @type {function(): string[]}
   */
  #requiredPanelIds;

  /**
   * Docks a required panel the layout lacks.
   * @type {function(DockTree, string): void}
   */
  #placeMissingPanel;

  /**
   * Entries of the zones' "+" menu and what choosing one does.
   * @type {{entries: function(): ChoiceOption[], onSelect: function(string, string): void}}
   */
  #addPanelMenuOptions;

  /**
   * Called after every layout with the ids of the visible panels.
   * @type {function(Set<string>): void}
   */
  #onLayout;

  /**
   * Creates the workspace from the stored layout, or the default one, and docks any required
   * panel the layout lacks.
   * @param {object} options Workspace options.
   * @param {Map<string, Panel>} options.panels Panels by id; panels can be added and removed later.
   * @param {Preferences} options.preferences Layout storage.
   * @param {function(): DockTree} options.createDefaultTree Creates the default layout.
   * @param {function(): string[]} options.requiredPanelIds Ids of the panels that must always be docked.
   * @param {function(DockTree, string): void} options.placeMissingPanel Docks a required panel the layout lacks.
   * @param {{entries: function(): ChoiceOption[], onSelect: function(string, string): void}} options.addPanelMenu Entries of the zones' "+" menu, and a callback receiving the chosen entry id and the zone id.
   * @param {function(Set<string>): void} options.onLayout Called after every layout with the ids of the visible panels.
   */
  constructor({ panels, preferences, createDefaultTree, requiredPanelIds, placeMissingPanel, addPanelMenu, onLayout }) {
    this.#panels = panels;
    this.#preferences = preferences;
    this.#createDefaultTree = createDefaultTree;
    this.#requiredPanelIds = requiredPanelIds;
    this.#placeMissingPanel = placeMissingPanel;
    this.#addPanelMenuOptions = addPanelMenu;
    this.#onLayout = onLayout;
    this.#tree = DockTree.fromStored(preferences.readJson(STORAGE_KEYS.dockLayout), panels.keys()) ?? createDefaultTree();
    this.#dockMissingRequiredPanels();
  }

  /**
   * Adds the layers to the page, lays out and follows window resizes.
   * @returns {void}
   */
  mount() {
    this.#zoneChromeLayer = createElement('div', { className: 'claude-plus-themed claude-plus-zone-chrome-layer' });
    this.#dividerLayer = createElement('div', { className: 'claude-plus-divider-layer' });
    document.body.append(this.#zoneChromeLayer, this.#dividerLayer);
    window.addEventListener('resize', () => this.#layoutScheduler.schedule());
    this.layout();
  }

  /**
   * Restores the default layout and forgets the stored one.
   * @returns {void}
   */
  resetLayout() {
    this.#preferences.remove(STORAGE_KEYS.dockLayout);
    this.#tree = this.#createDefaultTree();
    this.layout();
  }

  /**
   * Adds a panel and docks it to the right of another one, or into the first zone.
   * @param {string} panelId Id of the new panel.
   * @param {Panel} panel The panel.
   * @param {string} besidePanelId Panel to dock it next to.
   * @returns {void}
   */
  addPanel(panelId, panel, besidePanelId) {
    this.#panels.set(panelId, panel);
    const besideLeaf = this.#tree.findLeafContaining(besidePanelId) || this.#tree.firstLeaf();
    this.#tree.dockPanel(panelId, besideLeaf.id, 'right');
    this.#layoutAndSave();
  }

  /**
   * Adds a panel and docks it at a specific drop target, as chosen during a drag started with
   * beginExternalDrag.
   * @param {string} panelId Id of the new panel.
   * @param {Panel} panel The panel.
   * @param {DropTarget} dropTarget Where to dock it: an outer edge, or a region of a zone.
   * @returns {void}
   */
  addPanelAt(panelId, panel, dropTarget) {
    this.#panels.set(panelId, panel);
    if (dropTarget.edge) this.#tree.dockPanelAtEdge(panelId, dropTarget.edge);
    else this.#tree.dockPanel(panelId, dropTarget.leafId, dropTarget.region);
    this.#layoutAndSave();
  }

  /**
   * Drags a floating label for something that doesn't exist as a panel yet, highlighting the same
   * drop targets a tab drag would, and invokes a callback with the chosen target on release. Lets
   * other panels (e.g. the conversation list) offer "drag this to open it as a new pane docked
   * here" without this class needing to know anything about what's being dragged.
   * @param {MouseEvent} startEvent The mousedown that starts the drag.
   * @param {string} label Text shown in the floating drag label.
   * @param {function(DropTarget): void} onDrop Called with the chosen drop target when dropped on one.
   * @returns {void}
   */
  beginExternalDrag(startEvent, label, onDrop) {
    startEvent.preventDefault();
    const dragLabel = createElement('div', { className: 'claude-plus-themed claude-plus-drag-label', textContent: label, hidden: true });
    const dropHighlight = createElement('div', { className: 'claude-plus-drop-highlight', hidden: true });
    document.body.append(dragLabel, dropHighlight);
    let dropTarget = null;
    new DragGesture(startEvent, {
      threshold: LAYOUT.dragThreshold,
      onMove: (event) => {
        dropTarget = this.#dropTargetAt(event.clientX, event.clientY);
        DockWorkspace.#showDragFeedback(dragLabel, dropHighlight, event, dropTarget);
      },
      onEnd: (event, wasDragged) => {
        dragLabel.remove();
        dropHighlight.remove();
        if (wasDragged && dropTarget) onDrop(dropTarget);
      },
    });
  }

  /**
   * Undocks a panel, disposes it and forgets it.
   * @param {string} panelId Panel id.
   * @returns {void}
   */
  removePanel(panelId) {
    const panel = this.#panels.get(panelId);
    if (!panel) return;
    this.#tree.removePanel(panelId);
    this.#panels.delete(panelId);
    panel.dispose();
    this.#layoutAndSave();
  }

  /**
   * Docks every required panel missing from the layout.
   * @returns {void}
   */
  #dockMissingRequiredPanels() {
    const missing = this.#requiredPanelIds().filter(panelId => !this.#tree.findLeafContaining(panelId));
    missing.forEach(panelId => this.#placeMissingPanel(this.#tree, panelId));
  }

  /**
   * Adds a panel as the active tab of a zone and saves the layout.
   * @param {string} panelId Id of the new panel.
   * @param {Panel} panel The panel.
   * @param {string} leafId Zone id.
   * @returns {void}
   */
  addPanelToZone(panelId, panel, leafId) {
    this.#panels.set(panelId, panel);
    this.#tree.dockPanel(panelId, leafId, 'center');
    this.#layoutAndSave();
  }

  /**
   * Makes a panel known without docking it; used before applying a layout that contains it.
   * @param {string} panelId Panel id.
   * @param {Panel} panel The panel.
   * @returns {void}
   */
  registerPanel(panelId, panel) {
    this.#panels.set(panelId, panel);
  }

  /**
   * Whether a panel is known.
   * @param {string} panelId Panel id.
   * @returns {boolean} True when it exists, docked or not.
   */
  hasPanel(panelId) {
    return this.#panels.has(panelId);
  }

  /**
   * A copy of the current arrangement.
   * @returns {DockNode} The layout tree, detached from the live one.
   */
  layoutSnapshot() {
    return JSON.parse(JSON.stringify(this.#tree));
  }

  /**
   * Applies a stored arrangement: panels it doesn't mention are closed, required panels it lacks
   * are docked, and the result is laid out and saved. Unusable arrangements fall back to the default.
   * @param {*} storedTree Stored layout tree.
   * @returns {void}
   */
  replaceLayout(storedTree) {
    this.#tree = DockTree.fromStored(storedTree, this.#panels.keys()) ?? this.#createDefaultTree();
    this.#dockMissingRequiredPanels();
    [...this.#panels].filter(([panelId, panel]) => !this.#tree.findLeafContaining(panelId) && panel.canClose()).forEach(([, panel]) => panel.close());
    this.#layoutAndSave();
  }

  /**
   * The first docked panel satisfying a predicate.
   * @param {function(Panel): boolean} predicate Test for each panel.
   * @returns {?{panelId: string, panel: Panel}} The panel and its id, or null.
   */
  findDockedPanel(predicate) {
    const entry = [...this.#panels].find(([panelId, panel]) => this.#tree.findLeafContaining(panelId) && predicate(panel));
    return entry ? { panelId: entry[0], panel: entry[1] } : null;
  }

  /**
   * Makes a docked panel the visible tab of its zone.
   * @param {string} panelId Panel id.
   * @returns {boolean} True if the panel is docked and now visible; false if it isn't docked.
   */
  revealPanel(panelId) {
    const leaf = this.#tree.findLeafContaining(panelId);
    if (leaf) this.#activateTab(leaf.id, panelId);
    return Boolean(leaf);
  }

  /**
   * Redraws zone frames, tab strips and dividers and positions the visible panels; other panels
   * are hidden. Reports the visible panels through the onLayout callback.
   * @returns {void}
   */
  layout() {
    const { leaves, dividers } = this.#tree.computeLayout(this.#workspaceBounds());
    this.#leafPlacements = leaves;
    this.#zoneChromeLayer.replaceChildren();
    this.#dividerLayer.replaceChildren();
    leaves.forEach(placement => this.#renderZone(placement));
    const visiblePanelIds = new Set(leaves.map(placement => placement.leaf.activeTab));
    this.#hidePanelsExcept(visiblePanelIds);
    dividers.forEach(placement => this.#renderDivider(placement));
    this.#onLayout(visiblePanelIds);
  }

  /**
   * Lays out and saves the layout.
   * @returns {void}
   */
  #layoutAndSave() {
    this.layout();
    this.#preferences.writeJson(STORAGE_KEYS.dockLayout, this.#tree);
  }

  /**
   * Area available to the dock, below the toolbar.
   * @returns {Rect} The area.
   */
  #workspaceBounds() {
    return { left: 0, top: LAYOUT.toolbarHeight, width: window.innerWidth, height: window.innerHeight - LAYOUT.toolbarHeight };
  }

  /**
   * Draws a zone and shows its active panel below the tab strip.
   * @param {LeafPlacement} placement The zone and its area.
   * @returns {void}
   */
  #renderZone({ leaf, rect }) {
    this.#renderZoneChrome(leaf, rect);
    if (leaf.activeTab) this.#showPanel(leaf.activeTab, { ...rect, top: rect.top + LAYOUT.tabStripHeight, height: rect.height - LAYOUT.tabStripHeight });
  }

  /**
   * Hides every built panel that isn't visible.
   * @param {Set<string>} visiblePanelIds Ids of the visible panels.
   * @returns {void}
   */
  #hidePanelsExcept(visiblePanelIds) {
    for (const [panelId, panel] of this.#panels) {
      if (!visiblePanelIds.has(panelId) && panel.isBuilt) panel.element.style.visibility = 'hidden';
    }
  }

  /**
   * Positions and shows a panel, adding it to the page on first use.
   * @param {string} panelId Panel id.
   * @param {Rect} contentRect Area below the tab strip.
   * @returns {void}
   */
  #showPanel(panelId, contentRect) {
    const panel = this.#panels.get(panelId);
    if (!panel) return;
    const { element } = panel;
    if (!element.isConnected) document.body.append(element);
    placeElement(element, contentRect);
    element.style.visibility = 'visible';
  }

  /**
   * Title of a panel.
   * @param {string} panelId Panel id.
   * @returns {string} Its title, or the id for an unknown panel.
   */
  #panelTitle(panelId) {
    const panel = this.#panels.get(panelId);
    return panel ? panel.title : panelId;
  }

  /**
   * Draws a zone's frame and tab strip.
   * @param {LeafNode} leaf The zone.
   * @param {Rect} rect Its area.
   * @returns {void}
   */
  #renderZoneChrome(leaf, rect) {
    const frame = createElement('div', { className: 'claude-plus-zone-frame' });
    const tabStrip = createElement('div', { className: 'claude-plus-tab-strip' });
    placeElement(frame, rect);
    placeElement(tabStrip, { ...rect, height: LAYOUT.tabStripHeight });
    tabStrip.append(...leaf.tabs.map(panelId => this.#createTab(leaf, panelId)), this.#createAddPanelButton(leaf.id));
    this.#zoneChromeLayer.append(frame, tabStrip);
  }

  /**
   * Creates a tab that activates its panel on click and starts a drag on press.
   * @param {LeafNode} leaf Zone of the tab.
   * @param {string} panelId Panel id.
   * @returns {HTMLElement} The tab.
   */
  #createTab(leaf, panelId) {
    const className = panelId === leaf.activeTab ? 'claude-plus-tab claude-plus-tab--active' : 'claude-plus-tab';
    const tab = createElement('div', { className, title: this.#panelTitle(panelId) });
    tab.append(createElement('span', { className: 'claude-plus-tab__label', textContent: this.#panelTitle(panelId) }));
    tab.addEventListener('mousedown', event => this.#onTabPress(event, panelId));
    tab.addEventListener('click', () => this.#activateTab(leaf.id, panelId));
    if (this.#canClosePanel(panelId)) tab.append(this.#createCloseButton(panelId));
    return tab;
  }

  /**
   * Whether a panel's tab offers a close button.
   * @param {string} panelId Panel id.
   * @returns {boolean} True when the panel exists and allows closing.
   */
  #canClosePanel(panelId) {
    const panel = this.#panels.get(panelId);
    return Boolean(panel) && panel.canClose();
  }

  /**
   * Creates a tab's close button; pressing it neither activates nor drags the tab.
   * @param {string} panelId Panel id.
   * @returns {HTMLElement} The button.
   */
  #createCloseButton(panelId) {
    const button = createElement('span', { className: 'claude-plus-tab__close-button', textContent: '×', title: 'Close' });
    button.addEventListener('mousedown', event => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#panels.get(panelId).close();
    });
    return button;
  }

  /**
   * Shows a tab's panel and saves the layout.
   * @param {string} leafId Zone id.
   * @param {string} panelId Panel id.
   * @returns {void}
   */
  #activateTab(leafId, panelId) {
    this.#tree.activateTab(leafId, panelId);
    this.#layoutAndSave();
  }

  /**
   * Creates the "+" button that offers undocked panels for a zone.
   * @param {string} leafId Zone id.
   * @returns {HTMLElement} The button.
   */
  #createAddPanelButton(leafId) {
    const button = createElement('div', { className: 'claude-plus-tab-strip__add-button', textContent: '+', title: 'Add a chat or panel to this zone' });
    button.addEventListener('click', event => this.#showAddPanelMenu(event, leafId));
    return button;
  }

  /**
   * Starts a tab drag on a primary-button press.
   * @param {MouseEvent} event The mousedown on a tab.
   * @param {string} panelId Panel of the tab.
   * @returns {void}
   */
  #onTabPress(event, panelId) {
    if (event.button === 0) this.#startTabDrag(event, panelId);
  }

  /**
   * Draws a divider that resizes its split when dragged.
   * @param {DividerPlacement} placement The divider.
   * @returns {void}
   */
  #renderDivider(placement) {
    const isSideBySide = placement.split.direction === 'row';
    const className = isSideBySide ? 'claude-plus-divider claude-plus-divider--vertical' : 'claude-plus-divider claude-plus-divider--horizontal';
    const divider = createElement('div', { className });
    placeElement(divider, DockWorkspace.#dividerGrabArea(placement, isSideBySide));
    divider.addEventListener('mousedown', event => this.#startDividerDrag(event, placement, isSideBySide));
    this.#dividerLayer.append(divider);
  }

  /**
   * Grab area of a divider, centred on the boundary.
   * @param {DividerPlacement} placement The divider.
   * @param {boolean} isSideBySide Whether the split places children side by side.
   * @returns {Rect} The area.
   */
  static #dividerGrabArea({ rect, position }, isSideBySide) {
    const start = position - LAYOUT.dividerThickness / 2;
    return isSideBySide
      ? { left: start, top: rect.top, width: LAYOUT.dividerThickness, height: rect.height }
      : { left: rect.left, top: start, width: rect.width, height: LAYOUT.dividerThickness };
  }

  /**
   * Pointer coordinate along a split axis.
   * @param {MouseEvent} event Pointer event.
   * @param {boolean} isSideBySide True for the x coordinate, false for y.
   * @returns {number} The coordinate.
   */
  static #pointerPositionAlongAxis(event, isSideBySide) {
    return isSideBySide ? event.clientX : event.clientY;
  }

  /**
   * Resizes a split while its divider is dragged, laying out once per frame and saving on release.
   * @param {MouseEvent} startEvent The mousedown on the divider.
   * @param {DividerPlacement} placement The divider.
   * @param {boolean} isSideBySide Whether the split places children side by side.
   * @returns {void}
   */
  #startDividerDrag(startEvent, { split, index, rect }, isSideBySide) {
    startEvent.preventDefault();
    const startSizes = [...split.sizes];
    const startPosition = DockWorkspace.#pointerPositionAlongAxis(startEvent, isSideBySide);
    const extent = isSideBySide ? rect.width : rect.height;
    const resizingClass = isSideBySide ? 'claude-plus-resizing-horizontally' : 'claude-plus-resizing-vertically';
    document.documentElement.classList.add(resizingClass);
    new DragGesture(startEvent, {
      threshold: 0,
      onMove: (event) => {
        this.#tree.resizeSplit(split, index, startSizes, (DockWorkspace.#pointerPositionAlongAxis(event, isSideBySide) - startPosition) / extent);
        this.#layoutScheduler.schedule();
      },
      onEnd: () => {
        document.documentElement.classList.remove(resizingClass);
        this.#layoutScheduler.cancel();
        this.#layoutAndSave();
      },
    });
  }

  /**
   * Drags a tab with a floating label, highlights the drop target and docks the panel on release.
   * @param {MouseEvent} startEvent The mousedown on the tab.
   * @param {string} panelId Panel of the tab.
   * @returns {void}
   */
  #startTabDrag(startEvent, panelId) {
    startEvent.preventDefault();
    const dragLabel = createElement('div', { className: 'claude-plus-themed claude-plus-drag-label', textContent: this.#panelTitle(panelId), hidden: true });
    const dropHighlight = createElement('div', { className: 'claude-plus-drop-highlight', hidden: true });
    document.body.append(dragLabel, dropHighlight);
    let dropTarget = null;
    new DragGesture(startEvent, {
      threshold: LAYOUT.dragThreshold,
      onMove: (event) => {
        dropTarget = this.#dropTargetAt(event.clientX, event.clientY);
        DockWorkspace.#showDragFeedback(dragLabel, dropHighlight, event, dropTarget);
      },
      onEnd: (event, wasDragged) => {
        dragLabel.remove();
        dropHighlight.remove();
        if (wasDragged && dropTarget) this.#dropPanel(panelId, dropTarget);
      },
    });
  }

  /**
   * Moves the drag label to the pointer and highlights the drop target.
   * @param {HTMLElement} dragLabel The floating label.
   * @param {HTMLElement} dropHighlight The drop highlight.
   * @param {MouseEvent} event Current pointer event.
   * @param {?DropTarget} dropTarget Target under the pointer, or null.
   * @returns {void}
   */
  static #showDragFeedback(dragLabel, dropHighlight, event, dropTarget) {
    dragLabel.hidden = false;
    Object.assign(dragLabel.style, { left: `${event.clientX + LAYOUT.dragLabelOffset}px`, top: `${event.clientY + LAYOUT.dragLabelOffset}px` });
    dropHighlight.hidden = !dropTarget;
    if (dropTarget) placeElement(dropHighlight, dropTarget.rect);
  }

  /**
   * Docks a panel at a drop target and saves the layout.
   * @param {string} panelId Panel id.
   * @param {DropTarget} dropTarget Where it was dropped.
   * @returns {void}
   */
  #dropPanel(panelId, dropTarget) {
    if (dropTarget.edge) this.#tree.dockPanelAtEdge(panelId, dropTarget.edge);
    else this.#tree.dockPanel(panelId, dropTarget.leafId, dropTarget.region);
    this.#layoutAndSave();
  }

  /**
   * The drop target under the pointer: an outer workspace edge when near one, otherwise the centre
   * or a side of the zone under the pointer.
   * @param {number} pointerX Pointer x.
   * @param {number} pointerY Pointer y.
   * @returns {?DropTarget} The target, or null outside every zone.
   */
  #dropTargetAt(pointerX, pointerY) {
    const bounds = this.#workspaceBounds();
    const edge = DockWorkspace.#outerEdgeNear(pointerX, pointerY, bounds);
    if (edge) return { edge, leafId: null, region: null, rect: DockWorkspace.#edgeHighlight(edge, bounds) };
    const hoveredZone = this.#leafPlacements.find(({ rect }) => DockWorkspace.#containsPoint(rect, pointerX, pointerY));
    return hoveredZone ? DockWorkspace.#zoneDropTarget(hoveredZone, pointerX, pointerY) : null;
  }

  /**
   * Drop target within a zone.
   * @param {LeafPlacement} placement The zone under the pointer.
   * @param {number} pointerX Pointer x.
   * @param {number} pointerY Pointer y.
   * @returns {DropTarget} The target.
   */
  static #zoneDropTarget({ leaf, rect }, pointerX, pointerY) {
    const region = DockWorkspace.#regionAt((pointerX - rect.left) / rect.width, (pointerY - rect.top) / rect.height);
    return { edge: null, leafId: leaf.id, region, rect: DockWorkspace.#REGION_HIGHLIGHTS[region](rect) };
  }

  /**
   * Whether a point lies inside a rectangle, edges included.
   * @param {Rect} rect The rectangle.
   * @param {number} pointX Point x.
   * @param {number} pointY Point y.
   * @returns {boolean} True when inside.
   */
  static #containsPoint(rect, pointX, pointY) {
    return pointX >= rect.left && pointX <= rect.left + rect.width && pointY >= rect.top && pointY <= rect.top + rect.height;
  }

  /**
   * The outer workspace edge within LAYOUT.edgeDropMargin of a point, checked left, right, top, bottom.
   * @param {number} pointX Point x.
   * @param {number} pointY Point y.
   * @param {Rect} bounds Workspace area.
   * @returns {?string} 'left', 'right', 'top' or 'bottom', or null when no edge is near.
   */
  static #outerEdgeNear(pointX, pointY, bounds) {
    const distanceByEdge = {
      left: pointX - bounds.left,
      right: bounds.left + bounds.width - pointX,
      top: pointY - bounds.top,
      bottom: bounds.top + bounds.height - pointY,
    };
    return Object.keys(distanceByEdge).find(edge => distanceByEdge[edge] < LAYOUT.edgeDropMargin) ?? null;
  }

  /**
   * Highlight area for an outer edge drop, capped in size.
   * @param {string} edge 'left', 'right', 'top' or 'bottom'.
   * @param {Rect} bounds Workspace area.
   * @returns {Rect} The area.
   */
  static #edgeHighlight(edge, bounds) {
    const width = Math.min(bounds.width * LAYOUT.edgeDockFraction, LAYOUT.edgeHighlightMaxWidth);
    const height = Math.min(bounds.height * LAYOUT.edgeDockFraction, LAYOUT.edgeHighlightMaxHeight);
    return DockWorkspace.#EDGE_HIGHLIGHTS[edge](bounds, width, height);
  }

  /**
   * Drop region for a position within a zone: a side when within LAYOUT.sideDropFraction of it
   * (top and bottom first), otherwise the centre.
   * @param {number} fractionAcross Position across the zone, 0 to 1.
   * @param {number} fractionDown Position down the zone, 0 to 1.
   * @returns {string} 'top', 'bottom', 'left', 'right' or 'center'.
   */
  static #regionAt(fractionAcross, fractionDown) {
    const sideShare = LAYOUT.sideDropFraction;
    const candidates = [
      ['top', fractionDown < sideShare],
      ['bottom', fractionDown > 1 - sideShare],
      ['left', fractionAcross < sideShare],
      ['right', fractionAcross > 1 - sideShare],
    ];
    const match = candidates.find(([, isHit]) => isHit);
    return match ? match[0] : 'center';
  }

  /**
   * Opens a zone's "+" menu: adding a chat or a new instance of a view panel as a tab of the zone.
   * @param {MouseEvent} event Click on the zone's "+" button.
   * @param {string} leafId Zone id.
   * @returns {void}
   */
  #showAddPanelMenu(event, leafId) {
    this.#addPanelMenu.open({
      left: event.clientX,
      top: event.clientY,
      entries: this.#addPanelMenuOptions.entries(),
      onSelect: entryId => this.#addPanelMenuOptions.onSelect(entryId, leafId),
    });
  }
}
