/**
 * The hotkey commands of the app itself, in the order the settings list them. A command's chord is
 * written "Mod+Alt+Shift+Key": Mod is Ctrl, or Cmd on a Mac. The user can rebind each one in the
 * settings; defaultChord applies until they do. Commands of one vendor live with that vendor.
 * @type {ReadonlyArray<Readonly<{id: string, label: string, defaultChord: string}>>}
 */
export const HOTKEY_COMMANDS = Object.freeze([
  Object.freeze({ id: 'findInChat', label: 'Find in the active chat', defaultChord: 'Mod+F' }),
  Object.freeze({ id: 'globalSearch', label: 'Open the global search', defaultChord: 'Mod+Shift+F' }),
  Object.freeze({ id: 'focusChatList', label: 'Search the chat list', defaultChord: 'Mod+K' }),
]);
