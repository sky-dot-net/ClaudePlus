import { HotkeyChord } from '../../hotkeys/HotkeyChord.js';
import { emptyStateHtml } from '../html/emptyStateHtml.js';
import { escapeHtml } from '../../text/escapeHtml.js';

/**
 * The list of one hotkey group's commands in the settings: each with its chord, a button that
 * records a new chord from the next key press (Escape cancels, Backspace or Delete clears it),
 * and a button returning it to its default. A chord another command has is refused with a message.
 */
export class HotkeyEditor {
  /**
   * The bindings.
   * @type {Hotkeys}
   */
  #hotkeys;

  /**
   * The group's commands.
   * @type {HotkeyGroup}
   */
  #group;

  /**
   * Element the list is built into.
   * @type {HTMLElement}
   */
  #container;

  /**
   * Id of the command whose chord is being recorded, or null.
   * @type {?string}
   */
  #recordingId = null;

  /**
   * Text explaining why the last change was refused, or an empty string.
   * @type {string}
   */
  #message = '';

  /**
   * Builds the list and follows the bindings.
   * @param {object} parts What the editor works with.
   * @param {HTMLElement} parts.container Element the list is built into.
   * @param {Hotkeys} parts.hotkeys The bindings.
   * @param {HotkeyGroup} parts.group The group whose commands are listed.
   */
  constructor({ container, hotkeys, group }) {
    this.#container = container;
    this.#hotkeys = hotkeys;
    this.#group = group;
    container.addEventListener('click', event => this.#onClick(event));
    this.render();
  }

  /**
   * Shows every command with its chord.
   * @returns {void}
   */
  render() {
    const rows = this.#group.commands.map(command => this.#rowHtml(command)).join('');
    const list = rows || emptyStateHtml(`No ${this.#group.label} hotkeys yet.`);
    this.#container.innerHTML = `${list}<div class="claude-plus-settings-dialog__hotkey-message">${escapeHtml(this.#message)}</div>`;
  }

  /**
   * Stops recording, if a chord is being recorded.
   * @returns {void}
   */
  stopRecording() {
    window.removeEventListener('keydown', this.#onRecordedKey, true);
    this.#hotkeys.setRecording(false);
    this.#recordingId = null;
  }

  /**
   * HTML of one command's row.
   * @param {{id: string, label: string}} command The command.
   * @returns {string} The row.
   */
  #rowHtml(command) {
    const isRecording = this.#recordingId === command.id;
    const chordText = isRecording ? 'Press keys… (Esc cancels, Backspace clears)' : HotkeyChord.format(this.#hotkeys.chordOf(command.id));
    const resetButton = this.#hotkeys.isCustomized(command.id) ? '<button class="claude-plus-toolbar__button" data-action="reset">Reset</button>' : '';
    return `<div class="claude-plus-settings-dialog__layout-row" data-command-id="${escapeHtml(command.id)}">
      <span class="claude-plus-settings-dialog__layout-name">${escapeHtml(command.label)}</span>
      <button class="claude-plus-toolbar__button" data-action="record">${escapeHtml(chordText)}</button>
      ${resetButton}
    </div>`;
  }

  /**
   * Starts recording for, or resets, the command of the clicked row.
   * @param {MouseEvent} event The click in the list.
   * @returns {void}
   */
  #onClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const commandId = button.closest('[data-command-id]').dataset.commandId;
    this.stopRecording();
    if (button.dataset.action === 'record') this.#startRecording(commandId);
    else this.#report(this.#hotkeys.reset(commandId));
    this.render();
  }

  /**
   * Records the next key press as the command's chord.
   * @param {string} commandId The command.
   * @returns {void}
   */
  #startRecording(commandId) {
    this.#recordingId = commandId;
    this.#message = '';
    this.#hotkeys.setRecording(true);
    window.addEventListener('keydown', this.#onRecordedKey, true);
  }

  /**
   * Takes the key press as the chord being recorded: Escape cancels, Backspace and Delete leave the
   * command without a chord, a lone modifier key waits for the rest of the chord.
   * @param {KeyboardEvent} event The key press.
   * @returns {void}
   */
  #onRecordedKey = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const chord = HotkeyChord.fromEvent(event);
    if (chord === null) return;
    const commandId = this.#recordingId;
    this.stopRecording();
    if (chord !== 'Escape') this.#report(this.#hotkeys.setChord(commandId, ['Backspace', 'Delete'].includes(chord) ? '' : chord));
    this.render();
  };

  /**
   * Remembers why a change was refused, for the message under the list.
   * @param {?{label: string}} conflict The command that already has the chord, or null when the change was made.
   * @returns {void}
   */
  #report(conflict) {
    this.#message = conflict ? `That key combination is already used by "${conflict.label}".` : '';
  }
}
