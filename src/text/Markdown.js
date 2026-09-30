import { StyleRegistry } from '../styles/StyleRegistry.js';
import { escapeHtml } from './escapeHtml.js';
import stylesheet from './Markdown.css';

StyleRegistry.register(stylesheet);

/**
 * Minimal markdown renderer: fenced code blocks; GFM tables, ATX headings, horizontal rules,
 * blockquotes and nested ordered/unordered lists as real block elements; and inline code, bold,
 * italic and http(s) links elsewhere. All other text is HTML-escaped; every original newline
 * outside a block element becomes a line break, matching how Claude's own replies are spaced.
 */
export class Markdown {
  /**
   * A fenced code block, with or without a language line; captures the code.
   * @type {RegExp}
   */
  static #CODE_FENCE = /```(?:[^\n`]*\n)?([\s\S]*?)```/;

  /**
   * One table separator cell, e.g. "---", ":--", "--:" or ":-:".
   * @type {RegExp}
   */
  static #TABLE_SEPARATOR_CELL = /^:?-{1,}:?$/;

  /**
   * An ATX heading line: 1-6 leading #'s, a space, then the heading text; trailing #'s are ignored.
   * @type {RegExp}
   */
  static #HEADING_LINE = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

  /**
   * A line that is only a repeated -, * or _ (a thematic break).
   * @type {RegExp}
   */
  static #HR_LINE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

  /**
   * A blockquote line: up to 3 leading spaces, ">", and an optional single space before the text.
   * @type {RegExp}
   */
  static #QUOTE_LINE = /^ {0,3}>\s?(.*)$/;

  /**
   * An unordered list item: captures its leading spaces (nesting depth) and its text after a -, *
   * or + marker.
   * @type {RegExp}
   */
  static #UNORDERED_ITEM = /^(\s*)[-*+]\s+(.+)$/;

  /**
   * An ordered list item: captures its leading spaces (nesting depth) and its text after a digit
   * marker ("." or ")").
   * @type {RegExp}
   */
  static #ORDERED_ITEM = /^(\s*)\d+[.)]\s+(.+)$/;

