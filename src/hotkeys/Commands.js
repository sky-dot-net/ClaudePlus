import { HotkeyChord } from './HotkeyChord.js';

/**
 * The commands of the app: each has an id, a label and a chord (see Hotkeys) and runs an action
 * registered for its id. A key press and a button marked with the command's id both run it, so a
 * button gets its hotkey - and a tooltip naming it - without any code of its own.
 */
export class Commands {
  /**
   * The bindings.
   * @type {Hotkeys}
   */
  #hotkeys;

  /**
   * Action per command id.
   * @type {Map<string, function(): void>}
   */
  #actions = new Map();

  /**
   * Creates the commands.
   * @param {Hotkeys} hotkeys The bindings.
   */
  constructor(hotkeys) {
    this.#hotkeys = hotkeys;
  }

  /**
   * The bindings, for following their changes.
   * @returns {Hotkeys} The bindings.
   */
  get hotkeys() {
    return this.#hotkeys;
  }

  /**
   * Registers the actions of commands; a command's action is set once the objects it works with exist.
   * @param {Map<string, function(): void>} actions Action per command id.
   * @returns {void}
   */
  addActions(actions) {
    actions.forEach((action, commandId) => this.#actions.set(commandId, action));
  }

  /**
   * The id of the command a key press triggers.
   * @param {KeyboardEvent} event The key press.
   * @returns {?string} The id, or null when the key press triggers no command that has an action.
   */
  idFor(event) {
    const commandId = this.#hotkeys.commandIdFor(event);
    return commandId && this.#actions.has(commandId) ? commandId : null;
  }

  /**
   * Runs a command's action.
   * @param {string} commandId Command id.
   * @returns {void}
   */
  run(commandId) {
    this.#actions.get(commandId)?.();
  }

  /**
   * The text a button of a command shows as its tooltip.
   * @param {string} commandId Command id.
   * @returns {string} The command's label and, when it has one, its current chord.
   */
  tooltipOf(commandId) {
    const label = this.#hotkeys.labelOf(commandId);
    const chord = this.#hotkeys.chordOf(commandId);
    return chord ? `${label} (${HotkeyChord.format(chord)})` : label;
  }
}
