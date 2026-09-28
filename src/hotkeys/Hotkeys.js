import { EventEmitter } from '../core/EventEmitter.js';
import { HotkeyChord } from './HotkeyChord.js';
import { STORAGE_KEYS } from '../config/STORAGE_KEYS.js';

/**
 * The hotkey bindings: every command of every group (the app's own and each vendor's) with its
 * default chord, and the user's overrides, which are stored. An override can be an empty chord,
 * meaning the command has none.
 * @fires Hotkeys#changed A binding changed.
 */
export class Hotkeys extends EventEmitter {
  /**
   * Storage of the overrides.
   * @type {Preferences}
   */
  #preferences;

  /**
   * The command groups.
   * @type {HotkeyGroup[]}
   */
  #groups;

  /**
   * The user's chord per command id; an empty string means unassigned.
   * @type {Object<string, string>}
   */
  #overrides;

  /**
   * Whether a settings control is recording the next key press, so no command must run for it.
   * @type {boolean}
   */
  #isRecording = false;

  /**
   * Creates the bindings.
   * @param {Preferences} preferences Storage of the overrides.
   * @param {HotkeyGroup[]} groups The command groups.
   */
  constructor(preferences, groups) {
    super();
    this.#preferences = preferences;
    this.#groups = groups;
    this.#overrides = preferences.readJson(STORAGE_KEYS.hotkeys) ?? {};
  }

  /**
   * The command groups, in settings order.
   * @returns {HotkeyGroup[]} The groups.
   */
  get groups() {
    return this.#groups;
  }

  /**
   * Whether a settings control is recording the next key press.
   * @returns {boolean} True while recording.
   */
  get isRecording() {
    return this.#isRecording;
  }

  /**
   * Starts or ends recording, during which no command runs.
   * @param {boolean} isRecording Whether a control is recording.
   * @returns {void}
   */
  setRecording(isRecording) {
    this.#isRecording = isRecording;
  }

  /**
   * A command's current chord.
   * @param {string} commandId Command id.
   * @returns {string} The override if there is one, else the default; empty for none.
   */
  chordOf(commandId) {
    return commandId in this.#overrides ? this.#overrides[commandId] : (this.#find(commandId)?.defaultChord ?? '');
  }

  /**
   * Whether a command's chord differs from its default.
   * @param {string} commandId Command id.
   * @returns {boolean} True when the user changed it.
   */
  isCustomized(commandId) {
    return commandId in this.#overrides;
  }

  /**
   * The command a key press triggers.
   * @param {KeyboardEvent} event The key press.
   * @returns {?string} The command id, or null when no command has that chord.
   */
  commandIdFor(event) {
    const chord = HotkeyChord.fromEvent(event);
    return chord ? (this.#commands().find(command => this.chordOf(command.id) === chord)?.id ?? null) : null;
  }

  /**
   * Binds a chord to a command, unless another command already has it.
   * @param {string} commandId Command id.
   * @param {string} chord The chord; empty to leave the command without one.
   * @returns {?{id: string, label: string}} The command that already has the chord, when the change was refused.
   */
  setChord(commandId, chord) {
    const conflict = chord ? this.#conflictOf(commandId, chord) : null;
    if (conflict) return conflict;
    this.#store({ ...this.#overrides, [commandId]: chord });
    return null;
  }

  /**
   * Returns a command to its default chord.
   * @param {string} commandId Command id.
   * @returns {?{id: string, label: string}} The command that already has the default chord, when the reset was refused.
   */
  reset(commandId) {
    const defaultChord = this.#find(commandId)?.defaultChord ?? '';
    const conflict = defaultChord ? this.#conflictOf(commandId, defaultChord) : null;
    if (conflict) return conflict;
    const remaining = { ...this.#overrides };
    delete remaining[commandId];
    this.#store(remaining);
    return null;
  }

  /**
   * Another command that has a chord.
   * @param {string} commandId The command that wants the chord.
   * @param {string} chord The chord.
   * @returns {?{id: string, label: string}} The other command, or undefined when the chord is free.
   */
  #conflictOf(commandId, chord) {
    return this.#commands().find(command => command.id !== commandId && this.chordOf(command.id) === chord);
  }

  /**
   * Every command of every group.
   * @returns {Array<{id: string, label: string, defaultChord: string}>} The commands.
   */
  #commands() {
    return this.#groups.flatMap(group => [...group.commands]);
  }

  /**
   * A command by id.
   * @param {string} commandId Command id.
   * @returns {?{id: string, label: string, defaultChord: string}} The command, or undefined when none has that id.
   */
  #find(commandId) {
    return this.#commands().find(command => command.id === commandId);
  }

  /**
   * Keeps new overrides and announces the change.
   * @param {Object<string, string>} overrides The overrides.
   * @returns {void}
   */
  #store(overrides) {
    this.#overrides = overrides;
    this.#preferences.writeJson(STORAGE_KEYS.hotkeys, overrides);
    this.publish('changed');
  }
}
