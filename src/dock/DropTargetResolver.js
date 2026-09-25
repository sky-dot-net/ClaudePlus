import { LAYOUT } from '../config/LAYOUT.js';

/**
 * Finds where a dragged panel would dock for a pointer position: an outer workspace edge when the
 * pointer is near one, otherwise the centre or a side of the zone under the pointer.
 */
export class DropTargetResolver {
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
   * The drop target under the pointer.
   * @param {number} pointerX Pointer x.
   * @param {number} pointerY Pointer y.
   * @param {Rect} bounds Workspace area.
   * @param {LeafPlacement[]} leafPlacements Zone areas of the current layout.
   * @returns {?DropTarget} The target, or null outside every zone.
   */
  static resolve(pointerX, pointerY, bounds, leafPlacements) {
    const edge = DropTargetResolver.#outerEdgeNear(pointerX, pointerY, bounds);
    if (edge) return { edge, leafId: null, region: null, rect: DropTargetResolver.#edgeHighlight(edge, bounds) };
    const hoveredZone = leafPlacements.find(({ rect }) => DropTargetResolver.#containsPoint(rect, pointerX, pointerY));
    return hoveredZone ? DropTargetResolver.#zoneDropTarget(hoveredZone, pointerX, pointerY) : null;
  }

  /**
   * Drop target within a zone.
   * @param {LeafPlacement} placement The zone under the pointer.
   * @param {number} pointerX Pointer x.
   * @param {number} pointerY Pointer y.
   * @returns {DropTarget} The target.
   */
  static #zoneDropTarget({ leaf, rect }, pointerX, pointerY) {
    const region = DropTargetResolver.#regionAt((pointerX - rect.left) / rect.width, (pointerY - rect.top) / rect.height);
    return { edge: null, leafId: leaf.id, region, rect: DropTargetResolver.#REGION_HIGHLIGHTS[region](rect) };
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
    return DropTargetResolver.#EDGE_HIGHLIGHTS[edge](bounds, width, height);
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
}
