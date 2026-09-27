/**
 * One Artifact's stored content from a data export's frames category.
 * @typedef {object} ImportedArtifactRecord
 * @property {string} artifactId Artifact id; the store's key.
 * @property {string} title Artifact title.
 * @property {string} activeVersionId Id of the version whose html is stored.
 * @property {string} html Rendered HTML of the active version.
 * @property {string[]} knownVersionIds Ids of every version seen across all imports, so a later
 * import only overwrites html when it brings a version not already known.
 */

export {};
