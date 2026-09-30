/**
 * Font choices offered in the Settings screen's font pickers, for both the interface and the chat
 * text. "Anthropic Sans" is claude.ai's own interface font - already loaded on the page since
 * ClaudePlus runs inside it - and is the default, so a fresh install already looks like claude.ai
 * rather than a plain system font. Each value is a full CSS font-family list with sane fallbacks.
 * Picking "Custom…" in the dropdown (not listed here) reveals a free-text field instead.
 * @type {ReadonlyArray<{id: string, label: string, value: string, isDefault: boolean}>}
 */
export const FONT_PRESETS = Object.freeze([
  Object.freeze({ id: 'anthropicSans', label: 'Anthropic Sans (claude.ai\'s own)', value: 'anthropic-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', isDefault: true }),
  Object.freeze({ id: 'anthropicSerif', label: 'Anthropic Serif', value: 'anthropic-serif, Georgia, "Times New Roman", serif', isDefault: false }),
  Object.freeze({ id: 'system', label: 'System default', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', isDefault: false }),
  Object.freeze({ id: 'inter', label: 'Inter', value: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', isDefault: false }),
  Object.freeze({ id: 'mono', label: 'Monospace (Anthropic Mono)', value: 'anthropic-mono, "SFMono-Regular", Consolas, monospace', isDefault: false }),
]);
