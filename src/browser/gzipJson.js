/**
 * Serializes a value as gzip-compressed JSON, the body format the completion endpoint requires.
 * @param {*} value JSON-serializable value.
 * @returns {Promise<Uint8Array>} The compressed bytes.
 */
export async function gzipJson(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const compressedStream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(compressedStream).arrayBuffer());
}
