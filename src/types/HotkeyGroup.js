/**
 * Hotkey commands that belong together and share a tab in the settings: the app's own, or one vendor's.
 * @typedef {object} HotkeyGroup
 * @property {string} id Group id; "app" or a vendor id such as "anthropic".
 * @property {string} label Name shown in the settings.
 * @property {ReadonlyArray<{id: string, label: string, defaultChord: string}>} commands The group's commands.
 */

export {};
