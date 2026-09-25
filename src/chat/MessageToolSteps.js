import { WidgetToolCall } from './widgets/WidgetToolCall.js';

/**
 * Groups a message's thinking and ordinary tool-call content blocks into a chronological list of
 * steps — each tool call paired with its result — so a message's "thinking and tool calls"
 * sub-pane can list what happened without that ever appearing in the chat log itself. A widget
 * tool call that actually rendered a card (see WidgetToolCall) is excluded here since it shows
 * inline in the message instead (see MessageContent); one that didn't (still pending, or a failed
 * attempt superseded by a retry) is kept, same as any other tool call.
 */
export class MessageToolSteps {
  /**
   * Steps of a message, in the order they happened.
   * @param {?ApiMessage} apiMessage The message; null or content-less for a local-only message.
   * @returns {Array<{kind: 'thinking', block: ContentBlock}|{kind: 'tool', useBlock: ContentBlock, resultBlock: ?ContentBlock}>}
   * The steps; empty when the message has none.
   */
  static stepsOf(apiMessage) {
    const blocks = apiMessage?.content ?? [];
    const resultByUseId = MessageToolSteps.#resultsByUseId(blocks);
    const steps = [];
    const stepByToolUseId = new Map();
    blocks.forEach(block => MessageToolSteps.#addBlock(block, steps, stepByToolUseId, resultByUseId));
    return steps;
  }

  /**
   * Tool results by the id of the call they answer.
   * @param {ContentBlock[]} blocks The message's content blocks.
   * @returns {Map<string, ContentBlock>} The results, by tool_use_id.
   */
  static #resultsByUseId(blocks) {
    return new Map(blocks.filter(block => block.type === 'tool_result').map(block => [block.tool_use_id, block]));
  }

  /**
   * Folds one content block into the steps being built.
   * @param {ContentBlock} block The block.
   * @param {Array<object>} steps Steps accumulated so far.
   * @param {Map<string, object>} stepByToolUseId Tool steps by their call's id, to attach a matching result.
   * @param {Map<string, ContentBlock>} resultByUseId Tool results by the id of the call they answer.
   * @returns {void}
   */
  static #addBlock(block, steps, stepByToolUseId, resultByUseId) {
    if (block.type === 'thinking') steps.push({ kind: 'thinking', block });
    else if (block.type === 'tool_use' && !WidgetToolCall.isRendered(block, resultByUseId.get(block.id))) MessageToolSteps.#addToolUse(block, steps, stepByToolUseId);
    else if (block.type === 'tool_result') MessageToolSteps.#attachResult(block, stepByToolUseId);
  }

  /**
   * Starts a tool step from its call.
   * @param {ContentBlock} block A tool_use block.
   * @param {Array<object>} steps Steps accumulated so far.
   * @param {Map<string, object>} stepByToolUseId Tool steps by their call's id.
   * @returns {void}
   */
  static #addToolUse(block, steps, stepByToolUseId) {
    const step = { kind: 'tool', useBlock: block, resultBlock: null };
    steps.push(step);
    stepByToolUseId.set(block.id, step);
  }

  /**
   * Attaches a result to its matching tool step.
   * @param {ContentBlock} block A tool_result block.
   * @param {Map<string, object>} stepByToolUseId Tool steps by their call's id.
   * @returns {void}
   */
  static #attachResult(block, stepByToolUseId) {
    const step = stepByToolUseId.get(block.tool_use_id);
    if (step) step.resultBlock = block;
  }
}