  /**
   * Block readers tried, in order, at each line: a table, a heading, a horizontal rule, a
   * blockquote, then a list; a line matching none of them is plain text.
   * @type {ReadonlyArray<{test: function(string[], number): boolean, read: function(string[], number): {blockHtml: string, nextIndex: number}}>}
   */
  static #BLOCK_READERS = [
    { test: Markdown.#isTableStart, read: Markdown.#readTable },
    { test: Markdown.#isHeadingLine, read: Markdown.#readHeading },
    { test: Markdown.#isHrLine, read: Markdown.#readHr },
    { test: Markdown.#isQuoteLine, read: Markdown.#readQuote },
    { test: Markdown.#isListLine, read: Markdown.#readList },
  ];

  /**
   * Renders markdown text as HTML.
   * @param {?string} text Markdown text.
   * @returns {string} The HTML; empty for empty text.
   */
  static toHtml(text) {
    if (!text) return '';
    const segments = text.split(Markdown.#CODE_FENCE);
    return segments.map((segment, index) => Markdown.#segmentHtml(segment, index, segments.length)).join('');
  }

  /**
   * Renders one segment of the split text. Splitting with one capture group alternates plain text
   * (even indexes) and code (odd indexes).
   * @param {string} segment The text of the segment.
   * @param {number} index Position of the segment.
   * @param {number} segmentCount Total number of segments.
   * @returns {string} The HTML of the segment.
   */
  static #segmentHtml(segment, index, segmentCount) {
    if (index % 2) return `<pre class="claude-plus-code-block"><code>${escapeHtml(segment)}</code></pre>`;
    return Markdown.#textSegmentHtml(Markdown.#trimFenceLineBreaks(segment, index, segmentCount));
  }

  /**
   * Removes the line breaks directly before and after a code fence, which belong to the fence.
   * @param {string} text Plain text segment.
   * @param {number} index Position of the segment.
   * @param {number} segmentCount Total number of segments.
   * @returns {string} The text without fence-adjacent line breaks.
   */
  static #trimFenceLineBreaks(text, index, segmentCount) {
    const withoutLeading = index > 0 ? text.replace(/^\n/, '') : text;
    return index < segmentCount - 1 ? withoutLeading.replace(/\n$/, '') : withoutLeading;
  }

  /**
   * Renders a plain-text segment: each block element (table, heading, rule, quote, list) as real
   * HTML, and every other line the old way - inline markup with each newline kept as a line break.
   * @param {string} text Plain text segment (no code fences).
   * @returns {string} The HTML.
   */
  static #textSegmentHtml(text) {
    const lines = text.split('\n');
    const parts = [];
    let plainLines = [];
    for (let index = 0; index < lines.length; ) {
      const reader = Markdown.#blockReaderAt(lines, index);
      if (!reader) {
        plainLines.push(lines[index]);
        index += 1;
        continue;
      }
      parts.push(Markdown.#flushPlainRun(plainLines));
      plainLines = [];
      const block = reader.read(lines, index);
      parts.push(block.blockHtml);
      index = block.nextIndex;
    }
    parts.push(Markdown.#flushPlainRun(plainLines));
    return parts.join('');
  }

  /**
   * The block reader that claims a line, if any.
   * @param {string[]} lines The segment's lines.
   * @param {number} index Line to check.
   * @returns {?{read: function(string[], number): {blockHtml: string, nextIndex: number}}} The reader, or null for plain text.
   */
  static #blockReaderAt(lines, index) {
    return Markdown.#BLOCK_READERS.find(reader => reader.test(lines, index)) ?? null;
  }

  /**
   * Renders the lines collected outside any block element, the way this renderer always has:
   * inline markup with each original line joined by a line break.
   * @param {string[]} plainLines Lines outside any block element, in order.
   * @returns {string} The HTML; empty when there are no lines.
   */
  static #flushPlainRun(plainLines) {
    return plainLines.length ? Markdown.#inlineMarkupHtml(plainLines.join('\n')).replace(/\n/g, '<br>') : '';
  }

  /**
   * Lines starting at an index for as long as they match a test, at least the first one.
   * @param {string[]} lines The segment's lines.
   * @param {number} start Index to start at.
   * @param {function(string[], number): boolean} test Whether the line at an index still qualifies.
   * @returns {string[]} The matching lines, in order.
   */
  static #consecutiveLines(lines, start, test) {
    const collected = [];
    for (let index = start; index < lines.length && test(lines, index); index += 1) collected.push(lines[index]);
    return collected;
  }

  /**
   * Whether a GFM table starts at a line: the line has a cell separator and the next line is a
   * valid separator row.
   * @param {string[]} lines The segment's lines.
   * @param {number} index Line to check.
   * @returns {boolean} True when a table starts here.
   */
  static #isTableStart(lines, index) {
    return Markdown.#isTableRow(lines[index]) && Markdown.#isTableSeparatorRow(lines[index + 1]);
  }

  /**
   * Whether a line could be a row of a table: non-blank and containing a cell separator.
   * @param {?string} line The line.
   * @returns {boolean} True when it qualifies.
   */
  static #isTableRow(line) {
    return typeof line === 'string' && line.includes('|') && line.trim().length > 0;
  }

  /**
   * Whether a line is a table's separator row: every cell is only dashes, optionally with a
   * leading and/or trailing colon for alignment.
   * @param {?string} line The line.
   * @returns {boolean} True when it qualifies.
   */
  static #isTableSeparatorRow(line) {
    if (!Markdown.#isTableRow(line)) return false;
    return Markdown.#tableCells(line).every(cell => Markdown.#TABLE_SEPARATOR_CELL.test(cell));
  }

