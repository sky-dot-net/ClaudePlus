/**
 * Sorts the files a user selected from an extracted data export into their categories, by content
 * shape rather than filename - conversations.json is the only export file with a predictable name;
 * memories/projects/feedback files are named by uuid, and an Artifact's html is named by version id.
 */
export class ImportFileClassifier {
  /**
   * Detectors tried in turn against a parsed JSON file; the first match wins.
   * @type {ReadonlyArray<{matches: function(*): boolean, assign: function(object, *): void}>}
   */
  static #DETECTORS = [
    { matches: json => Array.isArray(json) && Boolean(json[0]?.chat_messages), assign: (buckets, json) => { buckets.conversationsJson = json; } },
    { matches: json => Array.isArray(json) && Boolean(json[0]?.full_name), assign: (buckets, json) => { buckets.usersJson = json; } },
    { matches: json => Boolean(json?.memory_files), assign: (buckets, json) => buckets.memoriesJsons.push(json) },
    { matches: json => Boolean(json?.reflections), assign: (buckets, json) => buckets.feedbackJsons.push(json) },
    { matches: json => Boolean(json?.login_events), assign: (buckets, json) => { buckets.loginHistoryJson = json; } },
    { matches: json => Array.isArray(json?.versions) && Boolean(json?.active_version), assign: (buckets, json) => buckets.artifactJsons.push(json) },
    { matches: json => Array.isArray(json?.docs) && 'prompt_template' in json, assign: (buckets, json) => buckets.projectsJsons.push(json) },
  ];

  /**
   * Classifies a set of selected files.
   * @param {File[]} files The selected files.
   * @returns {Promise<{conversationsJson: ?Array, memoriesJsons: object[], projectsJsons: object[], feedbackJsons: object[], usersJson: ?Array, loginHistoryJson: ?object, artifacts: Array<{artifactJson: object, htmlByVersionId: Map<string, string>}>}>}
   * The classified files, ready for ClaudeExportParser/ClaudeExportMapper.
   */
  static async classify(files) {
    const htmlByBasename = await ImportFileClassifier.#htmlFilesByBasename(files);
    const buckets = { conversationsJson: null, memoriesJsons: [], projectsJsons: [], feedbackJsons: [], usersJson: null, loginHistoryJson: null, artifactJsons: [] };
    await Promise.all(files.filter(file => !file.name.endsWith('.html')).map(file => ImportFileClassifier.#classifyOne(file, buckets)));
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
   * Parses one file as JSON and files it into the matching bucket; a file that parses but matches
   * no known shape, or doesn't parse as JSON at all, is silently ignored.
   * @param {File} file The file.
   * @param {object} buckets Buckets accumulated so far.
   * @returns {Promise<void>} Resolves once classified.
   */
  static async #classifyOne(file, buckets) {
    const json = await ImportFileClassifier.#parseOrNull(file);
    if (json === null) return;
    ImportFileClassifier.#DETECTORS.find(detector => detector.matches(json))?.assign(buckets, json);
  }

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
