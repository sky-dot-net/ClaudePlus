import { FrameScheduler } from '../../dom/FrameScheduler.js';
import { ItemHeights } from './ItemHeights.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { TIMING } from '../../config/TIMING.js';
import { createElement } from '../../dom/createElement.js';
import stylesheet from './VirtualList.css';

StyleRegistry.register(stylesheet);

/**
 * Windowed rendering for a long list: only the items near the visible area exist in the DOM, with
 * two empty spacers standing in for everything above and below, so a list of tens of thousands of
 * items costs as much as one screenful. Items entering the window are created and items leaving it
 * are removed one by one; the ones staying are never touched, so widgets, focus and hover state
 * survive scrolling. Item heights are measured as items are rendered (and re-measured when they
 * resize, e.g. an image loading) and estimated for the rest; the item at the top of the view is
 * kept steady while those numbers change.
 */
export class VirtualList {
  /**
   * Most times the window is re-rendered in one update while measured heights shift the estimates.
   * @type {number}
   */
  static #MAX_FILL_PASSES = 6;

  /**
   * Options given to the constructor, with defaults filled in.
   * @type {object}
   */
  #options;

  /**
   * Element that scrolls.
   * @type {HTMLElement}
   */
  #scrollElement;

  /**
   * Element holding the spacers and the rendered items; the scroll element itself or a descendant.
   * @type {HTMLElement}
   */
  #contentElement;

  /**
   * Item heights, measured and estimated.
   * @type {ItemHeights}
   */
  #heights;

  /**
   * Elements of the rendered items, in order.
   * @type {HTMLElement[]}
   */
  #items = [];

  /**
   * Index of the first rendered item.
   * @type {number}
   */
  #start = 0;

  /**
   * Index after the last rendered item.
   * @type {number}
   */
  #end = 0;

  /**
   * Spacer standing in for the items above the window; null while nothing is rendered.
   * @type {?HTMLElement}
   */
  #topSpacer = null;

  /**
   * Spacer standing in for the items below the window; null while nothing is rendered.
   * @type {?HTMLElement}
   */
  #bottomSpacer = null;

  /**
   * Index of each rendered item's element.
   * @type {WeakMap<HTMLElement, number>}
   */
  #indexByElement = new WeakMap();

  /**
   * Whether the view was at the end of the list when it last scrolled.
   * @type {boolean}
   */
  #isAtEnd = true;

  /**
   * The item at the top of the view and where it was, kept in place while heights change.
   * @type {?{element: HTMLElement, top: number}}
   */
  #anchor = null;

  /**
   * Width of the scroll element when last laid out.
   * @type {number}
   */
  #width;

  /**
   * Timer waiting for the scroll element's width to stop changing, or null while none is.
   * @type {?number}
   */
  #resizeTimer = null;

  /**
   * Runs the window update once per frame while scrolling.
   * @type {FrameScheduler}
   */
  #frame = new FrameScheduler(() => this.#onFrame());

  /**
   * Watches the scroll element and the rendered items for size changes.
   * @type {ResizeObserver}
   */
  #observer = new ResizeObserver(entries => this.#onResize(entries));

  /**
   * Creates the list and starts following its scrolling and size.
   * @param {object} options List options.
   * @param {HTMLElement} options.scrollElement Element that scrolls.
   * @param {HTMLElement} options.contentElement Element the spacers and items are rendered into.
   * @param {number} options.gap Gap between items, in pixels (0 for none).
   * @param {number} options.estimatedHeight Height assumed for items until some are measured.
   * @param {function(number, number): string} options.renderItems HTML of the items from an index up to another, each exactly one root element.
   * @param {function(): string} options.emptyHtml HTML shown while the list has no items.
   * @param {function(): HTMLElement} [options.createSpacer] Creates a spacer element; a div by default.
   * @param {function(HTMLElement, number): void} [options.setSpacerHeight] Sizes a spacer, hiding it when 0.
   * @param {function(HTMLElement[], number): void} [options.onItemsRendered] Called with newly created item elements and the index of the first.
   * @param {function(): void} [options.onWidthChange] Called instead of a plain refresh when the scroll element's width changed.
   * @param {boolean} [options.followsEnd] Whether the view stays at the end while it was there and content grows.
   * @param {number} [options.endDistance] Distance from the end, in pixels, still counting as "at the end".
   */
  constructor(options) {
    this.#options = { createSpacer: VirtualList.#createDivSpacer, setSpacerHeight: VirtualList.#setDivSpacerHeight, followsEnd: false, endDistance: 40, ...options };
    this.#scrollElement = options.scrollElement;
    this.#contentElement = options.contentElement;
    this.#heights = new ItemHeights(options.gap, options.estimatedHeight);
    this.#width = this.#scrollElement.clientWidth;
    this.#scrollElement.style.overflowAnchor = 'none';
    this.#scrollElement.addEventListener('scroll', this.#onScroll);
    this.#observer.observe(this.#scrollElement);
  }

