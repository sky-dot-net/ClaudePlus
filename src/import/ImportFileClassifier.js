/**
 * Sorts the files a user selected from an extracted data export into their categories, by content
 * shape rather than filename - conversations.json is the only export file with a predictable name;
 * memories/projects/feedback files are named by uuid, and an Artifact's html is named by version id.
 * Classification reads only a small prefix of each file, never the whole thing: conversations.json
 * in a real export can run to hundreds of megabytes, and is kept as a File reference rather than
 * parsed here, so it can be streamed later (see StreamingJsonArrayReader) instead of ever being
 * held whole in memory.
 */
export class ImportFileClassifier {
  /**
   * Bytes read from each file to detect its category.
   * @type {number}
   */
  static #PEEK_BYTES = 16384;

  /**
   * Category detectors tried in turn against a file's leading text; the first match wins. A
   * detector may also require the file to start with an array (`[`), to tell apart, e.g., a
   * conversations export (an array of objects with chat_messages) from something else that
   * happens to mention the same field name.
   * @type {ReadonlyArray<{key: string, requiresArray: boolean, marker: string}>}
   */
  static #DETECTORS = [
    { key: 'conversations', requiresArray: true, marker: '"chat_messages"' },
    { key: 'users', requiresArray: true, marker: '"full_name"' },
    { key: 'memories', requiresArray: false, marker: '"memory_files"' },
    { key: 'feedback', requiresArray: false, marker: '"reflections"' },
    { key: 'loginHistory', requiresArray: false, marker: '"login_events"' },
    { key: 'artifact', requiresArray: false, marker: '"active_version"' },
    { key: 'project', requiresArray: false, marker: '"prompt_template"' },
  ];

  /**
   * Classifies a set of selected files.
   * @param {File[]} files The selected files.
   * @returns {Promise<{conversationsFile: ?File, memoriesJsons: object[], projectsJsons: object[], feedbackJsons: object[], usersJson: ?Array, loginHistoryJson: ?object, artifacts: Array<{artifactJson: object, htmlByVersionId: Map<string, string>}>}>}
   * The classified files, ready for ClaudeExportParser/ClaudeExportMapper/StreamingJsonArrayReader.
   */
  static async classify(files) {
    const htmlByBasename = await ImportFileClassifier.#htmlFilesByBasename(files);
    const buckets = { conversationsFile: null, memoriesJsons: [], projectsJsons: [], feedbackJsons: [], usersJson: null, loginHistoryJson: null, artifactJsons: [] };
    const jsonFiles = files.filter(file => !file.name.endsWith('.html'));
    await Promise.all(jsonFiles.map(file => ImportFileClassifier.#classifyOne(file, buckets)));
    return { ...buckets, artifacts: buckets.artifactJsons.map(artifactJson => ({ artifactJson, htmlByVersionId: htmlByBasename })) };
  }

  /**
   * Every selected .html file's text, by its basename without extension (an Artifact version id).
   * @param {File[]} files The selected files.
   * @returns {Promise<Map<string, string>>} The html, by version id.
   */
  static async #htmlFilesByBasename(files) {
    const htmlFiles = files.filter(file => file.name.endsWith('.html'));
    const entries = await Promise.all(htmlFiles.map(async file => [ImportFileClassifier.#basename(file.name), await file.text()]));
    return new Map(entries);
  }

  /**
   * A filename without its extension.
   * @param {string} filename The filename.
   * @returns {string} The basename.
   */
  static #basename(filename) {
    return filename.replace(/\.[^.]+$/, '');
  }

  /**
   * Detects one file's category from its leading bytes, then files it into the matching bucket - a
   * File reference for conversations.json, the fully parsed content for every other, small category.
   * A file whose category can't be detected is silently ignored.
   * @param {File} file The file.
   * @param {object} buckets Buckets accumulated so far.
   * @returns {Promise<void>} Resolves once classified.
   */
  static async #classifyOne(file, buckets) {
    const prefix = await file.slice(0, ImportFileClassifier.#PEEK_BYTES).text();
    const key = ImportFileClassifier.#detect(prefix);
    if (!key) return;
    if (key === 'conversations') { buckets.conversationsFile = file; return; }
    const json = await ImportFileClassifier.#parseOrNull(file);
    if (json !== null) ImportFileClassifier.#BUCKET_ASSIGNERS[key](buckets, json);
  }

  /**
   * Category a file's leading text matches, if any.
   * @param {string} prefix The file's leading text.
   * @returns {?string} The detector key, or null when none matches.
   */
  static #detect(prefix) {
    const startsWithArray = prefix.trimStart().startsWith('[');
    const detector = ImportFileClassifier.#DETECTORS.find(candidate => candidate.requiresArray === startsWithArray && prefix.includes(candidate.marker));
    return detector?.key ?? null;
  }

  /**
   * Files a parsed, non-conversations category into its bucket, by detector key.
   * @type {Readonly<Record<string, function(object, *): void>>}
   */
  static #BUCKET_ASSIGNERS = Object.freeze({
    users: (buckets, json) => { buckets.usersJson = json; },
    memories: (buckets, json) => buckets.memoriesJsons.push(json),
    feedback: (buckets, json) => buckets.feedbackJsons.push(json),
    loginHistory: (buckets, json) => { buckets.loginHistoryJson = json; },
    artifact: (buckets, json) => buckets.artifactJsons.push(json),
    project: (buckets, json) => buckets.projectsJsons.push(json),
  });

  /**
   * A file's content, parsed as JSON.
   * @param {File} file The file.
   * @returns {Promise<*>} The parsed content, or null when it isn't valid JSON.
   */
  static async #parseOrNull(file) {
    try {
      return JSON.parse(await file.text());
    } catch {
      return null;
    }
  }
}
