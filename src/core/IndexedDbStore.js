/**
 * Promise-based access to one IndexedDB database. The connection opens on first use and is
 * retried after a failure.
 */
export class IndexedDbStore {
  /**
   * Database name.
   * @type {string}
   */
  #databaseName;

  /**
   * Schema version.
   * @type {number}
   */
  #schemaVersion;

  /**
   * Creates missing object stores on upgrade.
   * @type {function(IDBDatabase): void}
   */
  #upgradeSchema;

  /**
   * The open connection, or null before first use or after a failure.
   * @type {?Promise<IDBDatabase>}
   */
  #connection = null;

  /**
   * Describes the database; nothing is opened yet.
   * @param {object} options Database description.
   * @param {string} options.name Database name.
   * @param {number} options.version Schema version.
   * @param {function(IDBDatabase): void} options.upgrade Called when the schema must be created or upgraded.
   */
  constructor({ name, version, upgrade }) {
    this.#databaseName = name;
    this.#schemaVersion = version;
    this.#upgradeSchema = upgrade;
  }

  /**
   * Reads one record.
   * @param {string} storeName Object store.
   * @param {IDBValidKey} key Record key.
   * @returns {Promise<*>} The record, or undefined when absent.
   * @throws {DOMException} When the database can't be opened or read.
   */
  read(storeName, key) {
    return this.#runRequest(storeName, 'readonly', store => store.get(key));
  }

  /**
   * Reads every record of a store.
   * @param {string} storeName Object store.
   * @returns {Promise<Array<*>>} All records.
   * @throws {DOMException} When the database can't be opened or read.
   */
  readAll(storeName) {
    return this.#runRequest(storeName, 'readonly', store => store.getAll());
  }

  /**
   * Inserts or replaces a record.
   * @param {string} storeName Object store.
   * @param {object} record Record; its key comes from the store's key path.
   * @returns {Promise<IDBValidKey>} The record's key.
   * @throws {DOMException} When the database can't be opened or written.
   */
  write(storeName, record) {
    return this.#runRequest(storeName, 'readwrite', store => store.put(record));
  }

  /**
   * Deletes a record; deleting a missing record succeeds.
   * @param {string} storeName Object store.
   * @param {IDBValidKey} key Record key.
   * @returns {Promise<void>} Resolves once deleted.
   * @throws {DOMException} When the database can't be opened or written.
   */
  remove(storeName, key) {
    return this.#runRequest(storeName, 'readwrite', store => store.delete(key));
  }

  /**
   * Reads a record and writes back a replacement in one transaction, so concurrent tabs can't
   * overwrite each other's changes.
   * @param {string} storeName Object store.
   * @param {IDBValidKey} key Record key.
   * @param {function(*): object} createReplacement Receives the current record (or undefined) and returns the replacement.
   * @returns {Promise<*>} The record as it was before the update.
   * @throws {DOMException} When the database can't be opened or written.
   */
  update(storeName, key, createReplacement) {
    return this.#runRequest(storeName, 'readwrite', (store) => {
      const readRequest = store.get(key);
      readRequest.onsuccess = () => store.put(createReplacement(readRequest.result));
      return readRequest;
    });
  }

  /**
   * The database connection, opening it on first use.
   * @returns {Promise<IDBDatabase>} The open database.
   * @throws {DOMException} When opening fails; the next call retries.
   */
  #openConnection() {
    this.#connection ??= this.#connect().catch((error) => {
      this.#connection = null;
      throw error;
    });
    return this.#connection;
  }

  /**
   * Opens the database, upgrading the schema when needed.
   * @returns {Promise<IDBDatabase>} The open database.
   * @throws {DOMException} When the request fails.
   */
  #connect() {
    return new Promise((resolve, reject) => {
      const openRequest = indexedDB.open(this.#databaseName, this.#schemaVersion);
      openRequest.onupgradeneeded = () => this.#upgradeSchema(openRequest.result);
      openRequest.onsuccess = () => resolve(openRequest.result);
      openRequest.onerror = () => reject(openRequest.error);
    });
  }

  /**
   * Runs one request in its own transaction and resolves once the transaction completes.
   * @param {string} storeName Object store.
   * @param {IDBTransactionMode} mode Transaction mode.
   * @param {function(IDBObjectStore): IDBRequest} issueRequest Issues the request whose result is returned.
   * @returns {Promise<*>} The request's result.
   * @throws {DOMException} When the transaction fails or aborts.
   */
  async #runRequest(storeName, mode, issueRequest) {
    const database = await this.#openConnection();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = issueRequest(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}