  /**
   * Number of items in the list.
   * @returns {number} The count.
   */
  get count() {
    return this.#heights.count;
  }

  /**
   * Sets the number of items and re-renders the window.
   * @param {number} count New item count.
   * @returns {void}
   */
  setCount(count) {
    this.#heights.setCount(count);
    this.refresh();
  }

  /**
   * Re-renders every item of the window from scratch, e.g. after the items' content changed; a
   * list that follows its end stays at the end if it was there.
   * @returns {void}
   */
  refresh() {
    this.#detachItems();
    this.#update(true);
    if (this.#options.followsEnd && this.#isAtEnd) this.scrollToEnd();
  }

  /**
   * Forgets every measured height and starts following the end again; for a different list.
   * @returns {void}
   */
  reset() {
    this.#heights.clear();
    this.#isAtEnd = true;
  }

  /**
   * The element of a rendered item.
   * @param {number} index Item index.
   * @returns {?HTMLElement} The element, or null while that item isn't in the window.
   */
  elementAt(index) {
    return index >= this.#start && index < this.#end ? this.#items[index - this.#start] : null;
  }

  /**
   * Scrolls an item into view, rendering it first.
   * @param {number} index Item index.
   * @param {'start'|'center'} block Where in the view to put it.
   * @returns {void}
   */
  scrollToIndex(index, block) {
    const viewportHeight = this.#scrollElement.clientHeight;
    const top = this.#contentOffset() + this.#heights.offsetOf(index);
    this.#scrollElement.scrollTop = block === 'center' ? top - (viewportHeight - this.#heights.heightOf(index)) / 2 : top;
    this.#update(true);
    this.#alignRendered(index, block);
  }

  /**
   * Scrolls to the end of the list; a few passes, since the estimated heights above settle into
   * measured ones as the items near the end are rendered.
   * @returns {void}
   */
  scrollToEnd() {
    for (let pass = 0; pass < 3; pass += 1) {
      this.#scrollElement.scrollTop = this.#scrollElement.scrollHeight;
      this.#update(false);
    }
    this.#isAtEnd = true;
    this.#anchor = this.#captureAnchor();
  }

  /**
   * Keeps the end in view after content grew, if the view was following the end.
   * @returns {void}
   */
  keepEndInView() {
    if (this.#options.followsEnd && this.#isAtEnd) this.#scrollElement.scrollTop = this.#scrollElement.scrollHeight;
  }

  /**
   * Stops watching the scroll element and its items.
   * @returns {void}
   */
  dispose() {
    this.#cancelWidthSettle();
    this.#frame.cancel();
    this.#observer.disconnect();
    this.#scrollElement.removeEventListener('scroll', this.#onScroll);
  }

  /**
   * A spacer that is a plain block.
   * @returns {HTMLElement} The spacer.
   */
  static #createDivSpacer() {
    return createElement('div', { className: 'claude-plus-virtual-spacer' });
  }

  /**
   * Sizes a plain spacer, hiding it while it has no size.
   * @param {HTMLElement} spacer The spacer.
   * @param {number} height Height in pixels.
   * @returns {void}
   */
  static #setDivSpacerHeight(spacer, height) {
    spacer.hidden = height <= 0;
    spacer.style.height = `${height}px`;
  }

