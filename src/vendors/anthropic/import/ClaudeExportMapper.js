/**
 * Maps a raw conversation from claude.ai's data export into the same shape ClaudeApi's live
 * responses already produce, so the existing rendering pipeline (ChatSession, ConversationTree,
 * ChatMessage, MessageContent) renders an imported conversation unmodified.
 */
export class ClaudeExportMapper {
  /**
   * Maps one exported conversation.
   * @param {object} rawConversation A conversations.json entry.
   * @param {Map<string, {html: string}>} artifactsById Imported Artifact content, by artifact id;
   * empty when the frames file wasn't provided.
   * @returns {{conversationId: string, title: string, messages: ApiMessage[]}} The mapped conversation.
   */
  static mapConversation(rawConversation, artifactsById) {
    return {
      conversationId: rawConversation.uuid,
      title: rawConversation.name,
      messages: rawConversation.chat_messages.map(rawMessage => ClaudeExportMapper.#mapMessage(rawMessage, artifactsById)),
    };
  }

  /**
   * Maps one exported message.
   * @param {object} rawMessage A chat_messages entry.
   * @param {Map<string, {html: string}>} artifactsById Imported Artifact content, by artifact id.
   * @returns {ApiMessage} The mapped message.
   */
  static #mapMessage(rawMessage, artifactsById) {
    return {
      uuid: rawMessage.uuid,
      parent_message_uuid: rawMessage.parent_message_uuid,
      sender: rawMessage.sender,
      text: rawMessage.text,
      created_at: rawMessage.created_at,
      content: (rawMessage.content ?? []).map(block => ClaudeExportMapper.#mapContentBlock(block, artifactsById)),
      attachments: ClaudeExportMapper.#mapUploads(rawMessage),
      files: [],
    };
  }

  /**
   * Maps one content block, resolving an Artifact tool_result's real HTML when available. Every
   * other block type (including injected_prompt_block, already excluded from the chat log by the
   * existing renderer) passes through unchanged.
   * @param {object} block A raw content block.
   * @param {Map<string, {html: string}>} artifactsById Imported Artifact content, by artifact id.
   * @returns {ContentBlock} The mapped block.
   */
  static #mapContentBlock(block, artifactsById) {
    const artifactId = block.structured_content?.artifact_id;
    const artifact = artifactId ? artifactsById.get(artifactId) : null;
    return artifact ? { ...block, structured_content: { ...block.structured_content, resolvedArtifactHtml: artifact.html } } : block;
  }

  /**
   * A message's uploads as one array: its attachments as-is (already carrying full content for
   * text-based files), plus any files[] entry with no matching attachments[] entry by filename -
   * the binary case, which renders as a filename-only placeholder through the existing renderer.
   * @param {object} rawMessage A chat_messages entry.
   * @returns {object[]} The combined uploads.
   */
  static #mapUploads(rawMessage) {
    const attachments = rawMessage.attachments ?? [];
    const attachedNames = new Set(attachments.map(attachment => attachment.file_name));
    const unmatchedFiles = (rawMessage.files ?? []).filter(file => !attachedNames.has(file.file_name));
    return [...attachments, ...unmatchedFiles];
  }
}
