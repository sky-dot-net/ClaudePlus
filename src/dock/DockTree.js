import { LAYOUT } from '../config/LAYOUT.js';
import { clamp } from '../math/clamp.js';

/**
 * The dock layout as pure data: splits with fractional sizes whose leaves hold tabbed panels.
 */
export class DockTree {
  /**
   * Creates a tree around a root node.
   * @param {DockNode} root The root.
   */
  constructor(root) {
    this.root = root;
  }

  /**
   * The default layout: the conversation list on the left, the chat panes tabbed in the middle
   * above the composer, stats, web sources, files and search tabbed on the right.
   * @param {string[]} chatPaneIds Panel ids of the chat panes, at least one.
   * @returns {DockTree} A new tree.
   */
  static createDefault(chatPaneIds) {
    return new DockTree({
      type: 'split', direction: 'row', sizes: [0.18, 0.62, 0.2],
      children: [
        DockTree.#createLeaf(['conversations'], 'leaf-conversations'),
        {
          type: 'split', direction: 'column', sizes: [0.8, 0.2],
          children: [DockTree.#createLeaf(chatPaneIds, 'leaf-chat'), DockTree.#createLeaf(['composer'], 'leaf-composer')],
        },
        DockTree.#createLeaf(['stats', 'webSources', 'files', 'search'], 'leaf-extras'),
      ],
    });
  }

  /**
   * Every panel id a stored layout mentions, without validating it.
   * @param {*} storedNode Parsed stored layout or node.
   * @returns {Set<string>} The ids; empty for anything that isn't a layout.
   */
  static collectPanelIds(storedNode) {
    const panelIds = new Set();
    DockTree.#collectPanelIdsInto(storedNode, panelIds);
    return panelIds;
  }

  /**
   * Adds the panel ids of a stored node and its descendants to a set.
   * @param {*} storedNode Stored node.
   * @param {Set<string>} panelIds Collected ids; modified in place.
   * @returns {void}
   */
  static #collectPanelIdsInto(storedNode, panelIds) {
    if (!storedNode || typeof storedNode !== 'object') return;
    (Array.isArray(storedNode.tabs) ? storedNode.tabs : []).filter(tab => typeof tab === 'string').forEach(tab => panelIds.add(tab));
    (Array.isArray(storedNode.children) ? storedNode.children : []).forEach(child => DockTree.#collectPanelIdsInto(child, panelIds));
  }

  /**
   * Rebuilds a stored layout, dropping anything malformed, unknown or duplicated.
   * @param {*} storedLayout Parsed stored layout.
   * @param {Iterable<string>} knownPanelIds Ids of the existing panels.
   * @returns {?DockTree} The restored tree, or null when nothing valid remains.
   */
  static fromStored(storedLayout, knownPanelIds) {
    const root = DockTree.#sanitizeNode(storedLayout, new Set(knownPanelIds), new Set());
    return root ? new DockTree(root) : null;
  }

  /**
   * Serializable form.
   * @returns {DockNode} The root node.
   */
  toJSON() {
    return this.root;
  }

  /**
   * Finds a zone by id.
   * @param {string} leafId Zone id.
   * @returns {?LeafNode} The zone, or null.
   */
  findLeaf(leafId) {
    return this.#findNode(node => node.type === 'leaf' && node.id === leafId);
  }

  /**
   * Finds the zone containing a panel.
   * @param {string} panelId Panel id.
   * @returns {?LeafNode} The zone, or null when the panel isn't docked.
   */
  findLeafContaining(panelId) {
    return this.#findNode(node => node.type === 'leaf' && node.tabs.includes(panelId));
  }

  /**
   * The first zone in tree order.
   * @returns {LeafNode} The zone.
   */
  firstLeaf() {
    return this.#findNode(node => node.type === 'leaf');
  }

  /**
   * Makes a panel the visible tab of its zone; ignored if the zone doesn't hold it.
   * @param {string} leafId Zone id.
   * @param {string} panelId Panel id.
   * @returns {void}
   */
  activateTab(leafId, panelId) {
    const leaf = this.findLeaf(leafId);
    if (leaf && leaf.tabs.includes(panelId)) leaf.activeTab = panelId;
  }

  /**
   * Removes a panel from its zone; an emptied zone is removed unless it is the root.
   * @param {string} panelId Panel id.
   * @returns {void}
   */
  removePanel(panelId) {
    const leaf = this.findLeafContaining(panelId);
    if (!leaf) return;
    DockTree.#removeTab(leaf, panelId);
    if (leaf.tabs.length === 0 && leaf !== this.root) this.#removeNode(leaf);
  }

  /**
   * Moves a panel into a zone: 'center' adds it as a tab, a side splits the zone and puts the panel
   * on that side. Dropping a panel onto its own zone only activates it. A missing target falls
   * back to adding a tab to the first zone.
   * @param {string} panelId Panel id.
   * @param {string} targetLeafId Target zone id.
   * @param {string} region 'center', 'left', 'right', 'top' or 'bottom'.
   * @returns {void}
   */
  dockPanel(panelId, targetLeafId, region) {
    if (this.#isDropOntoOwnZone(panelId, targetLeafId, region)) {
      this.activateTab(targetLeafId, panelId);
      return;
    }
    this.removePanel(panelId);
    const targetLeaf = this.findLeaf(targetLeafId);
    if (targetLeaf && region !== 'center') this.#splitLeaf(targetLeaf, panelId, region);
    else DockTree.#addTab(targetLeaf || this.firstLeaf(), panelId);
  }

  /**
   * Docks a panel along an outer edge of the whole workspace. Ignored when the panel is the only one.
   * @param {string} panelId Panel id.
   * @param {string} edge 'left', 'right', 'top' or 'bottom'.
   * @returns {void}
   */
  dockPanelAtEdge(panelId, edge) {
    if (this.#isOnlyPanel(panelId)) return;
    this.removePanel(panelId);
    const edgeShare = LAYOUT.edgeDockFraction;
    this.root = {
      type: 'split',
      direction: DockTree.#directionForSide(edge),
      sizes: DockTree.#isLeadingSide(edge) ? [edgeShare, 1 - edgeShare] : [1 - edgeShare, edgeShare],
      children: DockTree.#orderForSide(edge, this.root, DockTree.#createLeafWithNewId([panelId])),
    };
  }

  /**
   * Moves the boundary after a split child, keeping both neighbours at least LAYOUT.minimumSplitFraction.
   * @param {SplitNode} split The split.
   * @param {number} index Index of the child before the boundary.
   * @param {number[]} startSizes Sizes when the drag started.
   * @param {number} movedFraction Movement as a fraction of the split's extent.
   * @returns {void}
   */
  resizeSplit(split, index, startSizes, movedFraction) {
    const pairSize = startSizes[index] + startSizes[index + 1];
    const firstSize = clamp(startSizes[index] + movedFraction, LAYOUT.minimumSplitFraction, pairSize - LAYOUT.minimumSplitFraction);
    split.sizes[index] = firstSize;
    split.sizes[index + 1] = pairSize - firstSize;
  }

  /**
   * Computes every zone's area and every divider's position.
   * @param {Rect} bounds Area of the whole workspace.
   * @returns {DockLayout} The placements.
   */
  computeLayout(bounds) {
    const layout = { leaves: [], dividers: [] };
    DockTree.#placeNode(this.root, bounds, layout);
    return layout;
  }

  /**
   * Places a node and its descendants.
   * @param {DockNode} node The node.
   * @param {Rect} rect Its area.
   * @param {DockLayout} layout Collected placements; modified in place.
   * @returns {void}
   */
  static #placeNode(node, rect, layout) {
    if (node.type === 'leaf') layout.leaves.push({ leaf: node, rect });
    else DockTree.#placeSplitChildren(node, rect, layout);
  }

  /**
   * Places a split's children one after another along its axis, with a divider between neighbours.
   * @param {SplitNode} split The split.
   * @param {Rect} rect Its area.
   * @param {DockLayout} layout Collected placements; modified in place.
   * @returns {void}
   */
  static #placeSplitChildren(split, rect, layout) {
    const isSideBySide = split.direction === 'row';
    const extent = isSideBySide ? rect.width : rect.height;
    let offset = isSideBySide ? rect.left : rect.top;
    split.children.forEach((child, index) => {
      const childExtent = extent * split.sizes[index];
      DockTree.#placeNode(child, DockTree.#sliceAlongAxis(rect, isSideBySide, offset, childExtent), layout);
      offset += childExtent;
      if (index < split.children.length - 1) layout.dividers.push({ split, index, rect, position: offset });
    });
  }

