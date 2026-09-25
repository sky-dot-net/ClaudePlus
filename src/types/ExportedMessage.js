/**
 * One exported message.
 * @typedef {object} ExportedMessage
 * @property {string} id Message id.
 * @property {?string} parentId Parent message id, or null.
 * @property {string} sender 'human' or 'assistant'.
 * @property {?string} createdAt ISO creation timestamp, or null when unknown.
 * @property {string[]} attachments Names of the uploaded files.
 * @property {ExportedBlock[]} blocks Content, in order.
 */

export {};
