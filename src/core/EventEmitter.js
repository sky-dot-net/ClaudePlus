/**
 * Minimal publish/subscribe base class.
 */
export class EventEmitter {
  /**
   * Listeners per event name.
   * @type {Map<string, Set<function(*): void>>}
   */
  #listenersByEvent = new Map();

  /**
   * Subscribes to an event.
   * @param {string} eventName Event name.
   * @param {function(*): void} listener Called with the event payload.
   * @returns {function(): void} Unsubscribes the listener.
   */
  subscribe(eventName, listener) {
    if (!this.#listenersByEvent.has(eventName)) this.#listenersByEvent.set(eventName, new Set());
    this.#listenersByEvent.get(eventName).add(listener);
    return () => this.#listenersByEvent.get(eventName).delete(listener);
  }

  /**
   * Calls every listener of an event. Listeners added or removed during the call don't affect it.
   * @param {string} eventName Event name.
   * @param {*} [payload] Value passed to each listener.
   * @returns {void}
   */
  publish(eventName, payload) {
    for (const listener of [...(this.#listenersByEvent.get(eventName) ?? [])]) listener(payload);
  }
}
