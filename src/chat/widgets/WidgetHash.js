/**
 * Derives a stable cache key for a widget call from its tool name and data, so identical widgets
 * (even across different conversations) share one cached, already-extracted card.
 */
export class WidgetHash {
  /**
   * A hex-encoded SHA-256 hash of a widget's tool name and data.
   * @param {string} toolName The widget tool's name.
   * @param {object} data The widget's data.
   * @returns {Promise<string>} The hash.
   */
  static async hashOf(toolName, data) {
    const text = `${toolName}:${JSON.stringify(data)}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
}
