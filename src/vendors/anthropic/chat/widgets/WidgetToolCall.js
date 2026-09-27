import { WIDGET_TOOL_NAMES } from '../../config/WIDGET_TOOL_NAMES.js';

/**
 * Whether a widget tool call actually has a card to show: a known widget tool name with a
 * completed, non-error result, or an Artifact call whose real HTML was resolved at import time
 * (see ClaudeExportMapper). A call without a card to show (still streaming, a failed attempt
 * superseded by a later retry, or an Artifact with nothing resolved for it) is treated as an
 * ordinary tool call instead, so it doesn't leave an empty or duplicate slot in the chat log.
 */
export class WidgetToolCall {
  /**
   * Whether a tool call rendered a widget or Artifact card.
   * @param {ContentBlock} useBlock The tool_use block.
   * @param {?ContentBlock} resultBlock Its tool_result block, if the call has completed.
   * @returns {boolean} True when it has a card to show.
   */
  static isRendered(useBlock, resultBlock) {
    return WidgetToolCall.#isKnownWidget(useBlock, resultBlock) || WidgetToolCall.#isResolvedArtifact(useBlock, resultBlock);
  }

  /**
   * Whether a tool call is a known widget tool with a completed, non-error result.
   * @param {ContentBlock} useBlock The tool_use block.
   * @param {?ContentBlock} resultBlock Its tool_result block, if the call has completed.
   * @returns {boolean} True when it's a widget tool with a successful result.
   */
  static #isKnownWidget(useBlock, resultBlock) {
    return WIDGET_TOOL_NAMES.includes(useBlock.name) && Boolean(resultBlock) && !resultBlock.is_error;
  }

  /**
   * Whether a tool call is an Artifact publish whose real HTML was resolved at import time.
   * @param {ContentBlock} useBlock The tool_use block.
   * @param {?ContentBlock} resultBlock Its tool_result block, if the call has completed.
   * @returns {boolean} True when it's an Artifact call with resolved HTML to show.
   */
  static #isResolvedArtifact(useBlock, resultBlock) {
    return useBlock.name === 'Artifact' && Boolean(resultBlock?.structured_content?.resolvedArtifactHtml);
  }
}
