import { LIMITS } from '../../config/LIMITS.js';
import { MessageToolSteps } from '../../chat/MessageToolSteps.js';
import { StyleRegistry } from '../../styles/StyleRegistry.js';
import { SubPaneHeader } from './SubPaneHeader.js';
import { createElement } from '../../dom/createElement.js';
import { escapeHtml } from '../../text/escapeHtml.js';
import stylesheet from './MessageToolStepsPane.css';

StyleRegistry.register(stylesheet);

/**
 * A sub-pane showing one message's thinking and tool-call steps, chronologically, each collapsed
 * until expanded. It can be docked to the pane's left, top or right edge and closed. Clicking a
 * different message's lightbulb button swaps its content via showMessage rather than opening
 * another instance.
 */
export class MessageToolStepsPane {
  /**
   * The sub-pane's root element.
   * @type {HTMLElement}
   */
  #element;

  /**
   * Message whose steps are shown.
   * @type {ChatMessage}
   */
  #message;

  /**
   * Builds the sub-pane for a message.
   * @param {object} options Sub-pane options.
   * @param {ChatMessage} options.message Message whose steps to show.
   * @param {function(): void} options.onClose Called when × is clicked.
   * @param {function(string): void} options.onMove Called with 'left', 'top' or 'right' when an arrow is clicked.
   */
  constructor({ message, onClose, onMove }) {
    this.#message = message;
    this.#element = createElement('section', { className: 'claude-plus-subpane' });
    this.#element.addEventListener('click', event => this.#onClick(event, onClose, onMove));
    this.render();
  }

  /**
   * The sub-pane's root element.
   * @returns {HTMLElement} The element.
   */
  get element() {
    return this.#element;
  }

  /**
   * Id of the message currently shown.
   * @returns {string} The message id.
   */
  get messageId() {
    return this.#message.id;
  }

  /**
   * Shows another message's steps instead, without recreating the sub-pane.
   * @param {ChatMessage} message The message to show.
   * @returns {void}
   */
  showMessage(message) {
    this.#message = message;
    this.render();
  }

  /**
   * Renders the header and the message's steps.
   * @returns {void}
   */
  render() {
    const steps = MessageToolSteps.stepsOf(this.#message.apiMessage);
    const stepsHtml = steps.map(step => MessageToolStepsPane.#stepHtml(step)).join('')
      || '<div class="claude-plus-empty-state">This message has no recorded steps.</div>';
    this.#element.innerHTML = `${SubPaneHeader.html('💡 Thinking & tool calls')}<div class="claude-plus-scrollable claude-plus-fill-remaining claude-plus-tool-steps">${stepsHtml}</div>`;
  }

  /**
   * Removes the sub-pane.
   * @returns {void}
   */
  dispose() {
    this.#element.remove();
  }

  /**
   * Runs a header click; other clicks are ignored.
   * @param {MouseEvent} event Click inside the sub-pane.
   * @param {function(): void} onClose Close callback.
   * @param {function(string): void} onMove Redock callback.
   * @returns {void}
   */
  #onClick(event, onClose, onMove) {
    if (event.target.closest('header')) SubPaneHeader.onClick(event, onClose, onMove);
  }

  /**
   * HTML of one step: a thinking pass or a tool call.
   * @param {{kind: string}} step The step.
   * @returns {string} The HTML.
   */
  static #stepHtml(step) {
    return step.kind === 'thinking' ? MessageToolStepsPane.#thinkingStepHtml(step) : MessageToolStepsPane.#toolStepHtml(step);
  }

