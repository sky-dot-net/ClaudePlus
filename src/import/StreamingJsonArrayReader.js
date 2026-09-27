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
   * state character by character across chunk boundaries. The accumulated buffer is only ever
   * dropped when nothing is mid-element - while assembling one element's text, the buffer keeps
   * growing (bounded by that element's own size) rather than being rescanned from the start on
   * every new chunk, which would otherwise reprocess already-seen characters and miscount depth.
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
   * it's found.
   * @param {ReadableStreamDefaultReader<string>} reader Reader of the decoded text stream.
   * @returns {AsyncGenerator<string>} The elements' exact source text, in file order.
   * @yields {string} Each element's exact source text.
   */
  static async *#scanChunks(reader) {
    const state = { depth: 0, inString: false, isEscaped: false, elementStart: -1 };
    let buffer = '';
    let scannedUpTo = 0;
    let step = await reader.read();
    while (!step.done) {
      buffer += step.value;
      const { elements, scannedUpTo: newScannedUpTo } = StreamingJsonArrayReader.#scan(buffer, scannedUpTo, state);
      yield* elements;
      ({ buffer, scannedUpTo } = StreamingJsonArrayReader.#afterScan(buffer, newScannedUpTo, state));
      step = await reader.read();
    }
  }

  /**
   * Drops the buffer once nothing is mid-element (there's nothing useful left in it but consumed
   * elements and separator noise), otherwise keeps it as-is so the next chunk can extend it.
   * @param {string} buffer The buffer as scanned so far.
   * @param {number} scannedUpTo How much of the buffer has been scanned.
   * @param {{elementStart: number}} state Scan state.
   * @returns {{buffer: string, scannedUpTo: number}} The buffer and scan position to continue from.
   */
  static #afterScan(buffer, scannedUpTo, state) {
    return state.elementStart === -1 ? { buffer: '', scannedUpTo: 0 } : { buffer, scannedUpTo };
  }

  /**
   * Scans a buffer from where the last call left off, updating the scan state in place.
   * @param {string} buffer Text accumulated so far.
   * @param {number} startIndex Index to resume scanning from; characters before it were already scanned.
   * @param {{depth: number, inString: boolean, isEscaped: boolean, elementStart: number}} state
   * Mutable scan state, carried across calls (and across chunk boundaries).
   * @returns {{elements: string[], scannedUpTo: number}} Completed elements found, in order, and
   * how much of the buffer has now been scanned.
   */
  static #scan(buffer, startIndex, state) {
    const elements = [];
    let index = startIndex;
    for (; index < buffer.length; index += 1) {
      if (StreamingJsonArrayReader.#step(buffer, index, state)) {
        elements.push(buffer.slice(state.elementStart, index + 1));
        state.elementStart = -1;
      }
    }
    return { elements, scannedUpTo: index };
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
