/**
 * Reads a file whose content is one large top-level JSON array of objects, one element at a time,
 * without ever holding the whole file's text or the whole array in memory - only the current
 * element's own text, bounded by that one element's size regardless of how large the file is.
 * Built for conversations.json, which real exports can grow to hundreds of megabytes: a plain
 * `JSON.parse(await file.text())` would materialize the whole file as text and then again as a
 * full object graph, and would block the main thread for as long as that takes.
 */
export class StreamingJsonArrayReader {
  /**
   * Characters that open a nesting level.
   * @type {ReadonlySet<string>}
   */
  static #OPENERS = new Set(['{', '[']);

  /**
   * Characters that close a nesting level.
   * @type {ReadonlySet<string>}
   */
  static #CLOSERS = new Set(['}', ']']);

  /**
   * Every element of the array, parsed, one at a time.
   * @param {File} file A file whose content is a JSON array of objects.
   * @returns {AsyncGenerator<*>} The elements, parsed, in file order.
   * @yields {*} Each array element, parsed.
   */
  static async *readArray(file) {
    for await (const text of StreamingJsonArrayReader.#readRawElements(file)) yield JSON.parse(text);
  }

  /**
   * The number of elements in the array, without parsing any of them.
   * @param {File} file A file whose content is a JSON array of objects.
   * @returns {Promise<number>} The count.
   */
  static async countArrayElements(file) {
    const elements = StreamingJsonArrayReader.#readRawElements(file);
    let count = 0;
    for (let step = await elements.next(); !step.done; step = await elements.next()) count += 1;
    return count;
  }

  /**
   * Every top-level element's raw, unparsed text, found by tracking brace/bracket depth and string
   * state character by character across chunk boundaries.
   * @param {File} file A file whose content is a JSON array of objects.
   * @returns {AsyncGenerator<string>} The elements' exact source text, in file order.
   * @yields {string} Each element's exact source text.
   */
  static async *#readRawElements(file) {
    const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
    try {
      yield* StreamingJsonArrayReader.#scanChunks(reader);
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Reads decoded text chunks from a stream reader and yields each completed top-level element as
   * it's found, carrying scan state and any incomplete element's text across chunk boundaries.
   * @param {ReadableStreamDefaultReader<string>} reader Reader of the decoded text stream.
   * @returns {AsyncGenerator<string>} The elements' exact source text, in file order.
   * @yields {string} Each element's exact source text.
   */
  static async *#scanChunks(reader) {
    const state = { depth: 0, inString: false, isEscaped: false, elementStart: -1 };
    let buffer = '';
    let step = await reader.read();
    while (!step.done) {
      buffer += step.value;
      const { elements, consumedUpTo } = StreamingJsonArrayReader.#scan(buffer, state);
      yield* elements;
      buffer = buffer.slice(consumedUpTo);
      step = await reader.read();
    }
  }

  /**
   * Scans as much of a buffer as forms complete elements, updating the scan state in place.
   * @param {string} buffer Text accumulated since the last completed element.
   * @param {{depth: number, inString: boolean, isEscaped: boolean, elementStart: number}} state
   * Mutable scan state, carried across calls (and across chunk boundaries).
   * @returns {{elements: string[], consumedUpTo: number}} Completed elements found, and how much
   * of the buffer they consumed (the rest carries over to the next call).
   */
  static #scan(buffer, state) {
    const elements = [];
    let consumedUpTo = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (StreamingJsonArrayReader.#step(buffer, index, state)) {
        elements.push(buffer.slice(state.elementStart, index + 1));
        state.elementStart = -1;
        consumedUpTo = index + 1;
      }
    }
    return { elements, consumedUpTo };
  }

  /**
   * Advances the scan state by one character.
   * @param {string} buffer The buffer being scanned.
   * @param {number} index Index of the character to process.
   * @param {{depth: number, inString: boolean, isEscaped: boolean, elementStart: number}} state
   * Mutable scan state.
   * @returns {boolean} True when this character completed a top-level element.
   */
  static #step(buffer, index, state) {
    const char = buffer[index];
    if (state.inString) return StreamingJsonArrayReader.#stepInString(char, state);
    if (char === '"') { state.inString = true; return false; }
    if (StreamingJsonArrayReader.#OPENERS.has(char)) return StreamingJsonArrayReader.#open(index, state);
    return StreamingJsonArrayReader.#CLOSERS.has(char) && StreamingJsonArrayReader.#close(state);
  }

  /**
   * Advances the scan state by one character while inside a string.
   * @param {string} char The character.
   * @param {{inString: boolean, isEscaped: boolean}} state Mutable scan state.
   * @returns {boolean} Always false; a string can't itself complete a top-level element.
   */
  static #stepInString(char, state) {
    if (state.isEscaped) state.isEscaped = false;
    else if (char === '\\') state.isEscaped = true;
    else if (char === '"') state.inString = false;
    return false;
  }

  /**
   * Handles an opening brace or bracket: entering the array (depth 0 to 1) starts nothing; entering
   * an element (depth 1 to 2) marks where it begins.
   * @param {number} index Index of the opening character.
   * @param {{depth: number, elementStart: number}} state Mutable scan state.
   * @returns {boolean} Always false; an opening character can't complete an element.
   */
  static #open(index, state) {
    state.depth += 1;
    if (state.depth === 2) state.elementStart = index;
    return false;
  }

  /**
   * Handles a closing brace or bracket: leaving an element (depth 2 to 1) completes it.
   * @param {{depth: number, elementStart: number}} state Mutable scan state.
   * @returns {boolean} True when this closed a top-level element.
   */
  static #close(state) {
    state.depth -= 1;
    return state.depth === 1 && state.elementStart >= 0;
  }
}
