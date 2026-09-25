/**
 * State of one prompt/reply exchange while it is being sent.
 */
export class Turn {
  /**
   * Creates the turn.
   * @param {object} fields Turn fields.
   * @param {string} fields.conversationId Conversation the prompt belongs to.
   * @param {boolean} fields.isNewConversation Whether the prompt creates the conversation.
   * @param {string} fields.prompt Prompt text.
   * @param {ChatMessage} fields.promptMessage The prompt's message.
   * @param {UploadedFile[]} fields.files Files uploaded beforehand to attach.
   * @param {AbortController} fields.abortController Aborts the request.
   */
  constructor({ conversationId, isNewConversation, prompt, promptMessage, files, abortController }) {
    this.conversationId = conversationId;
    this.isNewConversation = isNewConversation;
    this.prompt = prompt;
    this.promptMessage = promptMessage;
    this.files = files;
    this.abortController = abortController;
    this.replyMessage = null;
    this.hasFailed = false;
  }
}
