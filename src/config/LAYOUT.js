/**
 * Workspace geometry. Pixel values are CSS pixels; fractions are of the containing area.
 * toolbarHeight / tabStripHeight: fixed bar heights. minimumSplitFraction: smallest share a split
 * child can be resized to. edgeDockFraction: share of a panel docked at an outer edge.
 * edgeDropMargin: distance from the workspace edge that counts as an edge drop. sideDropFraction:
 * share of a zone near each side that counts as a side drop. dragThreshold: movement before a
 * press becomes a drag. dividerThickness: grab width of a divider. dragLabelOffset: distance of
 * the drag label from the pointer. edgeHighlightMaxWidth / edgeHighlightMaxHeight: size cap of
 * the edge drop highlight.
 * @type {Readonly<Record<string, number>>}
 */
export const LAYOUT = Object.freeze({
  toolbarHeight: 36,
  tabStripHeight: 26,
  minimumSplitFraction: 0.08,
  edgeDockFraction: 0.25,
  edgeDropMargin: 32,
  sideDropFraction: 0.25,
  dragThreshold: 4,
  dividerThickness: 6,
  dragLabelOffset: 12,
  edgeHighlightMaxWidth: 280,
  edgeHighlightMaxHeight: 220,
});
