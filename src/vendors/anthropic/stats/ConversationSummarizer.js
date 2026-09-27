import { MessageContent } from '../chat/MessageContent.js';
import { TIMING } from '../../../config/TIMING.js';
import { UNTITLED } from '../../../config/UNTITLED.js';
import { addToCount } from '../../../math/addToCount.js';
import { estimateTokens } from '../../../text/estimateTokens.js';
import { hostParts } from '../../../text/hostParts.js';
import { lastPathSegment } from '../../../text/lastPathSegment.js';
import { toEpochMs } from '../../../time/toEpochMs.js';

/**
 * Computes a ConversationSummary from a full conversation.
 */
export class ConversationSummarizer {
  /**
   * Tools whose input describes a file Claude produced, mapped to how to read its path and title.
   * @type {Map<string, function(object): {path: string, title: ?string}>}
   */
  static #FILE_PRODUCING_TOOLS = new Map([
    ['create_file', input => ({ path: input.path || input.file_path || '', title: input.description })],
    ['Artifact', input => ({ path: input.file_path || '', title: input.title })],
  ]);

  /**
   * Summary being built.
   * @type {ConversationSummary}
   */
  #summary;

  /**
   * Creation time of the prompt awaiting an answer.
   * @type {?string}
   */
  #unansweredPromptTime = null;

  /**
   * Starts an empty summary.
   * @param {ApiConversation} conversation The conversation being summarized.
   * @param {boolean} isImported Whether it came from an imported data export rather than the live API.
   */
  constructor(conversation, isImported) {
    this.#summary = {
      conversationId: conversation.uuid,
      title: conversation.name || UNTITLED,
      updatedAt: conversation.updated_at,
      isImported,
      promptCount: 0,
      toolCallCounts: Object.create(null),
      toolCalls: [],
      sources: [],
      files: [],
      estimatedTokensIn: 0,
      estimatedTokensOut: 0,
      responseTimesMs: [],
    };
  }

  /**
   * Summarizes a conversation.
   * @param {ApiConversation} conversation The conversation, with every message.
   * @param {boolean} [isImported] Whether it came from an imported data export rather than the live API.
   * @returns {ConversationSummary} The summary.
   */
  static summarize(conversation, isImported = false) {
    const summarizer = new ConversationSummarizer(conversation, isImported);
    for (const message of conversation.chat_messages ?? []) summarizer.#addMessage(message);
    return summarizer.#summary;
  }

  /**
   * Adds one message; messages from other senders are ignored.
   * @param {ApiMessage} message The message.
   * @returns {void}
   */
  #addMessage(message) {
    if (message.sender === 'human') this.#addPrompt(message);
    else if (message.sender === 'assistant') this.#addReply(message);
  }

  /**
   * Counts a prompt, its estimated tokens and its uploads.
   * @param {ApiMessage} message A human message.
   * @returns {void}
   */
  #addPrompt(message) {
    this.#summary.promptCount += 1;
    this.#summary.estimatedTokensIn += estimateTokens(MessageContent.plainText(message));
    this.#unansweredPromptTime = message.created_at;
    for (const upload of MessageContent.uploads(message)) {
      const name = MessageContent.uploadName(upload);
      this.#summary.files.push({ path: name, title: name, timestamp: upload.created_at || message.created_at, source: 'user', messageId: message.uuid });
    }
  }

  /**
   * Counts a reply's estimated tokens, response time, tool calls, sources and produced files.
   * @param {ApiMessage} message An assistant message.
   * @returns {void}
   */
  #addReply(message) {
    this.#summary.estimatedTokensOut += estimateTokens(MessageContent.plainText(message));
    this.#recordResponseTime(message.created_at);
    const producedFilesByPath = new Map();
    for (const block of message.content ?? []) this.#addContentBlock(block, block.stop_timestamp || message.created_at, message.uuid, producedFilesByPath);
    this.#summary.files.push(...producedFilesByPath.values());
  }

  /**
   * Records the time since the unanswered prompt, if plausible, and clears it.
   * @param {string} answerTime Creation time of the answer.
   * @returns {void}
   */
  #recordResponseTime(answerTime) {
    if (!this.#unansweredPromptTime) return;
    const responseMs = toEpochMs(answerTime) - toEpochMs(this.#unansweredPromptTime);
    if (responseMs > 0 && responseMs < TIMING.maxResponseGapMs) this.#summary.responseTimesMs.push(responseMs);
    this.#unansweredPromptTime = null;
  }

  /**
   * Adds one content block of a reply.
   * @param {ContentBlock} block The block.
   * @param {string} blockTime Timestamp of the block.
   * @param {string} messageId Id of the message the block belongs to.
   * @param {Map<string, FileEntry>} producedFilesByPath Files produced by the reply, keyed by path; the last write wins.
   * @returns {void}
   */
  #addContentBlock(block, blockTime, messageId, producedFilesByPath) {
    if (block.type === 'tool_use') this.#addToolCall(block, blockTime, messageId, producedFilesByPath);
    else if (block.type === 'tool_result') this.#addToolResult(block, blockTime, messageId);
  }

  /**
   * Counts a tool call, records its occurrence and the file it produced, if any.
   * @param {ContentBlock} block A tool_use block.
   * @param {string} blockTime Timestamp of the block.
   * @param {string} messageId Id of the message the block belongs to.
   * @param {Map<string, FileEntry>} producedFilesByPath Files produced by the reply, keyed by path.
   * @returns {void}
   */
  #addToolCall(block, blockTime, messageId, producedFilesByPath) {
    const toolName = block.name || 'unknown_tool';
    addToCount(this.#summary.toolCallCounts, toolName, 1);
    this.#summary.toolCalls.push({ name: toolName, timestamp: blockTime, messageId });
    const describeFile = ConversationSummarizer.#FILE_PRODUCING_TOOLS.get(toolName);
    if (!describeFile || !block.input) return;
    const { path, title } = describeFile(block.input);
    producedFilesByPath.set(path, { path, title: title || lastPathSegment(path), timestamp: blockTime, source: 'claude', messageId });
  }

  /**
   * Records the web sources a tool result cites.
   * @param {ContentBlock} block A tool_result block.
   * @param {string} blockTime Timestamp of the block.
   * @param {string} messageId Id of the message the block belongs to.
   * @returns {void}
   */
  #addToolResult(block, blockTime, messageId) {
    const items = Array.isArray(block.content) ? block.content : [];
    for (const item of items.filter(ConversationSummarizer.#isWebSource)) {
      this.#summary.sources.push({ title: item.title, url: item.url, ...hostParts(item.url), timestamp: blockTime, messageId });
    }
  }

  /**
   * Whether a tool result item is a citable web source.
   * @param {?object} item The item.
   * @returns {boolean} True when it has a URL and a title.
   */
  static #isWebSource(item) {
    return Boolean(item && item.url && item.title);
  }
}
