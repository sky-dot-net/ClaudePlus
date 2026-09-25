/**
 * Hides claude.ai's two top-level mount points, the only change made to the native app; nothing
 * inside them is ever queried or touched. Applied only once the UI has mounted successfully.
 * @type {string}
 */
export const NATIVE_APP_HIDING_STYLES = '#root, #portal-root { display: none !important; }';
