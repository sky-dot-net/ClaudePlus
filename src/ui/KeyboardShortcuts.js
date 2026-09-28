/**
 * Runs the command a key press triggers. Which key triggers which command comes from the Hotkeys
 * bindings, so the user's changes apply at once. Key presses are handled in the capture phase and
 * stopped there, so claude.ai's own hidden app and the browser never react to a chord bound to a
 * command.
 */
export class KeyboardShortcuts {
  /**
   * The commands.
   * @type {Commands}
   */
  #commands;

  /**
   * Creates the shortcuts.
   * @param {Commands} commands The commands.
   */
  constructor(commands) {
    this.#commands = commands;
  }

  /**
   * Starts listening for the shortcuts.
   * @returns {void}
   */
  install() {
    window.addEventListener('keydown', this.#handleKeydown, true);
  }

  /**
   * Runs the command a key press is bound to, unless a settings control is recording the key press
   * as a new binding.
   * @param {KeyboardEvent} event The key press.
   * @returns {void}
   */
  #handleKeydown = (event) => {
    if (this.#commands.hotkeys.isRecording || event.repeat) return;
    const commandId = this.#commands.idFor(event);
    if (!commandId) return;
    event.preventDefault();
    event.stopPropagation();
    this.#commands.run(commandId);
  };
}
