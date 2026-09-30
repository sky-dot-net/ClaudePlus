import { StyleRegistry } from '../styles/StyleRegistry.js';
import { escapeHtml } from './escapeHtml.js';
import stylesheet from './Markdown.css';

StyleRegistry.register(stylesheet);

/**
 * Minimal markdown renderer: fenced code blocks, GFM tables, and inline code, bold, italic and
 * http(s) links elsewhere. All other text is HTML-escaped; every original newline outside a table
 * becomes a line break, matching how Claude's own replies are spaced.
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
   * Renders a plain-text segment: a GFM table wherever one starts, and every other line rendered
   * the old way - inline markup with each newline kept as a line break.
   * @param {string} text Plain text segment (no code fences).
   * @returns {string} The HTML.
   */
  static #textSegmentHtml(text) {
    const lines = text.split('\n');
    const parts = [];
    let plainLines = [];
    for (let index = 0; index < lines.length; ) {
      if (!Markdown.#isTableStart(lines, index)) {
        plainLines.push(lines[index]);
        index += 1;
        continue;
      }
      parts.push(Markdown.#flushPlainRun(plainLines));
      plainLines = [];
      const table = Markdown.#readTable(lines, index);
      parts.push(table.tableHtml);
      index = table.nextIndex;
    }
    parts.push(Markdown.#flushPlainRun(plainLines));
    return parts.join('');
  }

  /**
   * Renders the lines collected outside any table, the way this renderer always has: inline markup
   * with each original line joined by a line break.
   * @param {string[]} plainLines Lines outside any table, in order.
   * @returns {string} The HTML; empty when there are no lines.
   */
  static #flushPlainRun(plainLines) {
    return plainLines.length ? Markdown.#inlineMarkupHtml(plainLines.join('\n')).replace(/\n/g, '<br>') : '';
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
   * @returns {{tableHtml: string, nextIndex: number}} The table's HTML and the index of the next unread line.
   */
  static #readTable(lines, index) {
    const headerCells = Markdown.#tableCells(lines[index]);
    const aligns = Markdown.#tableCells(lines[index + 1]).map(Markdown.#columnAlign);
    const bodyLines = Markdown.#tableBodyLines(lines, index + 2);
    const headHtml = `<thead><tr>${headerCells.map((cell, position) => Markdown.#tableCellHtml('th', cell, aligns[position])).join('')}</tr></thead>`;
    const bodyHtml = `<tbody>${bodyLines.map(line => Markdown.#tableRowHtml(line, aligns)).join('')}</tbody>`;
    const tableHtml = `<div class="claude-plus-md-table-scroll"><table class="claude-plus-md-table">${headHtml}${bodyHtml}</table></div>`;
    return { tableHtml, nextIndex: index + 2 + bodyLines.length };
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
