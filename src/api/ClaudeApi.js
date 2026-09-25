import { ApiError } from './ApiError.js';
import { STREAM_START } from '../config/STREAM_START.js';
import { ServerSentEventDecoder } from './ServerSentEventDecoder.js';
import { currentTimezone } from '../time/currentTimezone.js';
import { gzipJson } from '../browser/gzipJson.js';
import { readCookie } from '../browser/readCookie.js';
import { resolveLocale } from '../browser/resolveLocale.js';

/**
 * Client for claude.ai's internal API, the only source of data and actions for the whole UI.
 */
export class ClaudeApi {
  /**
   * The organization id, resolved once; null before first use or after a failure.
   * @type {?Promise<string>}
   */
  #organizationIdPromise = null;

  /**
   * Lists conversations, most recently updated first.
   * @param {number} offset Number of conversations to skip.
   * @param {number} limit Maximum number to return.
   * @returns {Promise<ConversationListing[]>} The page of conversations.
   * @throws {ApiError} When the request fails.
   */
  listConversations(offset, limit) {
    return this.#getJson('/chat_conversations', { limit, offset });
  }

  /**
   * Fetches a conversation with every message of every branch.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<ApiConversation>} The conversation.
   * @throws {ApiError} When the request fails.
   */
  getConversation(conversationId) {
    return this.#getJson(`/chat_conversations/${conversationId}`, { tree: 'True', rendering_mode: 'messages', render_all_tools: 'true' });
  }

  /**
   * Permanently deletes a conversation.
   * @param {string} conversationId Conversation id.
   * @returns {Promise<void>} Resolves once deleted.
   * @throws {ApiError} When the request fails.
   */
  async deleteConversation(conversationId) {
    await this.#fetchSuccessful(await this.#organizationUrl(`/chat_conversations/${conversationId}`, {}), { method: 'DELETE' });
  }

  /**
   * Fetches the current usage windows.
   * @returns {Promise<RateLimits>} The five-hour and weekly windows.
   * @throws {ApiError} When the request fails.
   */
  async getUsage() {
    const usage = await this.#getJson('/usage', {});
    return { fiveHour: usage.five_hour, sevenDay: usage.seven_day };
  }

  /**
   * Uploads a file for attaching to a prompt. The conversation id must be the one the prompt itself
   * will use: for a chat that hasn't sent its first message yet, that's the id the caller intends
   * to reuse as the new conversation's id, not one generated fresh at send time.
   * @param {string} conversationId Conversation the file will be attached in.
   * @param {File} file File to upload.
   * @returns {Promise<UploadedFile>} The server's record of the upload.
   * @throws {ApiError} When the request fails.
   */
  async uploadFile(conversationId, file) {
    const body = new FormData();
    body.append('file', file);
    const url = await this.#organizationUrl(`/conversations/${conversationId}/wiggle/upload-file`, {});
    const response = await this.#fetchSuccessful(url, { method: 'POST', body });
    return response.json();
  }

