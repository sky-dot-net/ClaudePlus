import { WIDGET_TOOL_NAMES } from '../../config/WIDGET_TOOL_NAMES.js';

/**
 * Whether a widget tool call actually has a card to show: a known widget tool name with a
 * completed, non-error result. A widget call without one (still streaming, or a failed attempt
 * superseded by a later retry) has nothing to render and is treated as an ordinary tool call
 * instead, so it doesn't leave an empty or duplicate slot in the chat log.
 */
export class WidgetToolCall {
  /**
   * Whether a tool call rendered a widget card.
   * @param {ContentBlock} useBlock The tool_use block.
   * @param {?ContentBlock} resultBlock Its tool_result block, if the call has completed.
   * @returns {boolean} True when it's a widget tool with a successful result.
   */
  static isRendered(useBlock, resultBlock) {
    return WIDGET_TOOL_NAMES.includes(useBlock.name) && Boolean(resultBlock) && !resultBlock.is_error;
  }
}
