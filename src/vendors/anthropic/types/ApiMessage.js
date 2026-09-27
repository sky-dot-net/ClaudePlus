/**
 * A message as returned by the API.
 * @typedef {object} ApiMessage
 * @property {string} uuid Message id.
 * @property {?string} [parent_message_uuid] Parent in the conversation tree.
 * @property {string} sender 'human' or 'assistant'.
 * @property {string} [text] Plain text, used by older messages.
 * @property {ContentBlock[]} [content] Structured content.
 * @property {Array<object>} [attachments] Uploaded attachments.
 * @property {UploadedFile[]} [files] Uploaded files.
 * @property {string} created_at ISO creation timestamp.
 */

export {};