  /**
   * HTML of a thinking step: its summaries as the always-visible line, its raw text (if kept) when expanded.
   * @param {{block: ContentBlock}} step The thinking step.
   * @returns {string} The HTML.
   */
  static #thinkingStepHtml({ block }) {
    const summaries = (block.summaries ?? []).map(entry => entry.summary).filter(Boolean);
    const headline = escapeHtml(summaries[0] ?? 'Thinking');
    const restHtml = summaries.length > 1 ? `<ul class="claude-plus-tool-step__summaries">${summaries.slice(1).map(summary => `<li>${escapeHtml(summary)}</li>`).join('')}</ul>` : '';
    const rawHtml = block.thinking ? `<pre class="claude-plus-tool-step__pre">${escapeHtml(block.thinking)}</pre>` : '';
    return `
      <details class="claude-plus-tool-step">
        <summary>💭 ${headline}</summary>
        ${restHtml}${rawHtml}
      </details>`;
  }

  /**
   * HTML of a tool step: its name or description as the always-visible line, its input and result when expanded.
   * @param {{useBlock: ContentBlock, resultBlock: ?ContentBlock}} step The tool step.
   * @returns {string} The HTML.
   */
  static #toolStepHtml({ useBlock, resultBlock }) {
    const isError = MessageToolStepsPane.#isErrorResult(resultBlock);
    const icon = isError ? '⚠️' : '🔧';
    const errorClass = isError ? ' claude-plus-tool-step--error' : '';
    const toolName = MessageToolStepsPane.#toolName(useBlock);
    const headline = escapeHtml(MessageToolStepsPane.#toolHeadline(useBlock, toolName));
    const inputHtml = MessageToolStepsPane.#inputFieldsHtml(useBlock.input ?? {});
    const resultHtml = resultBlock ? MessageToolStepsPane.#resultHtml(resultBlock) : '';
    return `
      <details class="claude-plus-tool-step${errorClass}">
        <summary>${icon} ${escapeHtml(toolName)}: ${headline}</summary>
        ${inputHtml}${resultHtml}
      </details>`;
  }

  /**
   * Whether a tool step's result reports a failure.
   * @param {?ContentBlock} resultBlock The tool_result block, if the call has completed.
   * @returns {boolean} True when it has and is flagged as an error.
   */
  static #isErrorResult(resultBlock) {
    return Boolean(resultBlock && resultBlock.is_error);
  }

  /**
   * A tool call's name, falling back to a generic label.
   * @param {ContentBlock} useBlock The tool_use block.
   * @returns {string} The name.
   */
  static #toolName(useBlock) {
    return useBlock.name || 'tool';
  }

  /**
   * A tool call's human-readable summary: its input's description, or its name.
   * @param {ContentBlock} useBlock The tool_use block.
   * @param {string} toolName Its resolved name, for the fallback.
   * @returns {string} The summary.
   */
  static #toolHeadline(useBlock, toolName) {
    const description = useBlock.input && useBlock.input.description;
    return description || toolName;
  }

  /**
   * HTML of a tool call's input fields.
   * @param {object} input The input object.
   * @returns {string} The HTML.
   */
  static #inputFieldsHtml(input) {
    return Object.entries(input).map(([key, value]) => MessageToolStepsPane.#fieldHtml(key, value)).join('');
  }

  /**
   * HTML of one input field: a label, and either an inline value or a preformatted block for a
   * long or multi-line string, so multi-line text keeps its real line breaks instead of the
   * escaped "\n" a whole-object JSON dump would show.
   * @param {string} key Field name.
   * @param {*} value Field value.
   * @returns {string} The HTML.
   */
  static #fieldHtml(key, value) {
    const label = `<div class="claude-plus-tool-step__field-label">${escapeHtml(key)}</div>`;
    if (typeof value === 'string' && MessageToolStepsPane.#isLongText(value)) {
      return `${label}<pre class="claude-plus-tool-step__pre">${escapeHtml(value)}</pre>`;
    }
    const inlineText = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return `${label}<pre class="claude-plus-tool-step__pre">${escapeHtml(inlineText)}</pre>`;
  }

  /**
   * Whether a string is long or multi-line enough to need its own block rather than an inline line.
   * @param {string} text The text.
   * @returns {boolean} True past 80 characters or containing a line break.
   */
  static #isLongText(text) {
    return text.length > 80 || text.includes('\n');
  }

  /**
   * HTML of a tool result: its status, then each result item.
   * @param {ContentBlock} resultBlock The tool_result block.
   * @returns {string} The HTML.
   */
  static #resultHtml(resultBlock) {
    const status = resultBlock.is_error ? '❌ Error' : '✅ Result';
    const items = Array.isArray(resultBlock.content) ? resultBlock.content : [];
    const itemsHtml = items.map(item => MessageToolStepsPane.#resultItemHtml(item)).join('');
    return `<div class="claude-plus-tool-step__result-status">${status}</div>${itemsHtml}`;
  }

  /**
   * HTML renderer per result item type.
   * @type {Map<string, function(object): string>}
   */
  static #RESULT_ITEM_RENDERERS = new Map([
    ['text', item => MessageToolStepsPane.#resultTextHtml(item.text || '')],
    ['local_resource', item => MessageToolStepsPane.#localResourceHtml(item)],
  ]);

  /**
   * HTML of one tool result item: readable text (pretty-printed if it is itself JSON), a file
   * chip for a local resource, or a JSON fallback for anything else.
   * @param {object} item The result item.
   * @returns {string} The HTML.
   */
  static #resultItemHtml(item) {
    const renderItem = MessageToolStepsPane.#RESULT_ITEM_RENDERERS.get(item.type);
    return renderItem ? renderItem(item) : MessageToolStepsPane.#fallbackResultItemHtml(item);
  }

  /**
   * HTML of a local-resource result item, shown as a plain named chip.
   * @param {object} item The result item.
   * @returns {string} The HTML.
   */
  static #localResourceHtml(item) {
    const name = item.name || item.file_path || 'file';
    return `<div class="claude-plus-message-attachment">📎 ${escapeHtml(name)}</div>`;
  }

  /**
   * HTML of a result item of an unrecognized type, as truncated JSON.
   * @param {object} item The result item.
   * @returns {string} The HTML.
   */
  static #fallbackResultItemHtml(item) {
    return `<pre class="claude-plus-tool-step__pre">${escapeHtml(JSON.stringify(item, null, 2).slice(0, LIMITS.toolResultCharacters))}</pre>`;
  }

  /**
   * HTML of a text result item: pretty-printed if it parses as JSON, else the raw text; both keep
   * real line breaks and are capped at LIMITS.toolResultCharacters.
   * @param {string} text The item's text.
   * @returns {string} The HTML.
   */
  static #resultTextHtml(text) {
    const pretty = MessageToolStepsPane.#prettyJsonOrNull(text);
    return `<pre class="claude-plus-tool-step__pre">${escapeHtml((pretty ?? text).slice(0, LIMITS.toolResultCharacters))}</pre>`;
  }

  /**
   * Re-indents a string if it parses as JSON.
   * @param {string} text Candidate JSON text.
   * @returns {?string} The pretty-printed text, or null when it isn't valid JSON.
   */
  static #prettyJsonOrNull(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return null;
    }
  }
}