  /**
   * Sends a prompt and streams the reply. The first event has type STREAM_START and carries the
   * client-generated humanMessageId and assistantMessageId; every following event is a parsed
   * server-sent event.
   * @param {object} request The prompt to send.
   * @param {string} request.conversationId Conversation id; a new random id when isNew.
   * @param {string} request.prompt Prompt text.
   * @param {string} request.parentMessageId Message to reply to; ignored when isNew.
   * @param {boolean} request.isNew Whether this creates the conversation.
   * @param {ComposerSnapshot} request.settings Model options.
   * @param {string[]} [request.fileUuids] Ids of files uploaded beforehand to attach.
   * @param {AbortSignal} request.signal Aborts the request and the stream.
   * @yields {StreamEvent} The start event, then each server-sent event.
   * @returns {AsyncGenerator<StreamEvent, void, void>} The events in order.
   * @throws {ApiError} When the server rejects the request.
   * @throws {DOMException} An AbortError when aborted.
   */
  async *streamCompletion({ conversationId, prompt, parentMessageId, isNew, settings, fileUuids, signal }) {
    const body = ClaudeApi.#buildCompletionBody({ prompt, parentMessageId, isNew, settings, fileUuids });
    const response = await this.#fetchSuccessful(await this.#organizationUrl(`/chat_conversations/${conversationId}/completion`, {}), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'text/event-stream', 'Content-Encoding': 'gzip' },
      body: await gzipJson(body),
      signal,
    });
    const messageIds = body.turn_message_uuids;
    yield { type: STREAM_START, humanMessageId: messageIds.human_message_uuid, assistantMessageId: messageIds.assistant_message_uuid };
    yield* ServerSentEventDecoder.decodeStream(response.body);
  }

  /**
   * Builds a completion request body.
   * @param {object} request The prompt to send.
   * @param {string} request.prompt Prompt text.
   * @param {string} request.parentMessageId Message to reply to; ignored when isNew.
   * @param {boolean} request.isNew Whether to create the conversation.
   * @param {ComposerSnapshot} request.settings Model options.
   * @param {string[]} [request.fileUuids] Ids of files uploaded beforehand to attach.
   * @returns {object} The body, with conversation-creation parameters or a parent message id.
   */
  static #buildCompletionBody({ prompt, parentMessageId, isNew, settings, fileUuids }) {
    const body = {
      prompt,
      timezone: currentTimezone(),
      locale: resolveLocale(),
      model: settings.model,
      effort: settings.effort,
      thinking_mode: settings.thinkingMode,
      tools: [],
      turn_message_uuids: { human_message_uuid: crypto.randomUUID(), assistant_message_uuid: crypto.randomUUID() },
      attachments: [],
      files: fileUuids ?? [],
      sync_sources: [],
      completion_request_id: crypto.randomUUID(),
      rendering_mode: 'messages',
    };
    return isNew
      ? { ...body, create_conversation_params: ClaudeApi.#newConversationParameters(settings.model) }
      : { ...body, parent_message_uuid: parentMessageId };
  }

  /**
   * Parameters for creating a conversation with the first completion.
   * @param {string} model Model id of the new conversation.
   * @returns {object} The create_conversation_params object.
   */
  static #newConversationParameters(model) {
    return {
      name: '', model, include_conversation_preferences: true,
      paprika_mode: null, compass_mode: null, tool_search_mode: 'auto',
      is_temporary: false, chat_memory_mode: 'enabled', enabled_imagine: false,
    };
  }

  /**
   * GETs an organization-scoped endpoint and parses the JSON response.
   * @param {string} path Path below the organization.
   * @param {Object<string, string|number>} queryParameters Query parameters.
   * @returns {Promise<*>} The parsed body.
   * @throws {ApiError} When the request fails.
   */
  async #getJson(path, queryParameters) {
    const response = await this.#fetchSuccessful(await this.#organizationUrl(path, queryParameters), {});
    return response.json();
  }

  /**
   * Fetches a URL and rejects non-success responses.
   * @param {string} url Request URL.
   * @param {RequestInit} requestOptions Fetch options.
   * @returns {Promise<Response>} The successful response.
   * @throws {ApiError} When the response status isn't 2xx.
   */
  async #fetchSuccessful(url, requestOptions) {
    const response = await fetch(url, requestOptions);
    if (!response.ok) throw await ApiError.fromResponse(response);
    return response;
  }

  /**
   * URL of an organization-scoped endpoint.
   * @param {string} path Path below the organization.
   * @param {Object<string, string|number>} queryParameters Query parameters; may be empty.
   * @returns {Promise<string>} The URL.
   * @throws {ApiError} When the organization can't be resolved.
   */
  async #organizationUrl(path, queryParameters) {
    const query = new URLSearchParams(queryParameters).toString();
    const baseUrl = `/api/organizations/${await this.#resolveOrganizationId()}${path}`;
    return query ? `${baseUrl}?${query}` : baseUrl;
  }

  /**
   * The organization id, resolved once and cached. A failed lookup is retried on the next call.
   * @returns {Promise<string>} The organization id.
   * @throws {ApiError|Error} When the organizations can't be listed or none exist.
   */
  #resolveOrganizationId() {
    this.#organizationIdPromise ??= this.#fetchOrganizationId().catch((error) => {
      this.#organizationIdPromise = null;
      throw error;
    });
    return this.#organizationIdPromise;
  }

  /**
   * Lists the user's organizations and chooses one.
   * @returns {Promise<string>} The chosen organization id.
   * @throws {ApiError|Error} When the request fails or returns no organizations.
   */
  async #fetchOrganizationId() {
    const response = await this.#fetchSuccessful('/api/organizations', {});
    return ClaudeApi.#chooseOrganization(await response.json()).uuid;
  }

  /**
   * Chooses the organization claude.ai itself last used (its lastActiveOrg cookie), so accounts in
   * several organizations see the same data as the native app; otherwise the first one.
   * @param {Array<{uuid: string}>} organizations Organizations returned by the API.
   * @returns {{uuid: string}} The chosen organization.
   * @throws {Error} When the list is empty or not an array.
   */
  static #chooseOrganization(organizations) {
    if (!Array.isArray(organizations) || organizations.length === 0) throw new Error('no organizations returned');
    const lastActiveId = readCookie('lastActiveOrg');
    return organizations.find(organization => organization.uuid === lastActiveId) ?? organizations[0];
  }
}
