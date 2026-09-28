/**
 * Key combinations as text, "Mod+Alt+Shift+Key": Mod stands for Ctrl, or Cmd on a Mac, so one
 * chord means the same on every platform.
 */
export class HotkeyChord {
  /**
   * Keys that are only modifiers and so never end a chord.
   * @type {ReadonlySet<string>}
   */
  static #MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);

  /**
   * The chord a key press makes.
   * @param {KeyboardEvent} event The key press.
   * @returns {?string} The chord, or null while only modifiers are held.
   */
  static fromEvent(event) {
    if (HotkeyChord.#MODIFIER_KEYS.has(event.key)) return null;
    const held = [['Mod', event.ctrlKey || event.metaKey], ['Alt', event.altKey], ['Shift', event.shiftKey]];
    return [...held.filter(([, isHeld]) => isHeld).map(([name]) => name), HotkeyChord.#keyName(event)].join('+');
  }

  /**
   * A chord as the user reads it.
   * @param {string} chord The chord; empty for none.
   * @returns {string} Its text, with Mod as Ctrl or Cmd; "Not set" for none.
   */
  static format(chord) {
    if (!chord) return 'Not set';
    return chord.replace('Mod', /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl');
  }

  /**
   * The name of the key of a key press, taken from its position for letters and digits so the
   * chord does not change with the keyboard layout or Shift.
   * @param {KeyboardEvent} event The key press.
   * @returns {string} The name.
   */
  static #keyName(event) {
    const positional = /^(?:Key|Digit)(.)$/.exec(event.code);
    if (positional) return positional[1];
    if (event.key === ' ') return 'Space';
    return event.key.length === 1 ? event.key.toUpperCase() : event.key;
  }
}
