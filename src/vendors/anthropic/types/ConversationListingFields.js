/**
 * Field access for a ConversationListing, so callers never read its raw API field names directly.
 */
export class ConversationListingFields {
  /**
   * A listing's id.
   * @param {ConversationListing} listing The listing.
   * @returns {string} Its conversation id.
   */
  static id(listing) {
    return listing.uuid;
  }

  /**
   * A listing's title.
   * @param {ConversationListing} listing The listing.
   * @returns {string} Its title; may be empty.
   */
  static title(listing) {
    return listing.name;
  }

  /**
   * When a listing last changed.
   * @param {ConversationListing} listing The listing.
   * @returns {string} ISO timestamp of the last change.
   */
  static updatedAt(listing) {
    return listing.updated_at;
  }
}
