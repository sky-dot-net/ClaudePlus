/**
 * Incrementally splits a server-sent event stream into parsed JSON events.
 */
export class ServerSentEventDecoder {
  /**
   * Blank line separating two events.
   * @type {RegExp}
   */
  static #EVENT_SEPARATOR = /\r?\n\r?\n/;

  /**
   * Text received but not yet part of a complete event.
   * @type {string}
   */
  #pendingText = '';

  /**
   * Reads a byte stream to the end, yielding each event's parsed JSON data.
   * @param {ReadableStream<Uint8Array>} byteStream The response body.
   * @yields {object} Each event's data. Events without data or with invalid JSON are skipped.
   * @returns {AsyncGenerator<object, void, void>} The events in arrival order.
   * @throws {DOMException} An AbortError when the request is aborted mid-stream.
   */
  static async *decodeStream(byteStream) {
    const reader = byteStream.pipeThrough(new TextDecoderStream()).getReader();
    const decoder = new ServerSentEventDecoder();
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        yield* decoder.appendText(chunk.value);
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  /**
   * Adds received text and returns every event it completes.
   * @param {string} text Newly received text.
   * @returns {object[]} Parsed data of the completed events, in order.
   */
  appendText(text) {
    this.#pendingText += text;
    const events = [];
    for (let separator = this.#findSeparator(); separator; separator = this.#findSeparator()) {
      events.push(...ServerSentEventDecoder.#parseEvent(this.#pendingText.slice(0, separator.index)));
      this.#pendingText = this.#pendingText.slice(separator.index + separator[0].length);
    }
    return events;
  }

  /**
   * Finds the first event separator in the pending text.
   * @returns {?RegExpExecArray} The match, or null when no event is complete.
   */
  #findSeparator() {
    return ServerSentEventDecoder.#EVENT_SEPARATOR.exec(this.#pendingText);
  }

  /**
   * Parses one raw event, joining multiple data lines as the SSE format specifies.
   * @param {string} rawEvent Raw event text.
   * @returns {object[]} The parsed data as a single-element array, or an empty array when the event has no data or invalid JSON.
   */
  static #parseEvent(rawEvent) {
    const data = rawEvent.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');
    try {
      return data ? [JSON.parse(data)] : [];
    } catch {
      return [];
    }
  }
}
