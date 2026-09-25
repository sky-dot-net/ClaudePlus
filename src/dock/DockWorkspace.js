import { AddPanelMenu } from './AddPanelMenu.js';
import { DividerRenderer } from './DividerRenderer.js';
import { DockTree } from './DockTree.js';
import { DropTargetResolver } from './DropTargetResolver.js';
import { FrameScheduler } from '../dom/FrameScheduler.js';
import { LAYOUT } from '../config/LAYOUT.js';
import { PanelDropDrag } from './PanelDropDrag.js';
import { PanelHost } from './PanelHost.js';
import { STORAGE_KEYS } from '../config/STORAGE_KEYS.js';
import { ZoneChromeRenderer } from './ZoneChromeRenderer.js';

/**
 * The docking workspace below the toolbar: keeps the layout tree, lays out zones, tabs, dividers
 * and panels, saves the layout on every change, and docks panels dropped by tab drags.
 */
export class DockWorkspace {
  /**
   * The known panels.
   * @type {PanelHost}
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
   * Draws zone frames and tab strips.
   * @type {ZoneChromeRenderer}
   */
  #zoneChrome;

  /**
   * Draws the dividers.
   * @type {DividerRenderer}
   */
  #dividers;

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
   * The zones' "+" menu.
   * @type {AddPanelMenu}
   */
  #addPanelMenu;

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
    this.#panels = new PanelHost(panels);
    this.#preferences = preferences;
    this.#createDefaultTree = createDefaultTree;
    this.#requiredPanelIds = requiredPanelIds;
    this.#placeMissingPanel = placeMissingPanel;
    this.#addPanelMenu = new AddPanelMenu(addPanelMenu);
    this.#onLayout = onLayout;
    this.#zoneChrome = this.#createZoneChromeRenderer();
    this.#dividers = this.#createDividerRenderer();
    this.#tree = DockTree.fromStored(preferences.readJson(STORAGE_KEYS.dockLayout), this.#panels.panelIds) ?? createDefaultTree();
    this.#dockMissingRequiredPanels();
  }

  /**
   * Adds the layers to the page, lays out and follows window resizes.
   * @returns {void}
   */
  mount() {
    document.body.append(this.#zoneChrome.layer, this.#dividers.layer);
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
    this.#panels.add(panelId, panel);
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
    this.#panels.add(panelId, panel);
    this.#dockAt(panelId, dropTarget);
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
    new PanelDropDrag(startEvent, { label, findDropTarget: this.#dropTargetAt, onDrop });
  }

  /**
   * Undocks a panel, disposes it and forgets it.
   * @param {string} panelId Panel id.
   * @returns {void}
   */
  removePanel(panelId) {
    if (!this.#panels.has(panelId)) return;
    this.#tree.removePanel(panelId);
    this.#panels.remove(panelId);
    this.#layoutAndSave();
  }

  /**
   * Adds a panel as the active tab of a zone and saves the layout.
   * @param {string} panelId Id of the new panel.
   * @param {Panel} panel The panel.
   * @param {string} leafId Zone id.
   * @returns {void}
   */
  addPanelToZone(panelId, panel, leafId) {
    this.#panels.add(panelId, panel);
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
    this.#panels.add(panelId, panel);
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
    this.#tree = DockTree.fromStored(storedTree, this.#panels.panelIds) ?? this.#createDefaultTree();
    this.#dockMissingRequiredPanels();
    this.#panels.panelIds.filter(panelId => !this.#tree.findLeafContaining(panelId) && this.#panels.canClose(panelId)).forEach(panelId => this.#panels.close(panelId));
    this.#layoutAndSave();
  }

  /**
   * The first docked panel satisfying a predicate.
   * @param {function(Panel): boolean} predicate Test for each panel.
   * @returns {?{panelId: string, panel: Panel}} The panel and its id, or null.
   */
  findDockedPanel(predicate) {
    const entry = this.#panels.entries.find(([panelId, panel]) => this.#tree.findLeafContaining(panelId) && predicate(panel));
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
    const { leaves, dividers } = this.#tree.computeLayout(DockWorkspace.#workspaceBounds());
    this.#leafPlacements = leaves;
    this.#zoneChrome.clear();
    this.#dividers.clear();
    leaves.forEach(placement => this.#renderZone(placement));
    const visiblePanelIds = new Set(leaves.map(placement => placement.leaf.activeTab));
    this.#panels.hideAllExcept(visiblePanelIds);
    dividers.forEach(placement => this.#dividers.render(placement));
    this.#onLayout(visiblePanelIds);
  }

  /**
   * Area available to the dock, below the toolbar.
   * @returns {Rect} The area.
   */
  static #workspaceBounds() {
    return { left: 0, top: LAYOUT.toolbarHeight, width: window.innerWidth, height: window.innerHeight - LAYOUT.toolbarHeight };
  }

  /**
   * Creates the zone chrome renderer, wired to the panels and the tab actions.
   * @returns {ZoneChromeRenderer} The renderer.
   */
  #createZoneChromeRenderer() {
    return new ZoneChromeRenderer({
      titleOf: panelId => this.#panels.titleOf(panelId),
      canClose: panelId => this.#panels.canClose(panelId),
      onTabPress: (event, panelId) => this.#onTabPress(event, panelId),
      onTabActivate: (leafId, panelId) => this.#activateTab(leafId, panelId),
      onTabClose: panelId => this.#panels.close(panelId),
      onAddClick: (event, leafId) => this.#addPanelMenu.open(event, leafId),
    });
  }

  /**
   * Creates the divider renderer, resizing splits once per frame while dragging and saving on release.
   * @returns {DividerRenderer} The renderer.
   */
  #createDividerRenderer() {
    return new DividerRenderer({
      onResize: (split, index, startSizes, movedFraction) => {
        this.#tree.resizeSplit(split, index, startSizes, movedFraction);
        this.#layoutScheduler.schedule();
      },
      onResizeEnd: () => {
        this.#layoutScheduler.cancel();
        this.#layoutAndSave();
      },
    });
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
   * Lays out and saves the layout.
   * @returns {void}
   */
  #layoutAndSave() {
    this.layout();
    this.#preferences.writeJson(STORAGE_KEYS.dockLayout, this.#tree);
  }

  /**
   * Draws a zone and shows its active panel below the tab strip.
   * @param {LeafPlacement} placement The zone and its area.
   * @returns {void}
   */
  #renderZone(placement) {
    const { leaf, rect } = placement;
    this.#zoneChrome.render(placement);
    if (leaf.activeTab) this.#panels.show(leaf.activeTab, { ...rect, top: rect.top + LAYOUT.tabStripHeight, height: rect.height - LAYOUT.tabStripHeight });
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
   * Starts dragging a tab to another place on a primary-button press.
   * @param {MouseEvent} event The mousedown on a tab.
   * @param {string} panelId Panel of the tab.
   * @returns {void}
   */
  #onTabPress(event, panelId) {
    if (event.button !== 0) return;
    new PanelDropDrag(event, {
      label: this.#panels.titleOf(panelId),
      findDropTarget: this.#dropTargetAt,
      onDrop: dropTarget => this.#dockAt(panelId, dropTarget),
    });
  }

  /**
   * Docks a known panel at a drop target and saves the layout.
   * @param {string} panelId Panel id.
   * @param {DropTarget} dropTarget Where to dock it.
   * @returns {void}
   */
  #dockAt(panelId, dropTarget) {
    if (dropTarget.edge) this.#tree.dockPanelAtEdge(panelId, dropTarget.edge);
    else this.#tree.dockPanel(panelId, dropTarget.leafId, dropTarget.region);
    this.#layoutAndSave();
  }

  /**
   * The drop target under the pointer in the current layout.
   * @param {number} pointerX Pointer x.
   * @param {number} pointerY Pointer y.
   * @returns {?DropTarget} The target, or null outside every zone.
   */
  #dropTargetAt = (pointerX, pointerY) => DropTargetResolver.resolve(pointerX, pointerY, DockWorkspace.#workspaceBounds(), this.#leafPlacements);
}
