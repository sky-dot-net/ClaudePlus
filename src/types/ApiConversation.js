/**
 * A full conversation as returned by the API.
 * @typedef {object} ApiConversation
 * @property {string} uuid Conversation id.
 * @property {string} name Title; may be empty.
 * @property {string} updated_at ISO timestamp of the last change.
 * @property {string} [current_leaf_message_uuid] Last message of the branch claude.ai shows.
 * @property {ApiMessage[]} chat_messages Every message of every branch.
 */

export {};
