/**
 * A content block of an API message.
 * @typedef {object} ContentBlock
 * @property {string} type 'text', 'tool_use', 'tool_result' or another type that is ignored.
 * @property {string} [text] Text of a 'text' block.
 * @property {string} [name] Tool name of a 'tool_use' block.
 * @property {object} [input] Tool input of a 'tool_use' block.
 * @property {Array<object>} [content] Result items of a 'tool_result' block.
 * @property {string} [stop_timestamp] ISO timestamp the block completed.
 */

export {};
