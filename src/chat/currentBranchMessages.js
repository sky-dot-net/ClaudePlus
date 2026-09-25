import { ChatMessage } from './ChatMessage.js';
import { ConversationTree } from './ConversationTree.js';

/**
 * Chat messages of a conversation's current branch.
 * @param {ApiConversation} conversation The conversation.
 * @returns {ChatMessage[]} The messages, oldest first.
 */
export function currentBranchMessages(conversation) {
  return ConversationTree.currentBranch(conversation).map(apiMessage => ChatMessage.fromApi(apiMessage));
}
