/**
 * The key colors themeable in the Settings screen; every other color derives from the app's
 * built-in stylesheet. Each default is a plain hex color, so it can seed a native color input.
 * @type {ReadonlyArray<{key: string, cssVar: string, label: string, default: string}>}
 */
export const THEME_COLOR_FIELDS = Object.freeze([
  { key: 'background', cssVar: '--claude-plus-color-background', label: 'Background', default: '#1a1918' },
  { key: 'raised', cssVar: '--claude-plus-color-raised', label: 'Panels', default: '#262523' },
  { key: 'text', cssVar: '--claude-plus-color-text', label: 'Text', default: '#ececec' },
  { key: 'accent', cssVar: '--claude-plus-color-accent', label: 'Accent', default: '#d97757' },
]);
