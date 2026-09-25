/**
 * One exported content block. Which optional fields are set depends on the type: text has text;
 * toolCall has name and input; toolResult has name and content; other keeps an unrecognised block
 * whole in content, with its API type in originalType.
 * @typedef {object} ExportedBlock
 * @property {'text'|'toolCall'|'toolResult'|'other'} type Block kind.
 * @property {string} [text] Markdown text.
 * @property {?string} [name] Tool name.
 * @property {*} [input] Tool input, unchanged.
 * @property {*} [content] Tool result content or the unrecognised block, unchanged.
 * @property {string} [originalType] API type of an unrecognised block.
 */

export {};
