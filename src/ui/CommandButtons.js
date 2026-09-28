/**
 * Connects the buttons of a panel that carry a data-command attribute to the commands of that id:
 * a click runs the command, and the tooltip names the command and its current hotkey, updating when
 * the user rebinds it. Any button becomes a hotkey button by getting data-command="<command id>".
 */
export class CommandButtons {
  /**
   * Wires every command button inside an element.
   * @param {Panel} ownerPanel Panel owning the subscription to the bindings.
   * @param {HTMLElement} root Element holding the buttons.
   * @param {Commands} commands The commands.
   * @returns {void}
   */
  static bind(ownerPanel, root, commands) {
    const buttons = [...root.querySelectorAll('[data-command]')];
    const showTooltips = () => buttons.forEach(button => { button.title = commands.tooltipOf(button.dataset.command); });
    buttons.forEach(button => {
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => commands.run(button.dataset.command));
    });
    showTooltips();
    ownerPanel.listenTo(commands.hotkeys, 'changed', showTooltips);
  }
}
