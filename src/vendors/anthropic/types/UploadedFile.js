/**
 * The server's record of a file uploaded with ClaudeApi#uploadFile, also the shape a persisted
 * message's files carry. file_kind is 'image' for an image (with thumbnail_url/preview_url set) or
 * 'blob' for anything else.
 * @typedef {object} UploadedFile
 * @property {string} file_uuid Id to send back in a completion request's files array.
 * @property {string} file_name Original file name.
 * @property {'image'|'blob'|string} file_kind Kind of upload.
 * @property {string} [thumbnail_url] Small preview URL, images only.
 * @property {string} [preview_url] Display-size preview URL, images only.
 */

export {};
