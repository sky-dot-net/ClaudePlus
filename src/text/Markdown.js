import { escapeHtml } from './escapeHtml.js';

/**
 * Minimal markdown renderer: fenced code blocks, inline code, bold, italic and http(s) links.
 * All other text is HTML-escaped.
 */
export class Markdown {
  /**
   * A fenced code block, with or without a language line; captures the code.
   * @type {RegExp}
   */
  static #CODE_FENCE = /```(?:[^\n`]*\n)?([\s\S]*?)```/;

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
    return Markdown.#inlineMarkupHtml(Markdown.#trimFenceLineBreaks(segment, index, segmentCount)).replace(/\n/g, '<br>');
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
