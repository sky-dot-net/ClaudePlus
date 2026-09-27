/**
 * One memory file from a data export's memories category.
 * @typedef {object} ImportedMemoryFileRecord
 * @property {string} accountId Account the memory belongs to; part of the store's compound key.
 * @property {string} path Virtual file path (e.g. "/profile.md"); part of the store's compound key.
 * @property {string} content Markdown file content, including frontmatter.
 * @property {string} updatedAt ISO timestamp the export gave for this file.
 */

export {};
