/**
 * Estimates a token count from text length, at four characters per token. claude.ai doesn't
 * expose real token counts.
 * @param {?string} text The text.
 * @returns {number} Estimated tokens; 0 for empty text.
 */
export function estimateTokens(text) {
  return text ? Math.ceil(text.length / 4) : 0;
}
