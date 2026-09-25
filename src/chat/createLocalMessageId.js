/**
 * Creates an id for a message that exists only locally.
 * @returns {string} A unique id prefixed with "local-".
 */
export function createLocalMessageId() {
  return `local-${crypto.randomUUID()}`;
}
