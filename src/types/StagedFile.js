/**
 * A file pasted or dropped into the composer, waiting to be attached to the next prompt.
 * @typedef {object} StagedFile
 * @property {string} key Random key identifying the entry while its upload is in flight.
 * @property {string} name File name.
 * @property {boolean} isUploading Whether the upload is still in flight.
 * @property {?UploadedFile} upload The server's record of the upload, once finished.
 */

export {};
