import { escapeHtml } from '../../text/escapeHtml.js';

/**
 * HTML for the options of a select element.
 * @param {ReadonlyArray<ChoiceOption>} options The options.
 * @param {string} selectedId Value of the option to preselect.
 * @returns {string} The option elements.
 */
export function optionsHtml(options, selectedId) {
  return options.map(option => `<option value="${escapeHtml(option.id)}"${option.id === selectedId ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
}