  /**
   * A slice of a rectangle along one axis.
   * @param {Rect} rect The rectangle.
   * @param {boolean} isSideBySide True to slice horizontally (along x), false vertically (along y).
   * @param {number} offset Start of the slice on that axis.
   * @param {number} extent Length of the slice.
   * @returns {Rect} The slice.
   */
  static #sliceAlongAxis(rect, isSideBySide, offset, extent) {
    return isSideBySide
      ? { left: offset, top: rect.top, width: extent, height: rect.height }
      : { left: rect.left, top: offset, width: rect.width, height: extent };
  }

  /**
   * Whether a drop would leave the layout unchanged: onto the panel's own zone, either as a tab or
   * as a split of a zone holding only that panel.
   * @param {string} panelId Panel id.
   * @param {string} targetLeafId Target zone id.
   * @param {string} region Drop region.
   * @returns {boolean} True for a no-op drop.
   */
  #isDropOntoOwnZone(panelId, targetLeafId, region) {
    const sourceLeaf = this.findLeafContaining(panelId);
    return Boolean(sourceLeaf) && sourceLeaf.id === targetLeafId && (region === 'center' || sourceLeaf.tabs.length === 1);
  }

  /**
   * Whether a panel is the single panel of the whole layout.
   * @param {string} panelId Panel id.
   * @returns {boolean} True when the root is a zone holding only that panel.
   */
  #isOnlyPanel(panelId) {
    return this.root.type === 'leaf' && this.root.tabs.length === 1 && this.root.tabs[0] === panelId;
  }

  /**
   * Replaces a zone with a split of the zone and a new zone holding a panel.
   * @param {LeafNode} targetLeaf Zone to split.
   * @param {string} panelId Panel for the new zone.
   * @param {string} side Side of the new zone: 'left', 'right', 'top' or 'bottom'.
   * @returns {void}
   */
  #splitLeaf(targetLeaf, panelId, side) {
    this.#replaceNode(targetLeaf, {
      type: 'split',
      direction: DockTree.#directionForSide(side),
      sizes: [0.5, 0.5],
      children: DockTree.#orderForSide(side, targetLeaf, DockTree.#createLeafWithNewId([panelId])),
    });
  }

  /**
   * Every node with its parent, depth first.
   * @param {DockNode} node Starting node.
   * @param {?SplitNode} parent Its parent, or null for the root.
   * @yields {{node: DockNode, parent: ?SplitNode}} Each node and its parent.
   * @returns {Generator<{node: DockNode, parent: ?SplitNode}, void, void>} The nodes in tree order.
   */
  static *#walkWithParents(node, parent) {
    yield { node, parent };
    for (const child of node.children ?? []) yield* DockTree.#walkWithParents(child, node);
  }

  /**
   * The first node matching a predicate, with its parent.
   * @param {function(DockNode): boolean} predicate Test for each node.
   * @returns {?{node: DockNode, parent: ?SplitNode}} The match, or null.
   */
  #findWithParent(predicate) {
    for (const entry of DockTree.#walkWithParents(this.root, null)) {
      if (predicate(entry.node)) return entry;
    }
    return null;
  }

  /**
   * The first node matching a predicate.
   * @param {function(DockNode): boolean} predicate Test for each node.
   * @returns {?DockNode} The node, or null.
   */
  #findNode(predicate) {
    const entry = this.#findWithParent(predicate);
    return entry ? entry.node : null;
  }

  /**
   * Puts a replacement where a node is in the tree.
   * @param {DockNode} node Node to replace.
   * @param {DockNode} replacement Its replacement.
   * @returns {void}
   */
  #replaceNode(node, replacement) {
    const { parent } = this.#findWithParent(candidate => candidate === node);
    if (parent) parent.children[parent.children.indexOf(node)] = replacement;
    else this.root = replacement;
  }

  /**
   * Removes a node from its split and rescales the siblings; a split left with one child is
   * replaced by that child.
   * @param {DockNode} node Node to remove; must not be the root.
   * @returns {void}
   */
  #removeNode(node) {
    const { parent } = this.#findWithParent(candidate => candidate === node);
    const index = parent.children.indexOf(node);
    parent.children.splice(index, 1);
    parent.sizes.splice(index, 1);
    parent.sizes = DockTree.#normalizeSizes(parent.sizes);
    if (parent.children.length === 1) this.#replaceNode(parent, parent.children[0]);
  }

  /**
   * Removes a tab from a zone, activating the first remaining tab if it was active.
   * @param {LeafNode} leaf The zone.
   * @param {string} panelId Panel id.
   * @returns {void}
   */
  static #removeTab(leaf, panelId) {
    leaf.tabs = leaf.tabs.filter(tab => tab !== panelId);
    if (leaf.activeTab === panelId) leaf.activeTab = leaf.tabs.length ? leaf.tabs[0] : null;
  }

  /**
   * Adds a panel as the active tab of a zone.
   * @param {LeafNode} leaf The zone.
   * @param {string} panelId Panel id.
   * @returns {void}
   */
  static #addTab(leaf, panelId) {
    leaf.tabs.push(panelId);
    leaf.activeTab = panelId;
  }

  /**
   * Creates a zone with a given id; the first tab is active.
   * @param {string[]} tabs Panel ids, at least one.
   * @param {string} leafId Zone id.
   * @returns {LeafNode} The zone.
   */
  static #createLeaf(tabs, leafId) {
    return { type: 'leaf', id: leafId, tabs: [...tabs], activeTab: tabs[0] };
  }

  /**
   * Creates a zone with a new unique id.
   * @param {string[]} tabs Panel ids, at least one.
   * @returns {LeafNode} The zone.
   */
  static #createLeafWithNewId(tabs) {
    return DockTree.#createLeaf(tabs, `leaf-${crypto.randomUUID()}`);
  }

  /**
   * Whether a side comes first in its split.
   * @param {string} side 'left', 'right', 'top' or 'bottom'.
   * @returns {boolean} True for left and top.
   */
  static #isLeadingSide(side) {
    return side === 'left' || side === 'top';
  }

  /**
   * Split direction for a side.
   * @param {string} side 'left', 'right', 'top' or 'bottom'.
   * @returns {'row'|'column'} 'row' for left and right, 'column' for top and bottom.
   */
  static #directionForSide(side) {
    return side === 'left' || side === 'right' ? 'row' : 'column';
  }

  /**
   * Orders an existing node and an added one for a split.
   * @param {string} side Side the added node goes on.
   * @param {DockNode} existingNode Node already there.
   * @param {DockNode} addedNode Node being added.
   * @returns {DockNode[]} Both nodes in split order.
   */
  static #orderForSide(side, existingNode, addedNode) {
    return DockTree.#isLeadingSide(side) ? [addedNode, existingNode] : [existingNode, addedNode];
  }

  /**
   * Scales sizes to sum to 1.
   * @param {number[]} sizes Positive sizes.
   * @returns {number[]} The scaled sizes; equal shares if the sum is 0.
   */
  static #normalizeSizes(sizes) {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    return total > 0 ? sizes.map(size => size / total) : sizes.map(() => 1 / sizes.length);
  }

  /**
   * Validates a stored node.
   * @param {*} node Stored node.
   * @param {Set<string>} knownPanelIds Ids of the existing panels.
   * @param {Set<string>} placedPanelIds Panel ids already placed; modified in place.
   * @returns {?DockNode} The cleaned node, or null when nothing valid remains.
   */
  static #sanitizeNode(node, knownPanelIds, placedPanelIds) {
    if (DockTree.#isStoredLeaf(node)) return DockTree.#sanitizeLeaf(node, knownPanelIds, placedPanelIds);
    if (DockTree.#isStoredSplit(node)) return DockTree.#sanitizeSplit(node, knownPanelIds, placedPanelIds);
    return null;
  }

  /**
   * Whether a stored value looks like a zone.
   * @param {*} node Stored value.
   * @returns {boolean} True for an object with type 'leaf' and a tabs array.
   */
  static #isStoredLeaf(node) {
    return Boolean(node) && node.type === 'leaf' && Array.isArray(node.tabs);
  }

  /**
   * Whether a stored value looks like a split.
   * @param {*} node Stored value.
   * @returns {boolean} True for an object with type 'split' and a children array.
   */
  static #isStoredSplit(node) {
    return Boolean(node) && node.type === 'split' && Array.isArray(node.children);
  }

  /**
   * Keeps a stored zone's known, not yet placed tabs.
   * @param {{id: *, tabs: Array<*>, activeTab: *}} node Stored zone.
   * @param {Set<string>} knownPanelIds Ids of the existing panels.
   * @param {Set<string>} placedPanelIds Panel ids already placed; modified in place.
   * @returns {?LeafNode} The zone, or null when no tab remains.
   */
  static #sanitizeLeaf(node, knownPanelIds, placedPanelIds) {
    const tabs = node.tabs.filter(panelId => knownPanelIds.has(panelId) && !placedPanelIds.has(panelId));
    if (tabs.length === 0) return null;
    tabs.forEach(panelId => placedPanelIds.add(panelId));
    const leaf = typeof node.id === 'string' ? DockTree.#createLeaf(tabs, node.id) : DockTree.#createLeafWithNewId(tabs);
    if (tabs.includes(node.activeTab)) leaf.activeTab = node.activeTab;
    return leaf;
  }

  /**
   * Keeps a stored split's valid children and rescales their sizes; a split with one child is
   * replaced by the child.
   * @param {{direction: *, sizes: *, children: Array<*>}} node Stored split.
   * @param {Set<string>} knownPanelIds Ids of the existing panels.
   * @param {Set<string>} placedPanelIds Panel ids already placed; modified in place.
   * @returns {?DockNode} The cleaned node, or null when no child remains.
   */
  static #sanitizeSplit(node, knownPanelIds, placedPanelIds) {
    const keptChildren = node.children
      .map((child, index) => ({ node: DockTree.#sanitizeNode(child, knownPanelIds, placedPanelIds), size: DockTree.#storedSize(node.sizes, index) }))
      .filter(entry => entry.node);
    if (keptChildren.length < 2) return keptChildren.length ? keptChildren[0].node : null;
    return {
      type: 'split',
      direction: node.direction === 'column' ? 'column' : 'row',
      sizes: DockTree.#normalizeSizes(keptChildren.map(entry => entry.size)),
      children: keptChildren.map(entry => entry.node),
    };
  }

  /**
   * A stored child size, if valid.
   * @param {*} sizes Stored sizes.
   * @param {number} index Child index.
   * @returns {number} The size if it is a positive finite number, otherwise 1.
   */
  static #storedSize(sizes, index) {
    const size = Array.isArray(sizes) ? sizes[index] : NaN;
    return Number.isFinite(size) && size > 0 ? size : 1;
  }
}
