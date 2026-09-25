/**
 * Numbers navigations, so a response arriving for an older navigation can be recognized and dropped.
 */
export class NavigationCounter {
  /**
   * Number of the latest navigation.
   * @type {number}
   */
  #latestNavigation = 0;

  /**
   * Starts a new navigation, making every earlier one outdated.
   * @returns {number} Number identifying the new navigation.
   */
  begin() {
    this.#latestNavigation += 1;
    return this.#latestNavigation;
  }

  /**
   * Whether a navigation is still the latest one.
   * @param {number} navigation Number returned by begin().
   * @returns {boolean} True if no navigation began since.
   */
  isLatest(navigation) {
    return navigation === this.#latestNavigation;
  }
}
