/**
 * A content block of an API message.
 * @typedef {object} ContentBlock
 * @property {string} type 'text', 'tool_use', 'tool_result', 'thinking' or another type that is ignored.
 * @property {string} [text] Text of a 'text' block.
 * @property {string} [id] Tool call id of a 'tool_use' block, matched by a 'tool_result' block's tool_use_id.
 * @property {string} [name] Tool name of a 'tool_use' block.
 * @property {object} [input] Tool input of a 'tool_use' block.
 * @property {string} [tool_use_id] Id of the 'tool_use' block a 'tool_result' block answers.
 * @property {Array<object>} [content] Result items of a 'tool_result' block.
 * @property {boolean} [is_error] Whether a 'tool_result' block reports a failure.
 * @property {string} [thinking] Raw reasoning text of a 'thinking' block; empty when thinking_hidden is true.
 * @property {Array<{summary: string}>} [summaries] Short natural-language summaries of a 'thinking' block's steps.
 * @property {boolean} [thinking_hidden] Whether a 'thinking' block's raw text was withheld by the server.
 * @property {string} [stop_timestamp] ISO timestamp the block completed.
 */

export {};
