import { ChatMessage } from './ChatMessage.js';
import { createLocalMessageId } from './createLocalMessageId.js';

/**
 * Creates a local, unpersisted assistant message showing an error.
 * @param {string} errorText Error text.
 * @returns {ChatMessage} The notice.
 */
export function createErrorNotice(errorText) {
  return new ChatMessage({ id: createLocalMessageId(), sender: 'assistant', isPersisted: false, errorText });
}