  /**
   * Splits a table row into its cell texts, tolerating optional leading/trailing pipes and
   * ignoring pipes escaped with a backslash.
   * @param {string} line The row's raw line.
   * @returns {string[]} The cell texts, trimmed.
   */
  static #tableCells(line) {
    const withoutEdges = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '');
    return withoutEdges.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
  }

  /**
   * Reads a GFM table starting at its header row.
   * @param {string[]} lines The segment's lines.
   * @param {number} index Index of the header row.
   * @returns {{blockHtml: string, nextIndex: number}} The table's HTML and the index of the next unread line.
   */
  static #readTable(lines, index) {
    const headerCells = Markdown.#tableCells(lines[index]);
    const aligns = Markdown.#tableCells(lines[index + 1]).map(Markdown.#columnAlign);
    const bodyLines = Markdown.#tableBodyLines(lines, index + 2);
    const headHtml = `<thead><tr>${headerCells.map((cell, position) => Markdown.#tableCellHtml('th', cell, aligns[position])).join('')}</tr></thead>`;
    const bodyHtml = `<tbody>${bodyLines.map(line => Markdown.#tableRowHtml(line, aligns)).join('')}</tbody>`;
    const blockHtml = `<div class="claude-plus-md-table-scroll"><table class="claude-plus-md-table">${headHtml}${bodyHtml}</table></div>`;
    return { blockHtml, nextIndex: index + 2 + bodyLines.length };
  }

  /**
   * The data rows directly following a table's separator row.
   * @param {string[]} lines The segment's lines.
   * @param {number} start Index of the first possible data row.
   * @returns {string[]} The data rows, in order; empty when the table has none.
   */
  static #tableBodyLines(lines, start) {
    const bodyLines = [];
    for (let index = start; index < lines.length && Markdown.#isTableRow(lines[index]); index += 1) bodyLines.push(lines[index]);
    return bodyLines;
  }

  /**
   * A column's text alignment from its separator cell.
   * @param {string} separatorCell The column's separator cell, e.g. ":--", "--:" or ":-:".
   * @returns {''|'left'|'right'|'center'} The alignment; '' for the default.
   */
  static #columnAlign(separatorCell) {
    const isLeft = separatorCell.startsWith(':');
    const isRight = separatorCell.endsWith(':');
    if (isLeft && isRight) return 'center';
    if (isRight) return 'right';
    return isLeft ? 'left' : '';
  }

  /**
   * HTML of one table cell.
   * @param {'th'|'td'} tag Cell element.
   * @param {string} cellText The cell's text.
   * @param {''|'left'|'right'|'center'} align The column's alignment.
   * @returns {string} The cell element.
   */
  static #tableCellHtml(tag, cellText, align) {
    const style = align ? ` style="text-align:${align}"` : '';
    return `<${tag}${style}>${Markdown.#inlineMarkupHtml(cellText)}</${tag}>`;
  }

  /**
   * HTML of one table data row.
   * @param {string} line The row's raw line.
   * @param {Array<''|'left'|'right'|'center'>} aligns Each column's alignment.
   * @returns {string} The row element.
   */
  static #tableRowHtml(line, aligns) {
    const cells = Markdown.#tableCells(line);
    return `<tr>${cells.map((cell, position) => Markdown.#tableCellHtml('td', cell, aligns[position])).join('')}</tr>`;
  }

  /**
   * Whether a heading starts at a line.
   * @param {string[]} lines The segment's lines.
   * @param {number} index Line to check.
   * @returns {boolean} True when it qualifies.
   */
  static #isHeadingLine(lines, index) {
    return Markdown.#HEADING_LINE.test(lines[index] ?? '');
  }

  /**
   * Reads an ATX heading.
   * @param {string[]} lines The segment's lines.
   * @param {number} index Index of the heading line.
   * @returns {{blockHtml: string, nextIndex: number}} The heading's HTML and the next unread line.
   */
  static #readHeading(lines, index) {
    const [, hashes, content] = Markdown.#HEADING_LINE.exec(lines[index]);
    const level = hashes.length;
    return { blockHtml: `<h${level}>${Markdown.#inlineMarkupHtml(content)}</h${level}>`, nextIndex: index + 1 };
  }

  /**
   * Whether a horizontal rule starts at a line.
   * @param {string[]} lines The segment's lines.
   * @param {number} index Line to check.
   * @returns {boolean} True when it qualifies.
   */
  static #isHrLine(lines, index) {
    return Markdown.#HR_LINE.test(lines[index] ?? '');
  }

  /**
   * Reads a horizontal rule.
   * @param {string[]} lines The segment's lines.
   * @param {number} index Index of the rule line.
   * @returns {{blockHtml: string, nextIndex: number}} The rule's HTML and the next unread line.
   */
  static #readHr(lines, index) {
    return { blockHtml: '<hr>', nextIndex: index + 1 };
  }

  /**
   * Whether a line continues a blockquote.
   * @param {string[]} lines The segment's lines.
   * @param {number} index Line to check.
   * @returns {boolean} True when it qualifies.
   */
  static #isQuoteLine(lines, index) {
    return Markdown.#QUOTE_LINE.test(lines[index] ?? '');
  }

  /**
   * Reads a blockquote: every consecutive quote line, with its marker stripped and rendered
   * recursively, so a table, list or further quote inside it still works.
   * @param {string[]} lines The segment's lines.
   * @param {number} index Index of the first quote line.
   * @returns {{blockHtml: string, nextIndex: number}} The quote's HTML and the next unread line.
   */
  static #readQuote(lines, index) {
    const quoteLines = Markdown.#consecutiveLines(lines, index, Markdown.#isQuoteLine);
    const inner = quoteLines.map(line => Markdown.#QUOTE_LINE.exec(line)[1]).join('\n');
    return { blockHtml: `<blockquote>${Markdown.#textSegmentHtml(inner)}</blockquote>`, nextIndex: index + quoteLines.length };
  }

  /**
   * Whether a list item starts at a line, ordered or unordered.
   * @param {string[]} lines The segment's lines.
   * @param {number} index Line to check.
   * @returns {boolean} True when it qualifies.
   */
  static #isListLine(lines, index) {
    const line = lines[index] ?? '';
    return Markdown.#UNORDERED_ITEM.test(line) || Markdown.#ORDERED_ITEM.test(line);
  }

  /**
   * Reads a list: every consecutive list-item line, nested by indentation - a more indented item
   * starts a new list inside the item above it; a less indented item closes back out to that
   * level; an item at the same indentation but a different marker kind starts a new list there
   * instead of continuing the old one.
   * @param {string[]} lines The segment's lines.
   * @param {number} index Index of the first item.
   * @returns {{blockHtml: string, nextIndex: number}} The list's HTML and the next unread line.
   */
  static #readList(lines, index) {
    const itemLines = Markdown.#consecutiveLines(lines, index, Markdown.#isListLine);
    const items = itemLines.map(Markdown.#parseListItem);
    return { blockHtml: Markdown.#nestedListHtml(items), nextIndex: index + itemLines.length };
  }

  /**
   * Parses one list-item line.
   * @param {string} line The line.
   * @returns {{indent: number, tag: 'ul'|'ol', content: string}} Its nesting depth (leading space
   * count), list kind and text.
   */
  static #parseListItem(line) {
    const orderedMatch = Markdown.#ORDERED_ITEM.exec(line);
    if (orderedMatch) return { indent: orderedMatch[1].length, tag: 'ol', content: orderedMatch[2] };
    const unorderedMatch = Markdown.#UNORDERED_ITEM.exec(line);
    return { indent: unorderedMatch[1].length, tag: 'ul', content: unorderedMatch[2] };
  }

  /**
   * Builds nested <ul>/<ol> HTML from a flat, ordered list of parsed items, using each item's
   * indentation to decide how deep it nests under the items before it.
   * @param {Array<{indent: number, tag: 'ul'|'ol', content: string}>} items The parsed items, in order.
   * @returns {string} The outermost list(s) HTML, concatenated.
   */
  static #nestedListHtml(items) {
    const stack = [];
    const roots = [];
    for (const item of items) Markdown.#placeListItem(stack, roots, item);
    while (stack.length) Markdown.#closeListLevel(stack, roots);
    return roots.join('');
  }

  /**
   * Places one item into the open stack of list levels: closes levels that this item dedents past
   * or replaces (same indentation, different marker kind), opens a new nested level when this item
   * is more indented than the current one, then adds the item to whichever level is now open.
   * @param {Array<{indent: number, tag: string, items: string[]}>} stack Open levels, outermost first; mutated in place.
   * @param {string[]} roots Finished top-level lists' HTML; mutated in place.
   * @param {{indent: number, tag: 'ul'|'ol', content: string}} item The item to place.
   * @returns {void}
   */
  static #placeListItem(stack, roots, item) {
    while (stack.length && Markdown.#dedentsPast(stack.at(-1), item)) Markdown.#closeListLevel(stack, roots);
    if (Markdown.#needsNewLevel(stack, item)) stack.push({ indent: item.indent, tag: item.tag, items: [] });
    stack.at(-1).items.push(Markdown.#inlineMarkupHtml(item.content));
  }

  /**
   * Whether an item closes an open level: it is less indented than that level, or exactly as
   * indented but of a different marker kind.
   * @param {{indent: number, tag: string}} level An open level.
   * @param {{indent: number, tag: string}} item The incoming item.
   * @returns {boolean} True when the level should close before placing the item.
   */
  static #dedentsPast(level, item) {
    return level.indent > item.indent || (level.indent === item.indent && level.tag !== item.tag);
  }

  /**
   * Whether an item needs a new, more nested level rather than joining the current one.
   * @param {Array<{indent: number}>} stack Open levels, outermost first.
   * @param {{indent: number}} item The incoming item.
   * @returns {boolean} True when nothing is open yet, or the current level is less indented.
   */
  static #needsNewLevel(stack, item) {
    return !stack.length || stack.at(-1).indent < item.indent;
  }

  /**
   * Closes the innermost open list level: turns its items into a <ul>/<ol>, then either nests that
   * inside the parent level's last item or, with no parent, adds it as a finished top-level list.
   * @param {Array<{tag: string, items: string[]}>} stack Open levels; mutated in place (the top is removed).
   * @param {string[]} roots Finished top-level lists' HTML; mutated in place.
   * @returns {void}
   */
  static #closeListLevel(stack, roots) {
    const level = stack.pop();
    const listHtml = `<${level.tag}>${level.items.map(inner => `<li>${inner}</li>`).join('')}</${level.tag}>`;
    const parent = stack.at(-1);
    if (parent) parent.items[parent.items.length - 1] += listHtml;
    else roots.push(listHtml);
  }

  /**
   * Renders inline markup of escaped plain text.
   * @param {string} text Plain text.
   * @returns {string} The HTML.
   */
  static #inlineMarkupHtml(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
}
