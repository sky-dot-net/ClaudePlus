/**
 * Runs the action of the hotkey command a key press triggers. Which key triggers which command
 * comes from the Hotkeys bindings, so the user's changes apply at once. Key presses are handled in
 * the capture phase and stopped there, so claude.ai's own hidden app and the browser never react to
 * a chord bound to a command.
 */
export class KeyboardShortcuts {
  /**
   * The bindings.
   * @type {Hotkeys}
   */
  #hotkeys;

  /**
   * Action per command id.
   * @type {Map<string, function(): void>}
   */
  #actions;

  /**
   * Creates the shortcuts.
   * @param {Hotkeys} hotkeys The bindings.
   * @param {Map<string, function(): void>} actions Action per command id; a command without one does nothing.
   */
  constructor(hotkeys, actions) {
    this.#hotkeys = hotkeys;
    this.#actions = actions;
  }

  /**
   * Starts listening for the shortcuts.
   * @returns {void}
   */
  install() {
    window.addEventListener('keydown', this.#handleKeydown, true);
  }

  /**
   * Runs the action of the command a key press is bound to, unless a settings control is recording
   * the key press as a new binding.
   * @param {KeyboardEvent} event The key press.
   * @returns {void}
   */
  #handleKeydown = (event) => {
    if (this.#hotkeys.isRecording || event.repeat) return;
    const action = this.#actions.get(this.#hotkeys.commandIdFor(event));
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };
}
