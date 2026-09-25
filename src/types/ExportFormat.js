/**
 * A file format a conversation can be exported to.
 * @typedef {object} ExportFormat
 * @property {string} label Name shown in the export menu.
 * @property {string} extension File extension without the dot.
 * @property {string} mimeType MIME type of the file.
 * @property {function(ExportedConversation): string} serialize Converts a conversation to the file content.
 */

export {};
