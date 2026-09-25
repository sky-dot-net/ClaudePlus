/**
 * Wraps content in a markdown code fence longer than any backtick run inside it, so the content
 * can't close the fence early.
 * @param {string} content Code to wrap.
 * @param {string} language Language tag after the opening fence; may be empty.
 * @returns {string} The fenced block.
 */
export function markdownCodeFence(content, language) {
  const longestBacktickRun = Math.max(2, ...(content.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longestBacktickRun + 1);
  return `${fence}${language}\n${content}\n${fence}`;
}
