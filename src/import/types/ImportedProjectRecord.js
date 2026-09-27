/**
 * One Project stored from a data export's projects category.
 * @typedef {object} ImportedProjectRecord
 * @property {string} projectId Project id; the store's key.
 * @property {string} name Project name.
 * @property {string} description Project description.
 * @property {string} promptTemplate Custom system-instruction text.
 * @property {string} updatedAt ISO timestamp the export gave for the project itself.
 * @property {ImportedProjectDoc[]} docs The project's docs.
 */

/**
 * One doc attached to a Project.
 * @typedef {object} ImportedProjectDoc
 * @property {string} docId Doc id.
 * @property {string} filename Doc filename.
 * @property {string} content Complete original file content.
 * @property {string} createdAt ISO timestamp the export gave for this doc.
 */

export {};
