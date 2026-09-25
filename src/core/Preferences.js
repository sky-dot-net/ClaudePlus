/**
 * localStorage access that degrades to no-ops when storage is unavailable (private mode, blocked
 * site data), because every accessor can throw there.
 */
export class Preferences {
  /**
   * Reads a string value.
   * @param {string} key Storage key.
   * @returns {?string} The stored value, or null when missing or unavailable.
   */
  read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  /**
   * Stores a value as a string; silently skipped when storage is unavailable.
   * @param {string} key Storage key.
   * @param {*} value Value to store.
   * @returns {void}
   */
  write(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      return;
    }
  }

  /**
   * Removes a value; silently skipped when storage is unavailable.
   * @param {string} key Storage key.
   * @returns {void}
   */
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      return;
    }
  }

  /**
   * Reads and parses a JSON value.
   * @param {string} key Storage key.
   * @returns {*} The parsed value, or null when missing, unavailable or not valid JSON.
   */
  readJson(key) {
    try {
      return JSON.parse(this.read(key));
    } catch {
      return null;
    }
  }

  /**
   * Stores a value as JSON.
   * @param {string} key Storage key.
   * @param {*} value JSON-serializable value.
   * @returns {void}
   */
  writeJson(key, value) {
    this.write(key, JSON.stringify(value));
  }

  /**
   * Every stored entry whose key starts with a prefix.
   * @param {string} prefix Key prefix.
   * @returns {Object<string, string>} Raw stored values by key; empty when storage is unavailable.
   */
  entriesWithPrefix(prefix) {
    return Object.fromEntries(this.#keysWithPrefix(prefix).map(key => [key, this.read(key)]));
  }

  /**
   * Removes every stored entry whose key starts with a prefix, then stores the given entries.
   * @param {string} prefix Key prefix.
   * @param {Object<string, string>} entries Raw values by key.
   * @returns {void}
   */
  replaceEntriesWithPrefix(prefix, entries) {
    this.#keysWithPrefix(prefix).forEach(key => this.remove(key));
    Object.entries(entries).forEach(([key, value]) => this.write(key, value));
  }

  /**
   * Stored keys starting with a prefix.
   * @param {string} prefix Key prefix.
   * @returns {string[]} The keys; empty when storage is unavailable.
   */
  #keysWithPrefix(prefix) {
    try {
      return Object.keys(localStorage).filter(key => key.startsWith(prefix));
    } catch {
      return [];
    }
  }
}