  /**
   * Follows the scroll position and keeps the window around it.
   * @returns {void}
   */
  #onScroll = () => {
    this.#frame.schedule();
  };

  /**
   * Once per frame of scrolling: notes whether the view is at the end, then moves the window.
   * @returns {void}
   */
  #onFrame() {
    this.#isAtEnd = this.#isNearEnd();
    this.#update(false);
    this.#anchor = this.#captureAnchor();
  }

  /**
   * Whether the view is at (or near) the end of its content.
   * @returns {boolean} True within the configured distance of the end.
   */
  #isNearEnd() {
    const element = this.#scrollElement;
    return element.scrollHeight - element.scrollTop - element.clientHeight < this.#options.endDistance;
  }

  /**
   * Whether anything can be laid out: a hidden element has no size to measure or fill.
   * @returns {boolean} True while the scroll element has a height.
   */
  #canRender() {
    return this.#scrollElement.clientHeight > 0;
  }

  /**
   * Renders the items the view needs, unless the window already covers it.
   * @param {boolean} force Whether to render even when the window already covers the view.
   * @returns {void}
   */
  #update(force) {
    if (!this.#canRender()) return;
    if (this.#heights.count === 0) this.#showEmpty();
    else this.#fill(force);
  }

  /**
   * Renders the window until it covers the view. Rendering measures items, which changes the
   * estimate for every item not yet measured and so where the view lies among them, so it can take
   * a few passes to settle.
   * @param {boolean} force Whether to render at least once even when the window already covers the view.
   * @returns {void}
   */
  #fill(force) {
    let isForced = force;
    for (let pass = 0; pass < VirtualList.#MAX_FILL_PASSES; pass += 1) {
      const view = this.#view();
      if (!isForced && this.#covers(view)) return;
      isForced = false;
      this.#apply(this.#windowFor(view));
    }
    this.#frame.schedule();
  }

  /**
   * The visible part of the content.
   * @returns {{top: number, bottom: number, height: number}} Top and bottom edges, relative to the first item's top, and the height.
   */
  #view() {
    const height = this.#scrollElement.clientHeight;
    const top = this.#scrollElement.scrollTop - this.#contentOffset();
    return { top, bottom: top + height, height };
  }

  /**
   * Distance from the top of the scrollable content to the top of the first item.
   * @returns {number} The offset in pixels.
   */
  #contentOffset() {
    if (this.#contentElement === this.#scrollElement) return parseFloat(getComputedStyle(this.#scrollElement).paddingTop) || 0;
    return this.#contentElement.getBoundingClientRect().top - this.#scrollElement.getBoundingClientRect().top + this.#scrollElement.scrollTop;
  }

  /**
   * Whether the rendered items reach half a view beyond the visible area on both sides.
   * @param {{top: number, bottom: number, height: number}} view The visible part of the content.
   * @returns {boolean} True when nothing needs rendering yet.
   */
  #covers(view) {
    if (this.#items.length === 0) return false;
    const margin = view.height / 2;
    return this.#heights.indexAt(Math.max(0, view.top - margin)) >= this.#start && this.#heights.indexAt(Math.max(0, view.bottom + margin)) < this.#end;
  }

  /**
   * The items to render for a view: those in it plus a view's height beyond it on both sides.
   * @param {{top: number, bottom: number, height: number}} view The visible part of the content.
   * @returns {{start: number, end: number}} Index of the first item and the index after the last.
   */
  #windowFor(view) {
    return {
      start: this.#heights.indexAt(Math.max(0, view.top - view.height)),
      end: Math.min(this.#heights.count, this.#heights.indexAt(Math.max(0, view.bottom + view.height)) + 1),
    };
  }

  /**
   * Renders a window of items, keeping the item at the top of the view where it is.
   * @param {{start: number, end: number}} range The items to render: the index of the first and the index after the last.
   * @returns {void}
   */
  #apply({ start, end }) {
    const anchor = this.#captureAnchor();
    if (this.#items.length > 0 && start < this.#end && end > this.#start) this.#slideTo(start, end);
    else this.#replaceWith(start, end);
    this.#updateSpacers();
    this.#restoreAnchor(anchor);
    this.#anchor = this.#captureAnchor();
  }

  /**
   * Replaces everything rendered with a window of items.
   * @param {number} start Index of the first item.
   * @param {number} end Index after the last item.
   * @returns {void}
   */
  #replaceWith(start, end) {
    this.#detachItems();
    this.#topSpacer = this.#options.createSpacer();
    this.#bottomSpacer = this.#options.createSpacer();
    const elements = this.#createElements(start, end);
    this.#contentElement.replaceChildren(this.#topSpacer, ...elements, this.#bottomSpacer);
    this.#items = elements;
    this.#start = start;
    this.#end = end;
    this.#updateSpacers();
    this.#register(elements, start);
  }

  /**
   * Moves the window over the rendered items: removes the ones that left it and creates the ones
   * that entered it, leaving the rest alone.
   * @param {number} start Index of the first item.
   * @param {number} end Index after the last item.
   * @returns {void}
   */
  #slideTo(start, end) {
    while (this.#start < start) {
      this.#release(this.#items.shift());
      this.#start += 1;
    }
    while (this.#end > end) {
      this.#release(this.#items.pop());
      this.#end -= 1;
    }
    this.#updateSpacers();
    if (start < this.#start) this.#growAbove(start);
    if (end > this.#end) this.#growBelow(end);
  }

  /**
   * Creates the items between a new window start and the rendered ones.
   * @param {number} start Index of the new first item.
   * @returns {void}
   */
  #growAbove(start) {
    const elements = this.#createElements(start, this.#start);
    this.#items[0].before(...elements);
    this.#items = [...elements, ...this.#items];
    this.#start = start;
    this.#register(elements, start);
  }

  /**
   * Creates the items between the rendered ones and a new window end.
   * @param {number} end Index after the new last item.
   * @returns {void}
   */
  #growBelow(end) {
    const elements = this.#createElements(this.#end, end);
    this.#items[this.#items.length - 1].after(...elements);
    const from = this.#end;
    this.#items = [...this.#items, ...elements];
    this.#end = end;
    this.#register(elements, from);
  }

  /**
   * Creates the elements of a run of items.
   * @param {number} from Index of the first item.
   * @param {number} until Index after the last item.
   * @returns {HTMLElement[]} One element per item.
   */
  #createElements(from, until) {
    const range = document.createRange();
    range.selectNodeContents(this.#contentElement);
    return [...range.createContextualFragment(this.#options.renderItems(from, until)).children];
  }

  /**
   * Starts tracking newly created items: their indexes, sizes and creation callback.
   * @param {HTMLElement[]} elements The new items' elements.
   * @param {number} from Index of the first one.
   * @returns {void}
   */
  #register(elements, from) {
    elements.forEach((element, offset) => {
      this.#indexByElement.set(element, from + offset);
      this.#observer.observe(element);
      this.#heights.record(from + offset, element.getBoundingClientRect().height);
    });
    if (this.#options.onItemsRendered) this.#options.onItemsRendered(elements, from);
  }

  /**
   * Removes an item that left the window.
   * @param {HTMLElement} element The item's element.
   * @returns {void}
   */
  #release(element) {
    this.#observer.unobserve(element);
    element.remove();
  }

  /**
   * Removes every rendered item.
   * @returns {void}
   */
  #detachItems() {
    this.#items.forEach(element => this.#observer.unobserve(element));
    this.#items = [];
    this.#start = 0;
    this.#end = 0;
    this.#anchor = null;
  }

  /**
   * Shows the empty state in place of any items.
   * @returns {void}
   */
  #showEmpty() {
    this.#detachItems();
    this.#topSpacer = null;
    this.#bottomSpacer = null;
    this.#contentElement.innerHTML = this.#options.emptyHtml();
  }

  /**
   * Sizes the spacers from the item heights; a spacer with nothing to stand in for is removed.
   * @returns {void}
   */
  #updateSpacers() {
    this.#sizeSpacer(this.#topSpacer, this.#heights.spanBetween(0, this.#start), () => this.#contentElement.prepend(this.#topSpacer));
    this.#sizeSpacer(this.#bottomSpacer, this.#heights.spanBetween(this.#end, this.#heights.count), () => this.#contentElement.append(this.#bottomSpacer));
  }

  /**
   * Sizes one spacer, putting it in the content or taking it out as needed.
   * @param {HTMLElement} spacer The spacer.
   * @param {number} height Height in pixels; 0 when it has nothing to stand in for.
   * @param {function(): void} attach Puts the spacer into the content at its end.
   * @returns {void}
   */
  #sizeSpacer(spacer, height, attach) {
    this.#options.setSpacerHeight(spacer, height);
    if (height <= 0) spacer.remove();
    else if (!spacer.isConnected) attach();
  }

  /**
   * The first item in the view and where it is.
   * @returns {?{element: HTMLElement, top: number}} The anchor, or null when nothing is rendered.
   */
  #captureAnchor() {
    const viewTop = this.#scrollElement.getBoundingClientRect().top;
    const element = this.#items.find(item => item.getBoundingClientRect().bottom > viewTop + 1);
    return element ? { element, top: element.getBoundingClientRect().top } : null;
  }

  /**
   * Scrolls so an anchor item is back where it was.
   * @param {?{element: HTMLElement, top: number}} anchor The anchor to restore.
   * @returns {void}
   */
  #restoreAnchor(anchor) {
    if (!anchor || !anchor.element.isConnected) return;
    const shift = anchor.element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(shift) > 0.5) this.#scrollElement.scrollTop += shift;
  }

  /**
   * Fine-tunes the scroll position once an item is rendered and measured.
   * @param {number} index Item index.
   * @param {'start'|'center'} block Where in the view to put it.
   * @returns {void}
   */
  #alignRendered(index, block) {
    const element = this.elementAt(index);
    if (!element) return;
    const viewTop = this.#scrollElement.getBoundingClientRect().top;
    const rect = element.getBoundingClientRect();
    const wanted = block === 'center' ? viewTop + (this.#scrollElement.clientHeight - rect.height) / 2 : viewTop;
    this.#scrollElement.scrollTop += rect.top - wanted;
    this.#update(false);
    this.#anchor = this.#captureAnchor();
  }

  /**
   * Reacts to size changes of the scroll element and of rendered items.
   * @param {ResizeObserverEntry[]} entries The changed elements.
   * @returns {void}
   */
  #onResize(entries) {
    if (entries.some(entry => entry.target === this.#scrollElement)) this.#onContainerResized();
    if (this.#resizeTimer !== null) return;
    if (entries.filter(entry => entry.target !== this.#scrollElement).map(entry => this.#noteItemSize(entry.target)).some(Boolean)) this.#stabilize();
  }

  /**
   * Records a rendered item's current height.
   * @param {HTMLElement} element The item's element.
   * @returns {boolean} True when its height differs from the recorded one.
   */
  #noteItemSize(element) {
    const index = this.#indexByElement.get(element);
    return index !== undefined && this.#canRender() && this.#heights.record(index, element.getBoundingClientRect().height);
  }

  /**
   * Reacts to the scroll element changing size: just fills any newly visible space when only its
   * height changed, and lays everything out again when its width changed - but only once the width
   * has stopped changing, so dragging a divider doesn't re-render on every pixel of movement.
   * @returns {void}
   */
  #onContainerResized() {
    if (!this.#canRender()) return;
    if (this.#scrollElement.clientWidth === this.#width) {
      this.#cancelWidthSettle();
      this.#update(this.#items.length === 0);
    } else if (this.#items.length === 0) {
      this.#applyWidthChange();
    } else {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = setTimeout(() => this.#applyWidthChange(), TIMING.resizeSettleMs);
    }
  }

  /**
   * Forgets a width change that is waiting to settle.
   * @returns {void}
   */
  #cancelWidthSettle() {
    clearTimeout(this.#resizeTimer);
    this.#resizeTimer = null;
  }

  /**
   * Lays everything out from scratch for the scroll element's new width, since that rewraps every
   * item and so changes every height.
   * @returns {void}
   */
  #applyWidthChange() {
    this.#resizeTimer = null;
    if (!this.#canRender()) return;
    this.#width = this.#scrollElement.clientWidth;
    this.#heights.clear();
    if (this.#options.onWidthChange) this.#options.onWidthChange();
    else this.refresh();
  }

  /**
   * After rendered items changed height: resizes the spacers and either stays at the end or keeps
   * the item at the top of the view where it was.
   * @returns {void}
   */
  #stabilize() {
    this.#updateSpacers();
    if (this.#options.followsEnd && this.#isAtEnd) this.#scrollElement.scrollTop = this.#scrollElement.scrollHeight;
    else this.#restoreAnchor(this.#anchor);
    this.#anchor = this.#captureAnchor();
  }
}
