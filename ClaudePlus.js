// ==UserScript==
// @name         ClaudePlus
// @namespace    skydotnet.claudeplus
// @version      1.0.0
// @description  Replaces claude.ai's UI with a VS Code-style dockable, resizable, tabbed workspace:
//               conversation list, chat, composer, plus Stats / Web Sources / Files panels. The
//               native app is hidden behind a single display:none on its root containers and is
//               never queried or touched again — every panel is rendered from claude.ai's internal
//               REST/completion API.
// @match        https://claude.ai/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // ============================================================================================
  // Configuration
  // ============================================================================================

  const LOG_PREFIX = '[ClaudePlus]';

  const LAYOUT = Object.freeze({
    toolbarHeight: 36,
    tabStripHeight: 26,
    minSplitFraction: 0.08,
    edgeDockFraction: 0.25,
    edgeDropMargin: 32,
    dropRegionFraction: 0.25,
    dragThreshold: 4,
    dividerThickness: 6,
  });

  const TIMING = Object.freeze({
    rateLimitPollMs: 30_000,
    activityTickMs: 1_000,
    activityIdleMs: 60_000,
    activityFlushMs: 15_000,
    backfillDelayMs: 300,
    maxResponseGapMs: 30 * 60 * 1000,
  });

  const PAGE_SIZE = Object.freeze({ sidebar: 100, backfill: 100 });
  const MAX_LISTED_SOURCES = 500;
  const MAX_TOP_OUTLETS = 30;
  const MAX_TOOL_RESULT_CHARS = 4000;
  const BACKFILL_REFRESH_EVERY = 10;

  // Keys and database names are shared with claude-stats.user.js so an existing layout, composer
  // settings, activity history and stats cache carry over.
  const STORAGE_KEYS = Object.freeze({
    dockTree: 'cs_dock_tree_v2',
    model: 'cs_model',
    effort: 'cs_effort',
    thinkingMode: 'cs_thinking_mode',
    fontSize: 'cs_msg_font_size',
  });

  const DATABASE = Object.freeze({
    name: 'claude_stats_v1',
    version: 1,
    stores: Object.freeze({ conversations: 'conversations', activity: 'activity' }),
  });

  const MODELS = Object.freeze([
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ]);
  const EFFORTS = Object.freeze([
    { id: 'low', label: 'Low effort' },
    { id: 'medium', label: 'Medium effort' },
    { id: 'high', label: 'High effort' },
  ]);
  // The completion endpoint rejects any thinking mode other than these two.
  const THINKING_MODES = Object.freeze({ off: 'off', extended: 'extended' });

  // The completion endpoint only accepts a fixed whitelist of locale tags — navigator.language
  // (e.g. "en-GB", "de") is usually NOT one of them and the request is rejected with a 400.
  const ALLOWED_LOCALES = Object.freeze(['en-US', 'de-DE', 'fr-FR', 'ko-KR', 'ja-JP', 'es-419', 'es-ES', 'it-IT', 'hi-IN', 'pt-BR', 'id-ID']);
  const DEFAULT_LOCALE = 'en-US';

  // Parent of the first message in every claude.ai conversation tree. Only used as a fallback when
  // the API omits parent_message_uuid on a message.
  const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000';

  const NEW_CHAT_PATH = '/new';
  const CHAT_PATH_PATTERN = /^\/chat\/([0-9a-f-]{36})/i;

  const UNTITLED = '(untitled)';

  // ============================================================================================
  // Pure helpers
  // ============================================================================================

  const HTML_ENTITIES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => HTML_ENTITIES[ch]);
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  function formatUtilization(usageWindow) {
    return usageWindow ? `${Math.round((usageWindow.utilization || 0) * 100) / 100}%` : '–';
  }

  function average(values) {
    return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function timestamp(value) {
    return Date.parse(value) || 0;
  }

  function increment(counts, key, by = 1) {
    counts[key] = (counts[key] ?? 0) + by;
  }

  function sortedEntriesByCount(counts) {
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }

  function estimateTokens(text) {
    return text ? Math.ceil(text.length / 4) : 0;
  }

  function basename(path) {
    return (path || '').split('/').pop();
  }

  function fileExtension(name) {
    const match = basename(name).split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
    return match ? match[1].toLowerCase() : 'file';
  }

  function hostParts(url) {
    try {
      const outlet = new URL(url).hostname.replace(/^www\./, '');
      const labels = outlet.split('.');
      return { outlet, tld: labels.length > 1 ? labels[labels.length - 1] : '' };
    } catch {
      return { outlet: null, tld: null };
    }
  }

  function readCookie(name) {
    const entry = document.cookie.split('; ').find(c => c.startsWith(`${name}=`));
    return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
  }

  function resolveLocale() {
    const language = navigator.language || DEFAULT_LOCALE;
    if (ALLOWED_LOCALES.includes(language)) return language;
    const base = language.split('-')[0];
    return ALLOWED_LOCALES.find(l => l.startsWith(`${base}-`)) ?? DEFAULT_LOCALE;
  }

  function conversationIdFromPath(pathname) {
    return pathname.match(CHAT_PATH_PATTERN)?.[1] ?? null;
  }

  function chatPath(conversationId) {
    return `/chat/${conversationId}`;
  }

  function localId() {
    return `local-${crypto.randomUUID()}`;
  }

  // The completion endpoint requires a gzip-compressed JSON body.
  async function gzipJson(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ============================================================================================
  // DOM helpers
  // ============================================================================================

  function createElement(tag, { className, text, html, title } = {}) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (title) element.title = title;
    if (text !== undefined) element.textContent = text;
    if (html !== undefined) element.innerHTML = html;
    return element;
  }

  function placeElement(element, { x, y, w, h }) {
    Object.assign(element.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  }

  // Every element marked data-ref="name" inside root, keyed by name.
  function collectRefs(root) {
    return Object.fromEntries([...root.querySelectorAll('[data-ref]')].map(node => [node.dataset.ref, node]));
  }

  function optionsHtml(options, selectedId) {
    return options.map(o => `<option value="${escapeHtml(o.id)}"${o.id === selectedId ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  }

  function emptyStateHtml(message) {
    return `<div class="cs-empty">${escapeHtml(message)}</div>`;
  }

  // Window-level mouse tracking for one drag gesture. Listeners exist only while the button is
  // held and are always removed on release.
  function trackDrag(startEvent, { onMove, onEnd = () => {}, threshold = 0 }) {
    const startX = startEvent.clientX;
    const startY = startEvent.clientY;
    let active = threshold === 0;
    const move = (event) => {
      if (!active) {
        if (Math.abs(event.clientX - startX) < threshold && Math.abs(event.clientY - startY) < threshold) return;
        active = true;
      }
      onMove(event);
    };
    const up = (event) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      onEnd(event, active);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // Coalesces repeated calls into one callback per animation frame.
  class FrameScheduler {
    #callback;
    #frame = 0;

    constructor(callback) {
      this.#callback = callback;
    }

    schedule() {
      if (this.#frame) return;
      this.#frame = requestAnimationFrame(() => {
        this.#frame = 0;
        this.#callback();
      });
    }

    cancel() {
      cancelAnimationFrame(this.#frame);
      this.#frame = 0;
    }
  }

  // ============================================================================================
  // Infrastructure
  // ============================================================================================

  class EventEmitter {
    #listeners = new Map();

    on(event, listener) {
      if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
      this.#listeners.get(event).add(listener);
      return () => this.#listeners.get(event)?.delete(listener);
    }

    emit(event, payload) {
      for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(payload);
    }
  }

  // localStorage can throw (private mode, blocked storage); every access degrades to a no-op.
  class Preferences {
    get(key, fallback = null) {
      try {
        return localStorage.getItem(key) ?? fallback;
      } catch {
        return fallback;
      }
    }

    set(key, value) {
      try {
        localStorage.setItem(key, String(value));
      } catch {
        // Storage unavailable: the preference simply isn't persisted.
      }
    }

    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Storage unavailable: nothing to remove.
      }
    }

    getJson(key, fallback = null) {
      const raw = this.get(key);
      if (raw === null) return fallback;
      try {
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    }

    setJson(key, value) {
      this.set(key, JSON.stringify(value));
    }
  }

  class IndexedDbStore {
    #name;
    #version;
    #upgrade;
    #connection = null;

    constructor({ name, version, upgrade }) {
      this.#name = name;
      this.#version = version;
      this.#upgrade = upgrade;
    }

    get(storeName, key) {
      return this.#transact(storeName, 'readonly', store => store.get(key));
    }

    getAll(storeName) {
      return this.#transact(storeName, 'readonly', store => store.getAll());
    }

    put(storeName, value) {
      return this.#transact(storeName, 'readwrite', store => store.put(value));
    }

    // Read-modify-write inside a single transaction, so concurrent tabs can't overwrite each other.
    update(storeName, key, updater) {
      return this.#transact(storeName, 'readwrite', (store) => {
        const read = store.get(key);
        read.onsuccess = () => store.put(updater(read.result));
        return read;
      });
    }

    #open() {
      this.#connection ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(this.#name, this.#version);
        request.onupgradeneeded = () => this.#upgrade(request.result);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        this.#connection = null;
        throw error;
      });
      return this.#connection;
    }

    async #transact(storeName, mode, operation) {
      const db = await this.#open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }
  }

  // ============================================================================================
  // claude.ai internal API — the only source of data and actions for the whole UI
  // ============================================================================================

  class ApiError extends Error {
    constructor(status, detail) {
      super(`${status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
      this.name = 'ApiError';
      this.status = status;
    }

    static async from(response) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // Body unreadable: the status alone has to do.
      }
      return new ApiError(response.status, detail);
    }
  }

  const STREAM_START = 'claudeplus_stream_start';

  class ClaudeApi {
    #organizationIdPromise = null;

    listConversations({ offset = 0, limit = 50 } = {}) {
      return this.#request('/chat_conversations', { params: { limit, offset } });
    }

    getConversation(conversationId) {
      return this.#request(`/chat_conversations/${conversationId}`, {
        params: { tree: 'True', rendering_mode: 'messages', render_all_tools: 'true' },
      });
    }

    async deleteConversation(conversationId) {
      await this.#request(`/chat_conversations/${conversationId}`, { method: 'DELETE', parseJson: false });
    }

    async getUsage() {
      const usage = await this.#request('/usage');
      return { fiveHour: usage.five_hour, sevenDay: usage.seven_day };
    }

    // Sends a prompt (new or continuing conversation). Yields one STREAM_START event carrying the
    // client-generated message ids, then every parsed server-sent event as it arrives.
    async *streamCompletion({ conversationId, prompt, parentUuid, isNew, settings, signal }) {
      const body = this.#completionBody({ prompt, parentUuid, isNew, settings });
      const response = await fetch(await this.#url(`/chat_conversations/${conversationId}/completion`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'text/event-stream', 'Content-Encoding': 'gzip' },
        body: await gzipJson(body),
        signal,
      });
      if (!response.ok || !response.body) throw await ApiError.from(response);
      const { human_message_uuid: humanUuid, assistant_message_uuid: assistantUuid } = body.turn_message_uuids;
      yield { type: STREAM_START, humanUuid, assistantUuid };
      yield* ServerSentEvents.parse(response.body);
    }

    #completionBody({ prompt, parentUuid, isNew, settings }) {
      const body = {
        prompt,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        locale: resolveLocale(),
        model: settings.model,
        effort: settings.effort,
        thinking_mode: settings.thinkingMode,
        tools: [],
        turn_message_uuids: { human_message_uuid: crypto.randomUUID(), assistant_message_uuid: crypto.randomUUID() },
        attachments: [],
        files: [],
        sync_sources: [],
        completion_request_id: crypto.randomUUID(),
        rendering_mode: 'messages',
      };
      if (isNew) {
        body.create_conversation_params = {
          name: '', model: settings.model, include_conversation_preferences: true,
          paprika_mode: null, compass_mode: null, tool_search_mode: 'auto',
          is_temporary: false, chat_memory_mode: 'enabled', enabled_imagine: false,
        };
      } else {
        body.parent_message_uuid = parentUuid;
      }
      return body;
    }

    async #request(path, { method = 'GET', params, parseJson = true } = {}) {
      const response = await fetch(await this.#url(path, params), { method });
      if (!response.ok) throw await ApiError.from(response);
      return parseJson ? response.json() : null;
    }

    async #url(path, params) {
      const query = params ? `?${new URLSearchParams(params)}` : '';
      return `/api/organizations/${await this.#resolveOrganizationId()}${path}${query}`;
    }

    // Prefers the organization claude.ai itself last used, so accounts in several organizations
    // see the same data as the native app.
    #resolveOrganizationId() {
      this.#organizationIdPromise ??= (async () => {
        const response = await fetch('/api/organizations');
        if (!response.ok) throw await ApiError.from(response);
        const organizations = await response.json();
        if (!Array.isArray(organizations) || organizations.length === 0) throw new Error('no organizations returned');
        const lastActive = readCookie('lastActiveOrg');
        return (organizations.find(o => o.uuid === lastActive) ?? organizations[0]).uuid;
      })().catch((error) => {
        this.#organizationIdPromise = null;
        throw error;
      });
      return this.#organizationIdPromise;
    }
  }

  class ServerSentEvents {
    static #EVENT_BOUNDARY = /\r?\n\r?\n/;

    static async *parse(byteStream) {
      const reader = byteStream.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += value;
          let boundary;
          while ((boundary = ServerSentEvents.#EVENT_BOUNDARY.exec(buffer))) {
            const event = ServerSentEvents.#parseEvent(buffer.slice(0, boundary.index));
            buffer = buffer.slice(boundary.index + boundary[0].length);
            if (event !== undefined) yield event;
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    }

    static #parseEvent(chunk) {
      const data = chunk.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) return undefined;
      try {
        return JSON.parse(data);
      } catch {
        return undefined; // Malformed event: skip it rather than abort the whole stream.
      }
    }
  }

  // ============================================================================================
  // Message content (raw API message → text / HTML)
  // ============================================================================================

  // Tiny markdown-ish renderer: fenced code blocks, inline code, bold, italic, http(s) links.
  class Markdown {
    static #CODE_FENCE = /```[^\n`]*\n([\s\S]*?)```/;

    static toHtml(text) {
      if (!text) return '';
      // split() with one capture group alternates plain text (even) and code (odd). The line
      // breaks directly around a fence belong to the fence, not to the surrounding text.
      const parts = text.split(Markdown.#CODE_FENCE);
      return parts
        .map((part, index) => {
          if (index % 2) return `<pre class="cs-code"><code>${escapeHtml(part)}</code></pre>`;
          let plain = part;
          if (index > 0) plain = plain.replace(/^\n/, '');
          if (index < parts.length - 1) plain = plain.replace(/\n$/, '');
          return Markdown.#inline(plain).replace(/\n/g, '<br>');
        })
        .join('');
    }

    static #inline(text) {
      return escapeHtml(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }
  }

  class MessageContent {
    static uploads(raw) {
      return [...(raw.attachments ?? []), ...(raw.files ?? [])].filter(Boolean);
    }

    static attachmentName(upload) {
      return upload.file_name || upload.name || upload.filename || upload.title || '(uploaded file)';
    }

    static text(raw) {
      if (raw.text) return raw.text;
      return MessageContent.#textBlocks(raw).map(block => block.text).join('\n');
    }

    static toHtml(raw) {
      if (!raw.text && !raw.content && MessageContent.uploads(raw).length === 0) return '';
      const parts = MessageContent.uploads(raw)
        .map(upload => `<div class="cs-msg-file">📎 ${escapeHtml(MessageContent.attachmentName(upload))}</div>`);
      const textBlocks = MessageContent.#textBlocks(raw);
      if (raw.text && textBlocks.length === 0) parts.push(MessageContent.#textHtml(raw.text));
      for (const block of raw.content ?? []) parts.push(MessageContent.#blockHtml(block));
      return parts.join('') || '<div class="cs-msg-text cs-empty">(no content)</div>';
    }

    static #textBlocks(raw) {
      return (raw.content ?? []).filter(block => block.type === 'text' && block.text);
    }

    static #textHtml(text) {
      return `<div class="cs-msg-text">${Markdown.toHtml(text)}</div>`;
    }

    static #blockHtml(block) {
      switch (block.type) {
        case 'text':
          return block.text ? MessageContent.#textHtml(block.text) : '';
        case 'tool_use':
          return MessageContent.#detailsHtml(`🔧 ${escapeHtml(block.name || 'tool')}`, JSON.stringify(block.input ?? {}, null, 2));
        case 'tool_result': {
          const items = Array.isArray(block.content) ? block.content : [];
          const summary = items.map(item => item?.title || item?.type || '').filter(Boolean).join(', ');
          const label = `📄 result${summary ? `: ${escapeHtml(summary)}` : ''}`;
          return MessageContent.#detailsHtml(label, JSON.stringify(items, null, 2).slice(0, MAX_TOOL_RESULT_CHARS));
        }
        default:
          return '';
      }
    }

    static #detailsHtml(summaryHtml, body) {
      return `<details class="cs-msg-tool"><summary>${summaryHtml}</summary><pre>${escapeHtml(body)}</pre></details>`;
    }
  }

  // One message as shown in the chat. `persisted` is false for messages that only exist locally
  // (a prompt the server never accepted, or an error notice); those are never used as a parent.
  class ChatMessage {
    #html = null;

    constructor({ uuid, parentUuid = null, sender, text = '', raw = null, persisted = true, streaming = false, error = null }) {
      this.uuid = uuid;
      this.parentUuid = parentUuid;
      this.sender = sender;
      this.text = text;
      this.raw = raw;
      this.persisted = persisted;
      this.streaming = streaming;
      this.error = error;
    }

    static fromApi(raw) {
      return new ChatMessage({
        uuid: raw.uuid,
        parentUuid: raw.parent_message_uuid ?? null,
        sender: raw.sender,
        text: MessageContent.text(raw),
        raw,
      });
    }

    get html() {
      this.#html ??= MessageContent.toHtml(this.raw ?? { text: this.text });
      return this.#html;
    }

    appendText(delta) {
      this.text += delta;
      this.#html = null;
    }
  }

  // The branch currently shown by claude.ai: walk from the current leaf up to the root. Falls back
  // to the flat message list when the tree fields aren't present.
  function currentBranch(conversation) {
    const messages = conversation.chat_messages ?? [];
    const byUuid = new Map(messages.map(m => [m.uuid, m]));
    const leaf = byUuid.get(conversation.current_leaf_message_uuid);
    if (!leaf || !messages.every(m => 'parent_message_uuid' in m)) return messages;
    const branch = [];
    const visited = new Set();
    for (let node = leaf; node && !visited.has(node.uuid); node = byUuid.get(node.parent_message_uuid)) {
      visited.add(node.uuid);
      branch.push(node);
    }
    return branch.reverse();
  }

  // ============================================================================================
  // Conversation state
  // ============================================================================================

  class ComposerSettings {
    #preferences;

    constructor(preferences) {
      this.#preferences = preferences;
    }

    get model() { return this.#read(STORAGE_KEYS.model, MODELS.map(m => m.id)); }
    set model(value) { this.#write(STORAGE_KEYS.model, value, MODELS.map(m => m.id)); }

    get effort() { return this.#read(STORAGE_KEYS.effort, EFFORTS.map(e => e.id)); }
    set effort(value) { this.#write(STORAGE_KEYS.effort, value, EFFORTS.map(e => e.id)); }

    get thinkingMode() { return this.#read(STORAGE_KEYS.thinkingMode, Object.values(THINKING_MODES)); }
    set thinkingMode(value) { this.#write(STORAGE_KEYS.thinkingMode, value, Object.values(THINKING_MODES)); }

    snapshot() {
      return { model: this.model, effort: this.effort, thinkingMode: this.thinkingMode };
    }

    // The first allowed value is the default.
    #read(key, allowed) {
      const stored = this.#preferences.get(key);
      return allowed.includes(stored) ? stored : allowed[0];
    }

    #write(key, value, allowed) {
      if (allowed.includes(value)) this.#preferences.set(key, value);
    }
  }

  // Single source of truth for the conversation list, the open conversation and sending.
  // Events: 'conversations', 'active', 'messages' (list changed), 'message' (one message's content
  // changed), 'sending', 'conversationLoaded' (raw API conversation), 'messageLimit'.
  class ConversationStore extends EventEmitter {
    #api;
    #settings;
    #conversations = [];
    #conversationId = null;
    #messages = [];
    #sending = false;
    #abortController = null;
    #loadGeneration = 0;

    constructor(api, settings) {
      super();
      this.#api = api;
      this.#settings = settings;
    }

    get conversations() { return this.#conversations; }
    get conversationId() { return this.#conversationId; }
    get messages() { return this.#messages; }
    get sending() { return this.#sending; }

    async refreshConversations() {
      try {
        this.#conversations = await this.#api.listConversations({ limit: PAGE_SIZE.sidebar });
      } catch (error) {
        console.warn(LOG_PREFIX, 'loading conversations failed', error);
      }
      this.emit('conversations');
    }

    async open(conversationId) {
      this.stop();
      const generation = ++this.#loadGeneration;
      this.#setActive(conversationId);
      this.#setMessages([]);
      try {
        const conversation = await this.#api.getConversation(conversationId);
        if (generation === this.#loadGeneration) this.#applyConversation(conversation);
      } catch (error) {
        if (generation !== this.#loadGeneration) return;
        console.warn(LOG_PREFIX, 'loading conversation failed', error);
        this.#setMessages([this.#errorNotice(`Could not load this conversation (${error.message}).`)]);
      }
    }

    startNew() {
      this.stop();
      this.#loadGeneration++;
      this.#setActive(null);
      this.#setMessages([]);
    }

    stop() {
      this.#abortController?.abort();
    }

    async send(prompt, { parentUuid } = {}) {
      if (!prompt.trim() || this.#sending) return;
      const isNew = this.#conversationId === null;
      const conversationId = this.#conversationId ?? crypto.randomUUID();
      const parent = parentUuid !== undefined ? parentUuid : this.#lastPersistedUuid();
      const human = new ChatMessage({ uuid: localId(), parentUuid: parent, sender: 'human', text: prompt, persisted: false });
      this.#setMessages([...this.#messages, human]);

      const controller = new AbortController();
      this.#abortController = controller;
      this.#setSending(true);
      let assistant = null;
      let failed = false;
      try {
        const events = this.#api.streamCompletion({
          conversationId, prompt, isNew,
          parentUuid: parent ?? ROOT_MESSAGE_UUID,
          settings: this.#settings.snapshot(),
          signal: controller.signal,
        });
        for await (const event of events) {
          assistant = this.#handleStreamEvent(event, { human, assistant, isNew, conversationId, prompt });
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          failed = true;
          console.warn(LOG_PREFIX, 'send failed', error);
          if (assistant) assistant.error = error.message;
          else this.#messages.push(this.#errorNotice(error.message));
        }
      } finally {
        if (assistant) assistant.streaming = false;
        if (this.#abortController === controller) this.#abortController = null;
        this.#setSending(false);
        this.emit('messages');
        if (human.persisted) this.#reloadAfterSend(conversationId, { replaceMessages: !failed });
      }
    }

    // Asks the last prompt again as a new branch from the same parent, replacing the answer shown.
    retry() {
      if (this.#sending) return;
      const index = this.#messages.findLastIndex(m => m.sender === 'human');
      if (index === -1) return;
      const human = this.#messages[index];
      this.#setMessages(this.#messages.slice(0, index));
      this.send(human.text, { parentUuid: human.parentUuid ?? this.#persistedUuidBefore(index) });
    }

    async delete(conversationId) {
      await this.#api.deleteConversation(conversationId);
      this.#conversations = this.#conversations.filter(c => c.uuid !== conversationId);
      this.emit('conversations');
      if (this.#conversationId === conversationId) this.startNew();
    }

    #handleStreamEvent(event, { human, assistant, isNew, conversationId, prompt }) {
      switch (event.type) {
        case STREAM_START: {
          human.uuid = event.humanUuid;
          human.persisted = true;
          const reply = new ChatMessage({ uuid: event.assistantUuid, parentUuid: event.humanUuid, sender: 'assistant', streaming: true });
          if (isNew) this.#registerNewConversation(conversationId, prompt);
          this.#setMessages([...this.#messages, reply]);
          return reply;
        }
        case 'content_block_delta':
          if (assistant && event.delta?.type === 'text_delta') {
            assistant.appendText(event.delta.text);
            this.emit('message', assistant);
          }
          return assistant;
        case 'message_limit': {
          const windows = event.message_limit?.windows;
          if (windows) this.emit('messageLimit', { fiveHour: windows['5h'], sevenDay: windows['7d'] });
          return assistant;
        }
        case 'message_stop':
          if (assistant) {
            assistant.streaming = false;
            this.emit('message', assistant);
          }
          return assistant;
        default:
          return assistant;
      }
    }

    // Replaces the optimistic messages with the server's copy (real tool blocks, parent ids) and
    // feeds the stats index. After a failure the local error notice is kept on screen instead.
    async #reloadAfterSend(conversationId, { replaceMessages }) {
      try {
        const conversation = await this.#api.getConversation(conversationId);
        this.#updateConversationListing(conversation);
        this.emit('conversationLoaded', conversation);
        if (replaceMessages && this.#conversationId === conversationId && !this.#sending) {
          this.#setMessages(currentBranch(conversation).map(ChatMessage.fromApi));
        }
      } catch (error) {
        console.warn(LOG_PREFIX, 'refreshing conversation failed', error);
      }
    }

    #applyConversation(conversation) {
      this.#setMessages(currentBranch(conversation).map(ChatMessage.fromApi));
      this.emit('conversationLoaded', conversation);
    }

    #registerNewConversation(conversationId, prompt) {
      this.#conversations = [{ uuid: conversationId, name: prompt.slice(0, 60), updated_at: new Date().toISOString() }, ...this.#conversations];
      this.emit('conversations');
      this.#setActive(conversationId);
    }

    #updateConversationListing(conversation) {
      const existing = this.#conversations.find(c => c.uuid === conversation.uuid);
      if (!existing) return;
      const updated = { ...existing, name: conversation.name || existing.name, updated_at: conversation.updated_at ?? existing.updated_at };
      this.#conversations = [updated, ...this.#conversations.filter(c => c !== existing)];
      this.emit('conversations');
    }

    #lastPersistedUuid() {
      return this.#persistedUuidBefore(this.#messages.length);
    }

    #persistedUuidBefore(index) {
      for (let i = index - 1; i >= 0; i--) {
        if (this.#messages[i].persisted) return this.#messages[i].uuid;
      }
      return null;
    }

    #errorNotice(message) {
      return new ChatMessage({ uuid: localId(), sender: 'assistant', persisted: false, error: message });
    }

    #setActive(conversationId) {
      if (this.#conversationId === conversationId) return;
      this.#conversationId = conversationId;
      this.emit('active');
    }

    #setMessages(messages) {
      this.#messages = messages;
      this.emit('messages');
    }

    #setSending(sending) {
      this.#sending = sending;
      this.emit('sending');
    }
  }

  // Keeps the URL in sync with the open conversation and handles back/forward navigation.
  class Router {
    #store;

    constructor(store) {
      this.#store = store;
    }

    start() {
      window.addEventListener('popstate', () => this.#openFromLocation());
      this.#store.on('active', () => this.#syncLocation());
      return this.#openFromLocation();
    }

    openConversation(conversationId) {
      if (conversationIdFromPath(location.pathname) !== conversationId) history.pushState(null, '', chatPath(conversationId));
      return this.#store.open(conversationId);
    }

    startNewConversation() {
      if (location.pathname !== NEW_CHAT_PATH) history.pushState(null, '', NEW_CHAT_PATH);
      this.#store.startNew();
    }

    #openFromLocation() {
      const conversationId = conversationIdFromPath(location.pathname);
      return conversationId ? this.#store.open(conversationId) : this.#store.startNew();
    }

    // Store-initiated changes (a new conversation created, the open one deleted) replace the
    // current history entry rather than adding one.
    #syncLocation() {
      const activeId = this.#store.conversationId;
      const urlId = conversationIdFromPath(location.pathname);
      if (activeId === urlId) return;
      if (activeId) history.replaceState(null, '', chatPath(activeId));
      else if (urlId) history.replaceState(null, '', NEW_CHAT_PATH);
    }
  }

  // ============================================================================================
  // Statistics
  // ============================================================================================

  // Tools whose input describes a file Claude produced, mapped to how to read path and title.
  const FILE_PRODUCING_TOOLS = new Map([
    ['create_file', input => ({ path: input.path || input.file_path || '', title: input.description })],
    ['Artifact', input => ({ path: input.file_path || '', title: input.title })],
  ]);

  // Stored per conversation in IndexedDB. The shape is shared with claude-stats.user.js.
  function summarizeConversation(conversation) {
    const summary = {
      uuid: conversation.uuid,
      name: conversation.name || UNTITLED,
      updated_at: conversation.updated_at,
      turnCount: 0,
      toolCounts: Object.create(null),
      sources: [],
      files: [],
      estTokensIn: 0,
      estTokensOut: 0,
      responseTimesMs: [],
    };
    let pendingHumanAt = null;
    for (const message of conversation.chat_messages ?? []) {
      if (message.sender === 'human') {
        summary.turnCount += 1;
        summary.estTokensIn += estimateTokens(MessageContent.text(message));
        pendingHumanAt = message.created_at;
        for (const upload of MessageContent.uploads(message)) {
          const name = MessageContent.attachmentName(upload);
          summary.files.push({ path: name, title: name, ts: upload.created_at || message.created_at, source: 'user' });
        }
      } else if (message.sender === 'assistant') {
        summary.estTokensOut += estimateTokens(MessageContent.text(message));
        if (pendingHumanAt) {
          const responseMs = timestamp(message.created_at) - timestamp(pendingHumanAt);
          if (responseMs > 0 && responseMs < TIMING.maxResponseGapMs) summary.responseTimesMs.push(responseMs);
          pendingHumanAt = null;
        }
        collectAssistantBlocks(message, summary);
      }
    }
    return summary;
  }

  function collectAssistantBlocks(message, summary) {
    const filesByPath = new Map();
    for (const block of message.content ?? []) {
      const ts = block.stop_timestamp || message.created_at;
      if (block.type === 'tool_use') {
        const tool = block.name || 'unknown_tool';
        increment(summary.toolCounts, tool);
        const describe = FILE_PRODUCING_TOOLS.get(tool);
        if (describe && block.input) {
          const { path, title } = describe(block.input);
          filesByPath.set(path, { path, title: title || basename(path), ts, source: 'claude' });
        }
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const item of block.content) {
          if (item?.url && item.title) summary.sources.push({ title: item.title, url: item.url, ...hostParts(item.url), ts });
        }
      }
    }
    summary.files.push(...filesByPath.values());
  }

  function emptyAggregate() {
    return {
      conversationCount: 0,
      turnCount: 0,
      estTokensIn: 0,
      estTokensOut: 0,
      responseTimesMs: [],
      toolCounts: Object.create(null),
      domainCounts: Object.create(null),
      tlds: new Set(),
      sources: [], // newest first
      folders: [], // one per conversation with files, most recently active first
    };
  }

  function aggregateSummaries(summaries) {
    const aggregate = emptyAggregate();
    aggregate.conversationCount = summaries.length;
    for (const summary of summaries) {
      const origin = { conv: summary.name, convUuid: summary.uuid };
      aggregate.turnCount += summary.turnCount || 0;
      aggregate.estTokensIn += summary.estTokensIn || 0;
      aggregate.estTokensOut += summary.estTokensOut || 0;
      aggregate.responseTimesMs.push(...(summary.responseTimesMs ?? []));
      for (const [tool, count] of Object.entries(summary.toolCounts ?? {})) increment(aggregate.toolCounts, tool, count);
      for (const source of summary.sources ?? []) {
        aggregate.sources.push({ ...source, ...origin });
        if (source.outlet) increment(aggregate.domainCounts, source.outlet);
        if (source.tld) aggregate.tlds.add(source.tld);
      }
      if (summary.files?.length) {
        const files = summary.files.map(file => ({ ...file, ...origin, extension: fileExtension(file.title || file.path) }));
        aggregate.folders.push({ ...origin, files, latestTs: Math.max(...files.map(f => timestamp(f.ts))) });
      }
    }
    aggregate.sources.sort((a, b) => timestamp(b.ts) - timestamp(a.ts));
    aggregate.folders.sort((a, b) => b.latestTs - a.latestTs);
    return aggregate;
  }

  // Per-conversation summaries cached in IndexedDB plus their aggregate.
  // Events: 'change' (aggregate recomputed), 'backfill' (progress changed).
  class StatsIndex extends EventEmitter {
    #api;
    #db;
    #aggregate = emptyAggregate();
    #backfill = { running: false, done: 0, total: 0 };

    constructor(api, db) {
      super();
      this.#api = api;
      this.#db = db;
    }

    get aggregate() { return this.#aggregate; }
    get backfill() { return { ...this.#backfill }; }

    async refresh() {
      try {
        this.#aggregate = aggregateSummaries(await this.#db.getAll(DATABASE.stores.conversations));
        this.emit('change');
      } catch (error) {
        console.warn(LOG_PREFIX, 'reading stats failed', error);
      }
    }

    async index(conversation) {
      try {
        if (await this.#store(conversation)) await this.refresh();
      } catch (error) {
        console.warn(LOG_PREFIX, 'indexing conversation failed', error);
      }
    }

    // Fetches every conversation not yet indexed at its current version. Cancellable.
    async runBackfill() {
      if (this.#backfill.running) return;
      this.#setBackfill({ running: true, done: 0, total: 0 });
      try {
        const listings = await this.#listAllConversations();
        this.#setBackfill({ total: listings.length });
        let stored = 0;
        for (const listing of listings) {
          if (!this.#backfill.running) break;
          if (await this.#isStale(listing)) {
            await this.#store(await this.#api.getConversation(listing.uuid));
            if (++stored % BACKFILL_REFRESH_EVERY === 0) await this.refresh();
            await delay(TIMING.backfillDelayMs);
          }
          this.#setBackfill({ done: this.#backfill.done + 1 });
        }
      } catch (error) {
        console.warn(LOG_PREFIX, 'indexing history failed', error);
      } finally {
        this.#setBackfill({ running: false });
        await this.refresh();
      }
    }

    cancelBackfill() {
      if (this.#backfill.running) this.#setBackfill({ running: false });
    }

    async #listAllConversations() {
      const all = [];
      for (let offset = 0; ; offset += PAGE_SIZE.backfill) {
        const page = await this.#api.listConversations({ offset, limit: PAGE_SIZE.backfill });
        all.push(...page);
        if (page.length < PAGE_SIZE.backfill || !this.#backfill.running) return all;
      }
    }

    async #isStale(listing) {
      const existing = await this.#db.get(DATABASE.stores.conversations, listing.uuid);
      return !existing || existing.updated_at !== listing.updated_at;
    }

    async #store(conversation) {
      if (!(await this.#isStale(conversation))) return false;
      await this.#db.put(DATABASE.stores.conversations, summarizeConversation(conversation));
      return true;
    }

    #setBackfill(changes) {
      Object.assign(this.#backfill, changes);
      this.emit('backfill');
    }
  }

  // Counts time the tab is visible and receiving input. Persisted per day, flushed periodically.
  // Events: 'change' (every tick).
  class ActivityTracker extends EventEmitter {
    static #INPUT_EVENTS = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'];

    #db;
    #day = ActivityTracker.#today();
    #lastInputAt = Date.now();
    #unflushedMs = 0;
    todayMs = 0;
    totalMs = 0;
    idle = false;

    constructor(db) {
      super();
      this.#db = db;
    }

    static #today() {
      return new Date().toISOString().slice(0, 10);
    }

    async start() {
      try {
        const records = await this.#db.getAll(DATABASE.stores.activity);
        this.todayMs = records.find(r => r.day === this.#day)?.activeMs ?? 0;
        this.totalMs = records.reduce((sum, r) => sum + (r.activeMs || 0), 0);
      } catch (error) {
        console.warn(LOG_PREFIX, 'reading activity failed', error);
      }
      const onInput = () => { this.#lastInputAt = Date.now(); };
      for (const type of ActivityTracker.#INPUT_EVENTS) document.addEventListener(type, onInput, { passive: true });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.#flush(); });
      window.addEventListener('pagehide', () => this.#flush());
      setInterval(() => this.#tick(), TIMING.activityTickMs);
      setInterval(() => this.#flush(), TIMING.activityFlushMs);
      this.emit('change');
    }

    #tick() {
      const today = ActivityTracker.#today();
      if (today !== this.#day) {
        this.#flush();
        this.#day = today;
        this.todayMs = 0;
      }
      const recentInput = Date.now() - this.#lastInputAt <= TIMING.activityIdleMs;
      this.idle = !(recentInput && document.visibilityState === 'visible');
      if (!this.idle) {
        this.todayMs += TIMING.activityTickMs;
        this.totalMs += TIMING.activityTickMs;
        this.#unflushedMs += TIMING.activityTickMs;
      }
      this.emit('change');
    }

    // Adds (rather than overwrites) so several open tabs accumulate into the same day.
    async #flush() {
      if (this.#unflushedMs === 0) return;
      const day = this.#day;
      const ms = this.#unflushedMs;
      this.#unflushedMs = 0;
      try {
        await this.#db.update(DATABASE.stores.activity, day, record => ({ day, activeMs: (record?.activeMs ?? 0) + ms }));
      } catch (error) {
        if (day === this.#day) this.#unflushedMs += ms;
        console.warn(LOG_PREFIX, 'saving activity failed', error);
      }
    }
  }

  // Latest known usage windows, from polling and from message_limit stream events.
  // Events: 'change'.
  class RateLimitMonitor extends EventEmitter {
    #api;
    limits = null;

    constructor(api) {
      super();
      this.#api = api;
    }

    start() {
      this.#poll();
      setInterval(() => this.#poll(), TIMING.rateLimitPollMs);
    }

    update(limits) {
      this.limits = limits;
      this.emit('change');
    }

    async #poll() {
      try {
        this.update(await this.#api.getUsage());
      } catch {
        // Keep showing the last known values; the next poll retries.
      }
    }
  }

  // ============================================================================================
  // Panels
  // ============================================================================================

  // A dockable panel. Its DOM is built on first access and immediately rendered from current
  // state, so a panel opened late is never blank. Subclasses override template(), setup() and
  // render(), and scope every lookup to their own root via this.refs.
  class Panel {
    #root = null;
    refs = {};

    constructor(title) {
      this.title = title;
    }

    get isBuilt() {
      return this.#root !== null;
    }

    get element() {
      if (!this.#root) {
        this.#root = createElement('div', { className: 'cs-ui cs-panel-body', html: this.template() });
        this.refs = collectRefs(this.#root);
        this.setup();
        this.render();
      }
      return this.#root;
    }

    template() { return ''; }
    setup() {}
    render() {}
  }

  class SidebarPanel extends Panel {
    #store;
    #router;
    #query = '';

    constructor(store, router) {
      super('Chats');
      this.#store = store;
      this.#router = router;
    }

    template() {
      return `
        <button class="cs-primary-btn" data-ref="newChat">+ New chat</button>
        <input class="cs-search-input" data-ref="search" type="text" placeholder="Search chats…" />
        <div class="cs-scroll cs-grow" data-ref="list"></div>`;
    }

    setup() {
      this.refs.newChat.addEventListener('click', () => this.#router.startNewConversation());
      this.refs.search.addEventListener('input', () => {
        this.#query = this.refs.search.value.toLowerCase();
        this.render();
      });
      this.refs.list.addEventListener('click', event => this.#onListClick(event));
      this.#store.on('conversations', () => this.render());
      this.#store.on('active', () => this.render());
    }

    render() {
      const conversations = this.#query
        ? this.#store.conversations.filter(c => (c.name || '').toLowerCase().includes(this.#query))
        : this.#store.conversations;
      this.refs.list.innerHTML = conversations.map(c => this.#rowHtml(c)).join('')
        || emptyStateHtml(this.#query ? 'No chats match your search.' : 'No conversations yet.');
    }

    #rowHtml(conversation) {
      const active = conversation.uuid === this.#store.conversationId ? ' active' : '';
      const date = conversation.updated_at ? new Date(conversation.updated_at).toLocaleDateString() : '';
      return `
        <div class="cs-conv-row${active}" data-id="${escapeHtml(conversation.uuid)}">
          <div class="cs-conv-main">
            <div class="cs-conv-name">${escapeHtml(conversation.name || UNTITLED)}</div>
            <div class="cs-conv-date">${escapeHtml(date)}</div>
          </div>
          <button class="cs-conv-delete" title="Delete chat">🗑</button>
        </div>`;
    }

    #onListClick(event) {
      const row = event.target.closest('.cs-conv-row');
      if (!row) return;
      if (event.target.closest('.cs-conv-delete')) this.#confirmDelete(row);
      else this.#router.openConversation(row.dataset.id);
    }

    async #confirmDelete(row) {
      const conversationId = row.dataset.id;
      const name = this.#store.conversations.find(c => c.uuid === conversationId)?.name || UNTITLED;
      if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
      row.classList.add('cs-pending');
      try {
        await this.#store.delete(conversationId);
      } catch (error) {
        console.warn(LOG_PREFIX, 'delete failed', error);
        row.classList.remove('cs-pending');
      }
    }
  }

  class MessagesPanel extends Panel {
    #store;
    #pendingUpdates = new Set();
    #updateScheduler = new FrameScheduler(() => this.#flushUpdates());

    constructor(store) {
      super('Chat');
      this.#store = store;
    }

    template() {
      return '<div class="cs-scroll cs-grow cs-messages" data-ref="list"></div>';
    }

    setup() {
      this.refs.list.addEventListener('click', event => this.#onListClick(event));
      this.#store.on('messages', () => this.render());
      this.#store.on('sending', () => this.render());
      this.#store.on('message', message => this.#scheduleUpdate(message));
    }

    render() {
      this.#pendingUpdates.clear();
      this.#updateScheduler.cancel();
      const pinned = this.#isScrolledToBottom();
      const messages = this.#store.messages;
      const retryIndex = this.#store.sending ? -1 : messages.findLastIndex(m => m.sender === 'assistant');
      this.refs.list.innerHTML = messages.map((m, i) => this.#bubbleHtml(m, i, i === retryIndex)).join('')
        || '<div class="cs-empty cs-empty-padded">Start a conversation using the composer.</div>';
      if (pinned) this.#scrollToBottom();
    }

    // Streaming deltas only re-render the one affected bubble, at most once per frame.
    #scheduleUpdate(message) {
      this.#pendingUpdates.add(message);
      this.#updateScheduler.schedule();
    }

    #flushUpdates() {
      const pinned = this.#isScrolledToBottom();
      for (const message of this.#pendingUpdates) {
        const index = this.#store.messages.indexOf(message);
        const body = this.refs.list.querySelector(`[data-index="${index}"] .cs-bubble-body`);
        if (body) body.innerHTML = this.#bodyHtml(message);
      }
      this.#pendingUpdates.clear();
      if (pinned) this.#scrollToBottom();
    }

    #bubbleHtml(message, index, showRetry) {
      const role = message.sender === 'human' ? 'human' : 'assistant';
      const actions = message.streaming ? '' : `
        <div class="cs-bubble-actions">
          <button class="cs-bubble-action" data-action="copy" title="Copy">📋</button>
          ${showRetry ? '<button class="cs-bubble-action" data-action="retry" title="Retry">🔁 Retry</button>' : ''}
        </div>`;
      return `
        <div class="cs-bubble cs-bubble-${role}" data-index="${index}">
          <div class="cs-bubble-role">${role === 'human' ? 'You' : 'Claude'}</div>
          <div class="cs-bubble-body">${this.#bodyHtml(message)}</div>
          ${actions}
        </div>`;
    }

    #bodyHtml(message) {
      const error = message.error ? `<div class="cs-msg-error">Error: ${escapeHtml(message.error)}</div>` : '';
      const cursor = message.streaming ? '<span class="cs-cursor">▍</span>' : '';
      return `${message.html}${error}${cursor}`;
    }

    #onListClick(event) {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      if (button.dataset.action === 'retry') {
        this.#store.retry();
        return;
      }
      const message = this.#store.messages[Number(button.closest('.cs-bubble').dataset.index)];
      navigator.clipboard.writeText(message?.text || message?.error || '').catch(() => {});
      button.textContent = '✓';
      setTimeout(() => { button.textContent = '📋'; }, 1000);
    }

    #isScrolledToBottom() {
      const { list } = this.refs;
      return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    }

    #scrollToBottom() {
      this.refs.list.scrollTop = this.refs.list.scrollHeight;
    }
  }

  class ComposerPanel extends Panel {
    #store;
    #settings;

    constructor(store, settings) {
      super('Message');
      this.#store = store;
      this.#settings = settings;
    }

    template() {
      const extended = this.#settings.thinkingMode === THINKING_MODES.extended ? ' checked' : '';
      return `
        <div class="cs-composer-opts">
          <select data-ref="model">${optionsHtml(MODELS, this.#settings.model)}</select>
          <select data-ref="effort">${optionsHtml(EFFORTS, this.#settings.effort)}</select>
          <label class="cs-thinking-toggle"><input type="checkbox" data-ref="thinking"${extended} /> Extended thinking</label>
        </div>
        <textarea class="cs-composer-input" data-ref="input" placeholder="Message Claude…" rows="3"></textarea>
        <button class="cs-primary-btn cs-composer-send" data-ref="send">Send</button>`;
    }

    setup() {
      const { model, effort, thinking, input, send } = this.refs;
      model.addEventListener('change', () => { this.#settings.model = model.value; });
      effort.addEventListener('change', () => { this.#settings.effort = effort.value; });
      thinking.addEventListener('change', () => {
        this.#settings.thinkingMode = thinking.checked ? THINKING_MODES.extended : THINKING_MODES.off;
      });
      send.addEventListener('click', () => (this.#store.sending ? this.#store.stop() : this.#submit()));
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        this.#submit();
      });
      this.#store.on('sending', () => this.render());
    }

    render() {
      const { send } = this.refs;
      send.textContent = this.#store.sending ? 'Stop' : 'Send';
      send.classList.toggle('cs-stop-btn', this.#store.sending);
    }

    #submit() {
      const { input } = this.refs;
      if (!input.value.trim() || this.#store.sending) return;
      const prompt = input.value;
      input.value = '';
      this.#store.send(prompt);
    }
  }

  class StatsPanel extends Panel {
    #stats;
    #activity;
    #rateLimits;

    constructor(stats, activity, rateLimits) {
      super('Stats');
      this.#stats = stats;
      this.#activity = activity;
      this.#rateLimits = rateLimits;
    }

    template() {
      const row = (label, ref, initial) => `<div class="cs-row"><span>${label}</span><b data-ref="${ref}">${initial}</b></div>`;
      return `
        <div class="cs-section">${row('Active today', 'activeToday', '0s')}${row('Active all-time', 'activeTotal', '0s')}${row('Status', 'status', 'active')}</div>
        <div class="cs-section">${row('Turns (all chats)', 'turns', '0')}${row('Avg response time', 'responseTime', '–')}</div>
        <div class="cs-section">${row('Session limit (5h)', 'sessionLimit', '–')}${row('Weekly limit', 'weeklyLimit', '–')}</div>
        <div class="cs-section">${row('Est. tokens in / out', 'tokens', '–')}
          <div class="cs-hint">Estimated from text length — claude.ai doesn't expose real token counts.</div></div>
        <details class="cs-section" open><summary>Tool calls (<span data-ref="toolCount">0</span>)</summary><div class="cs-scroll" data-ref="tools"></div></details>
        <div class="cs-section">
          <button class="cs-primary-btn cs-full-width" data-ref="backfill">Index full history</button>
          <div class="cs-hint" data-ref="backfillStatus"></div>
          <div class="cs-spaced">${row('Conversations indexed', 'conversationCount', '0')}</div>
        </div>`;
    }

    setup() {
      this.refs.backfill.addEventListener('click', () => (this.#stats.backfill.running ? this.#stats.cancelBackfill() : this.#stats.runBackfill()));
      this.#activity.on('change', () => this.#renderActivity());
      this.#rateLimits.on('change', () => this.#renderRateLimits());
      this.#stats.on('change', () => this.#renderAggregate());
      this.#stats.on('backfill', () => this.#renderBackfill());
    }

    render() {
      this.#renderActivity();
      this.#renderRateLimits();
      this.#renderAggregate();
      this.#renderBackfill();
    }

    #renderActivity() {
      this.refs.activeToday.textContent = formatDuration(this.#activity.todayMs);
      this.refs.activeTotal.textContent = formatDuration(this.#activity.totalMs);
      this.refs.status.textContent = this.#activity.idle ? 'idle' : 'active';
    }

    #renderRateLimits() {
      const limits = this.#rateLimits.limits;
      if (!limits) return;
      this.refs.sessionLimit.textContent = formatUtilization(limits.fiveHour);
      this.refs.weeklyLimit.textContent = formatUtilization(limits.sevenDay);
    }

    #renderAggregate() {
      const aggregate = this.#stats.aggregate;
      const tools = sortedEntriesByCount(aggregate.toolCounts);
      this.refs.turns.textContent = aggregate.turnCount;
      this.refs.responseTime.textContent = aggregate.responseTimesMs.length ? formatDuration(average(aggregate.responseTimesMs)) : '–';
      this.refs.tokens.textContent = `~${aggregate.estTokensIn.toLocaleString()} in / ~${aggregate.estTokensOut.toLocaleString()} out`;
      this.refs.conversationCount.textContent = aggregate.conversationCount;
      this.refs.toolCount.textContent = tools.reduce((sum, [, count]) => sum + count, 0);
      this.refs.tools.innerHTML = tools.map(([name, count]) => `<div class="cs-row"><span>${escapeHtml(name)}</span><b>${count}</b></div>`).join('')
        || emptyStateHtml('No tool calls indexed yet.');
    }

    #renderBackfill() {
      const { running, done, total } = this.#stats.backfill;
      this.refs.backfill.textContent = running ? 'Cancel indexing' : 'Index full history';
      this.refs.backfillStatus.textContent = running ? `Indexing… ${done} / ${total}`
        : total ? `Last run: ${done} / ${total} indexed`
          : 'Not run yet — pulls every past conversation once.';
    }
  }

  class SourcesPanel extends Panel {
    #stats;

    constructor(stats) {
      super('Web Sources');
      this.#stats = stats;
    }

    template() {
      return `
        <div class="cs-filters">
          <select data-ref="tld"><option value="">All TLDs</option></select>
          <input data-ref="outlet" type="text" placeholder="Outlet contains…" />
        </div>
        <div class="cs-scroll cs-grow" data-ref="list"></div>
        <details class="cs-section"><summary>Top outlets (<span data-ref="outletCount">0</span>)</summary><div class="cs-scroll" data-ref="outlets"></div></details>`;
    }

    setup() {
      this.refs.tld.addEventListener('change', () => this.#renderList());
      this.refs.outlet.addEventListener('input', () => this.#renderList());
      this.#stats.on('change', () => this.render());
    }

    render() {
      this.#renderTldOptions();
      this.#renderList();
      this.#renderTopOutlets();
    }

    #renderTldOptions() {
      const { tld } = this.refs;
      const selected = tld.value;
      const tlds = [...this.#stats.aggregate.tlds].sort();
      tld.innerHTML = `<option value="">All TLDs</option>${tlds.map(t => `<option value="${escapeHtml(t)}">.${escapeHtml(t)}</option>`).join('')}`;
      tld.value = tlds.includes(selected) ? selected : '';
    }

    #renderList() {
      const tld = this.refs.tld.value;
      const outletQuery = this.refs.outlet.value.toLowerCase();
      const sources = this.#stats.aggregate.sources
        .filter(s => (!tld || s.tld === tld) && (!outletQuery || (s.outlet || '').toLowerCase().includes(outletQuery)))
        .slice(0, MAX_LISTED_SOURCES);
      this.refs.list.innerHTML = sources.map(s => this.#sourceHtml(s)).join('') || emptyStateHtml('No web sources match these filters.');
    }

    #sourceHtml(source) {
      const meta = [
        escapeHtml(source.outlet || ''),
        source.tld ? `.${escapeHtml(source.tld)}` : null,
        escapeHtml(new Date(source.ts).toLocaleString()),
        escapeHtml(source.conv || ''),
      ].filter(part => part !== null).join(' · ');
      return `<div class="cs-source-row"><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a><div class="cs-file-meta">${meta}</div></div>`;
    }

    #renderTopOutlets() {
      const counts = this.#stats.aggregate.domainCounts;
      this.refs.outletCount.textContent = Object.keys(counts).length;
      this.refs.outlets.innerHTML = sortedEntriesByCount(counts).slice(0, MAX_TOP_OUTLETS)
        .map(([outlet, count]) => `<div class="cs-row"><span>${escapeHtml(outlet)}</span><b>${count}</b></div>`).join('')
        || emptyStateHtml('No sources yet.');
    }
  }

  class FilesPanel extends Panel {
    static #SORT_KEYS = Object.freeze({
      name: file => (file.title || '').toLowerCase(),
      type: file => file.extension,
      date: file => timestamp(file.ts),
      source: file => file.source || '',
    });

    #stats;
    #openFolderId = null;
    #sort = { key: 'date', direction: -1 };

    constructor(stats) {
      super('Files');
      this.#stats = stats;
    }

    template() {
      return `
        <div class="cs-breadcrumb" data-ref="breadcrumb"></div>
        <div class="cs-scroll cs-grow cs-folder-grid" data-ref="folders"></div>
        <div class="cs-scroll cs-grow" data-ref="tableWrap" hidden>
          <table class="cs-files-table">
            <thead><tr><th data-sort="name">Name</th><th data-sort="type">Type</th><th data-sort="date">Date</th><th data-sort="source">Source</th></tr></thead>
            <tbody data-ref="rows"></tbody>
          </table>
        </div>`;
    }

    setup() {
      this.refs.breadcrumb.addEventListener('click', (event) => {
        if (event.target.closest('[data-action="back"]')) this.#openFolder(null);
      });
      this.refs.folders.addEventListener('dblclick', (event) => {
        const folder = event.target.closest('.cs-folder');
        if (folder) this.#openFolder(folder.dataset.conv);
      });
      this.refs.tableWrap.querySelector('thead').addEventListener('click', (event) => {
        const header = event.target.closest('th[data-sort]');
        if (header) this.#sortBy(header.dataset.sort);
      });
      this.#stats.on('change', () => this.render());
    }

    render() {
      const folder = this.#stats.aggregate.folders.find(f => f.convUuid === this.#openFolderId);
      if (folder) this.#renderTable(folder);
      else this.#renderFolders();
    }

    #openFolder(conversationId) {
      this.#openFolderId = conversationId;
      this.render();
    }

    #sortBy(key) {
      this.#sort = this.#sort.key === key ? { key, direction: -this.#sort.direction } : { key, direction: 1 };
      this.render();
    }

    #renderFolders() {
      this.#openFolderId = null;
      this.refs.breadcrumb.innerHTML = '<span>All folders</span>';
      this.refs.folders.hidden = false;
      this.refs.tableWrap.hidden = true;
      this.refs.folders.innerHTML = this.#stats.aggregate.folders.map(folder => `
        <div class="cs-folder" data-conv="${escapeHtml(folder.convUuid)}" title="${escapeHtml(folder.conv)}">
          <div class="cs-folder-icon">📁</div>
          <div class="cs-folder-name">${escapeHtml(folder.conv)}</div>
          <div class="cs-folder-count">${folder.files.length} file${folder.files.length === 1 ? '' : 's'}</div>
        </div>`).join('') || emptyStateHtml('No files or attachments indexed yet.');
    }

    #renderTable(folder) {
      this.refs.breadcrumb.innerHTML = `<span class="cs-breadcrumb-link" data-action="back">← All folders</span> / ${escapeHtml(folder.conv)}`;
      this.refs.folders.hidden = true;
      this.refs.tableWrap.hidden = false;
      const valueOf = FilesPanel.#SORT_KEYS[this.#sort.key];
      const files = [...folder.files].sort((a, b) => {
        const [va, vb] = [valueOf(a), valueOf(b)];
        return (va < vb ? -1 : va > vb ? 1 : 0) * this.#sort.direction;
      });
      this.refs.rows.innerHTML = files.map(file => `
        <tr>
          <td>${escapeHtml(file.title || '(file)')}</td>
          <td>${escapeHtml(file.extension)}</td>
          <td>${escapeHtml(new Date(file.ts).toLocaleString())}</td>
          <td>${file.source === 'user' ? 'User' : 'Claude'}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="cs-empty">No files here.</td></tr>';
    }
  }

  // ============================================================================================
  // Dock layout model (pure data; no DOM)
  // ============================================================================================

  // A tree of splits (row/column, with fractional sizes) whose leaves hold tabbed panels.
  class DockTree {
    constructor(root) {
      this.root = root;
    }

    static createDefault() {
      return new DockTree({
        type: 'split', dir: 'row', sizes: [0.18, 0.62, 0.2],
        children: [
          DockTree.#leaf(['sidebar'], 'leaf-sidebar'),
          {
            type: 'split', dir: 'column', sizes: [0.78, 0.22],
            children: [DockTree.#leaf(['messages'], 'leaf-messages'), DockTree.#leaf(['composer'], 'leaf-composer')],
          },
          DockTree.#leaf(['stats', 'sources', 'files'], 'leaf-extras'),
        ],
      });
    }

    // Rebuilds a stored tree, dropping anything malformed, unknown or duplicated.
    static fromJSON(json, knownPanelIds) {
      const root = DockTree.#sanitize(json, new Set(knownPanelIds), new Set());
      return root ? new DockTree(root) : DockTree.createDefault();
    }

    toJSON() {
      return this.root;
    }

    findLeaf(leafId) {
      return this.#find(node => node.type === 'leaf' && node.id === leafId)?.node ?? null;
    }

    leafOf(panelId) {
      return this.#find(node => node.type === 'leaf' && node.tabs.includes(panelId))?.node ?? null;
    }

    firstLeaf() {
      return this.#find(node => node.type === 'leaf').node;
    }

    activate(leafId, panelId) {
      const leaf = this.findLeaf(leafId);
      if (leaf?.tabs.includes(panelId)) leaf.active = panelId;
    }

    removePanel(panelId) {
      const leaf = this.leafOf(panelId);
      if (!leaf) return;
      leaf.tabs = leaf.tabs.filter(tab => tab !== panelId);
      if (leaf.active === panelId) leaf.active = leaf.tabs[0] ?? null;
      if (leaf.tabs.length === 0 && leaf !== this.root) this.#removeNode(leaf);
    }

    // region: 'center' adds a tab to the target; 'left' | 'right' | 'top' | 'bottom' splits it.
    dock(panelId, targetLeafId, region) {
      const source = this.leafOf(panelId);
      if (source?.id === targetLeafId && (region === 'center' || source.tabs.length === 1)) {
        source.active = panelId; // Dropped onto its own zone: nothing moves.
        return;
      }
      this.removePanel(panelId);
      const target = this.findLeaf(targetLeafId);
      if (!target || region === 'center') {
        const leaf = target ?? this.firstLeaf();
        leaf.tabs.push(panelId);
        leaf.active = panelId;
        return;
      }
      const leaf = DockTree.#leaf([panelId]);
      const before = region === 'left' || region === 'top';
      this.#replaceNode(target, {
        type: 'split', dir: DockTree.#directionFor(region), sizes: [0.5, 0.5],
        children: before ? [leaf, target] : [target, leaf],
      });
    }

    // Docks a panel along an outer edge of the whole workspace.
    dockAtEdge(panelId, edge) {
      if (this.root.type === 'leaf' && this.root.tabs.length === 1 && this.root.tabs[0] === panelId) return;
      this.removePanel(panelId);
      const leaf = DockTree.#leaf([panelId]);
      const before = edge === 'left' || edge === 'top';
      const small = LAYOUT.edgeDockFraction;
      this.root = {
        type: 'split', dir: DockTree.#directionFor(edge),
        sizes: before ? [small, 1 - small] : [1 - small, small],
        children: before ? [leaf, this.root] : [this.root, leaf],
      };
    }

    // Moves the boundary after child `index` of `split` by deltaFraction of the split's extent,
    // keeping both neighbours at least LAYOUT.minSplitFraction.
    resize(split, index, startSizes, deltaFraction) {
      const pair = startSizes[index] + startSizes[index + 1];
      const first = clamp(startSizes[index] + deltaFraction, LAYOUT.minSplitFraction, pair - LAYOUT.minSplitFraction);
      split.sizes[index] = first;
      split.sizes[index + 1] = pair - first;
    }

    // Pixel rects for every leaf and every divider between split children, in one walk.
    layout(bounds) {
      const leaves = [];
      const dividers = [];
      const walk = (node, rect) => {
        if (node.type === 'leaf') {
          leaves.push({ leaf: node, rect });
          return;
        }
        const horizontal = node.dir === 'row';
        const extent = horizontal ? rect.w : rect.h;
        let offset = horizontal ? rect.x : rect.y;
        node.children.forEach((child, index) => {
          const size = extent * node.sizes[index];
          walk(child, horizontal ? { x: offset, y: rect.y, w: size, h: rect.h } : { x: rect.x, y: offset, w: rect.w, h: size });
          offset += size;
          if (index < node.children.length - 1) dividers.push({ split: node, index, rect, position: offset });
        });
      };
      walk(this.root, bounds);
      return { leaves, dividers };
    }

    #find(predicate, node = this.root, parent = null) {
      if (predicate(node)) return { node, parent };
      if (node.type !== 'split') return null;
      for (const child of node.children) {
        const found = this.#find(predicate, child, node);
        if (found) return found;
      }
      return null;
    }

    #replaceNode(node, replacement) {
      const { parent } = this.#find(candidate => candidate === node);
      if (parent) parent.children[parent.children.indexOf(node)] = replacement;
      else this.root = replacement;
    }

    // Removes a node from its split; a split left with one child is replaced by that child.
    #removeNode(node) {
      const { parent } = this.#find(candidate => candidate === node);
      const index = parent.children.indexOf(node);
      parent.children.splice(index, 1);
      parent.sizes.splice(index, 1);
      parent.sizes = DockTree.#normalize(parent.sizes);
      if (parent.children.length === 1) this.#replaceNode(parent, parent.children[0]);
    }

    static #leaf(tabs, id = `leaf-${crypto.randomUUID()}`) {
      return { type: 'leaf', id, tabs: [...tabs], active: tabs[0] ?? null };
    }

    static #directionFor(side) {
      return side === 'left' || side === 'right' ? 'row' : 'column';
    }

    static #normalize(sizes) {
      const total = sizes.reduce((sum, s) => sum + s, 0);
      return total > 0 ? sizes.map(s => s / total) : sizes.map(() => 1 / sizes.length);
    }

    static #sanitize(node, known, placed) {
      if (!node || typeof node !== 'object') return null;
      if (node.type === 'leaf') {
        const tabs = (Array.isArray(node.tabs) ? node.tabs : []).filter(id => known.has(id) && !placed.has(id));
        if (tabs.length === 0) return null;
        tabs.forEach(id => placed.add(id));
        const leaf = DockTree.#leaf(tabs, typeof node.id === 'string' ? node.id : undefined);
        leaf.active = tabs.includes(node.active) ? node.active : tabs[0];
        return leaf;
      }
      if (node.type !== 'split' || !Array.isArray(node.children)) return null;
      const children = [];
      const sizes = [];
      node.children.forEach((child, index) => {
        const clean = DockTree.#sanitize(child, known, placed);
        if (!clean) return;
        children.push(clean);
        const size = node.sizes?.[index];
        sizes.push(Number.isFinite(size) && size > 0 ? size : 1);
      });
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return { type: 'split', dir: node.dir === 'column' ? 'column' : 'row', sizes: DockTree.#normalize(sizes), children };
    }
  }

  // ============================================================================================
  // Dock workspace (renders the tree, positions panels, handles tab and divider dragging)
  // ============================================================================================

  class DockWorkspace {
    #panels;
    #preferences;
    #tree;
    #chromeLayer;
    #dividerLayer;
    #leafRects = [];
    #layoutScheduler = new FrameScheduler(() => this.layout());

    constructor(panels, preferences) {
      this.#panels = panels;
      this.#preferences = preferences;
      this.#tree = DockTree.fromJSON(preferences.getJson(STORAGE_KEYS.dockTree), panels.keys());
    }

    mount() {
      this.#chromeLayer = createElement('div', { className: 'cs-ui cs-chrome-layer' });
      this.#dividerLayer = createElement('div', { className: 'cs-divider-layer' });
      document.body.append(this.#chromeLayer, this.#dividerLayer);
      window.addEventListener('resize', () => this.#layoutScheduler.schedule());
      this.layout();
    }

    resetLayout() {
      this.#preferences.remove(STORAGE_KEYS.dockTree);
      this.#tree = DockTree.createDefault();
      this.layout();
    }

    layout() {
      const { leaves, dividers } = this.#tree.layout(this.#bounds());
      this.#leafRects = leaves;
      this.#chromeLayer.replaceChildren();
      this.#dividerLayer.replaceChildren();
      const visible = new Set();
      for (const { leaf, rect } of leaves) {
        this.#renderLeafChrome(leaf, rect);
        if (!leaf.active) continue;
        this.#showPanel(leaf.active, { x: rect.x, y: rect.y + LAYOUT.tabStripHeight, w: rect.w, h: rect.h - LAYOUT.tabStripHeight });
        visible.add(leaf.active);
      }
      for (const [id, panel] of this.#panels) {
        if (!visible.has(id) && panel.isBuilt) panel.element.style.visibility = 'hidden';
      }
      for (const divider of dividers) this.#renderDivider(divider);
    }

    #commit() {
      this.layout();
      this.#preferences.setJson(STORAGE_KEYS.dockTree, this.#tree);
    }

    #bounds() {
      return { x: 0, y: LAYOUT.toolbarHeight, w: window.innerWidth, h: window.innerHeight - LAYOUT.toolbarHeight };
    }

    #showPanel(panelId, rect) {
      const panel = this.#panels.get(panelId);
      if (!panel) return;
      const { element } = panel;
      if (!element.isConnected) document.body.append(element);
      placeElement(element, rect);
      element.style.visibility = 'visible';
    }

    #renderLeafChrome(leaf, rect) {
      const frame = createElement('div', { className: 'cs-frame' });
      placeElement(frame, rect);
      const strip = createElement('div', { className: 'cs-tabstrip' });
      placeElement(strip, { ...rect, h: LAYOUT.tabStripHeight });
      for (const panelId of leaf.tabs) {
        const tab = createElement('div', {
          className: `cs-tab${panelId === leaf.active ? ' cs-tab-active' : ''}`,
          text: this.#panels.get(panelId)?.title ?? panelId,
        });
        tab.addEventListener('mousedown', (event) => { if (event.button === 0) this.#startTabDrag(event, panelId); });
        tab.addEventListener('click', () => {
          this.#tree.activate(leaf.id, panelId);
          this.#commit();
        });
        strip.append(tab);
      }
      const add = createElement('div', { className: 'cs-tab-add', text: '+', title: 'Add panel to this zone' });
      add.addEventListener('click', event => this.#showAddPanelMenu(event, leaf.id));
      strip.append(add);
      this.#chromeLayer.append(frame, strip);
    }

    #renderDivider({ split, index, rect, position }) {
      const horizontal = split.dir === 'row';
      const half = LAYOUT.dividerThickness / 2;
      const divider = createElement('div', { className: `cs-divider ${horizontal ? 'cs-divider-row' : 'cs-divider-column'}` });
      placeElement(divider, horizontal
        ? { x: position - half, y: rect.y, w: LAYOUT.dividerThickness, h: rect.h }
        : { x: rect.x, y: position - half, w: rect.w, h: LAYOUT.dividerThickness });
      divider.addEventListener('mousedown', (event) => {
        event.preventDefault();
        this.#startDividerDrag(event, { split, index, extent: horizontal ? rect.w : rect.h, horizontal });
      });
      this.#dividerLayer.append(divider);
    }

    #startDividerDrag(startEvent, { split, index, extent, horizontal }) {
      const startSizes = [...split.sizes];
      const startPosition = horizontal ? startEvent.clientX : startEvent.clientY;
      document.documentElement.classList.add(horizontal ? 'cs-resizing-row' : 'cs-resizing-column');
      trackDrag(startEvent, {
        onMove: (event) => {
          const position = horizontal ? event.clientX : event.clientY;
          this.#tree.resize(split, index, startSizes, (position - startPosition) / extent);
          this.#layoutScheduler.schedule();
        },
        onEnd: () => {
          document.documentElement.classList.remove('cs-resizing-row', 'cs-resizing-column');
          this.#layoutScheduler.cancel();
          this.#commit();
        },
      });
    }

    #startTabDrag(startEvent, panelId) {
      startEvent.preventDefault();
      const ghost = createElement('div', { className: 'cs-ui cs-drag-ghost', text: this.#panels.get(panelId)?.title ?? panelId });
      const overlay = createElement('div', { className: 'cs-drop-overlay' });
      ghost.hidden = true;
      overlay.hidden = true;
      document.body.append(ghost, overlay);
      let target = null;
      trackDrag(startEvent, {
        threshold: LAYOUT.dragThreshold,
        onMove: (event) => {
          ghost.hidden = false;
          Object.assign(ghost.style, { left: `${event.clientX + 12}px`, top: `${event.clientY + 12}px` });
          target = this.#dropTargetAt(event.clientX, event.clientY);
          overlay.hidden = !target;
          if (target) placeElement(overlay, target.rect);
        },
        onEnd: (event, dragged) => {
          ghost.remove();
          overlay.remove();
          if (!dragged || !target) return;
          if (target.edge) this.#tree.dockAtEdge(panelId, target.edge);
          else this.#tree.dock(panelId, target.leafId, target.region);
          this.#commit();
        },
      });
    }

    // Near an outer edge of the workspace → dock along that edge; otherwise the hovered leaf's
    // center (tab) or one of its four sides (split). Returns the target and its highlight rect.
    #dropTargetAt(x, y) {
      const bounds = this.#bounds();
      const edge = this.#outerEdgeAt(x, y, bounds);
      if (edge) return { edge, rect: this.#edgeHighlight(edge, bounds) };
      const hit = this.#leafRects.find(({ rect }) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h);
      if (!hit) return null;
      const { leaf, rect } = hit;
      const region = this.#regionAt((x - rect.x) / rect.w, (y - rect.y) / rect.h);
      return { leafId: leaf.id, region, rect: this.#regionHighlight(region, rect) };
    }

    #outerEdgeAt(x, y, bounds) {
      const margin = LAYOUT.edgeDropMargin;
      if (x - bounds.x < margin) return 'left';
      if (bounds.x + bounds.w - x < margin) return 'right';
      if (y - bounds.y < margin) return 'top';
      if (bounds.y + bounds.h - y < margin) return 'bottom';
      return null;
    }

    #edgeHighlight(edge, bounds) {
      const w = Math.min(bounds.w * LAYOUT.edgeDockFraction, 280);
      const h = Math.min(bounds.h * LAYOUT.edgeDockFraction, 220);
      switch (edge) {
        case 'left': return { ...bounds, w };
        case 'right': return { ...bounds, x: bounds.x + bounds.w - w, w };
        case 'top': return { ...bounds, h };
        default: return { ...bounds, y: bounds.y + bounds.h - h, h };
      }
    }

    #regionAt(relX, relY) {
      const edge = LAYOUT.dropRegionFraction;
      if (relY < edge) return 'top';
      if (relY > 1 - edge) return 'bottom';
      if (relX < edge) return 'left';
      if (relX > 1 - edge) return 'right';
      return 'center';
    }

    #regionHighlight(region, rect) {
      const halfW = rect.w / 2;
      const halfH = rect.h / 2;
      switch (region) {
        case 'top': return { ...rect, h: halfH };
        case 'bottom': return { ...rect, y: rect.y + halfH, h: halfH };
        case 'left': return { ...rect, w: halfW };
        case 'right': return { ...rect, x: rect.x + halfW, w: halfW };
        default: return rect;
      }
    }

    #showAddPanelMenu(event, leafId) {
      document.querySelector('.cs-add-menu')?.remove();
      const available = [...this.#panels.keys()].filter(id => !this.#tree.leafOf(id));
      if (available.length === 0) return;
      const menu = createElement('div', {
        className: 'cs-ui cs-add-menu',
        html: available.map(id => `<div class="cs-add-menu-item" data-id="${escapeHtml(id)}">${escapeHtml(this.#panels.get(id).title)}</div>`).join(''),
      });
      Object.assign(menu.style, { left: `${event.clientX}px`, top: `${event.clientY}px` });
      const close = () => {
        menu.remove();
        document.removeEventListener('mousedown', onOutsideClick, true);
      };
      const onOutsideClick = (e) => { if (!menu.contains(e.target)) close(); };
      menu.addEventListener('click', (e) => {
        const item = e.target.closest('.cs-add-menu-item');
        if (!item) return;
        this.#tree.dock(item.dataset.id, leafId, 'center');
        close();
        this.#commit();
      });
      document.body.append(menu);
      document.addEventListener('mousedown', onOutsideClick, true);
    }
  }

  // ============================================================================================
  // Toolbar
  // ============================================================================================

  class Toolbar {
    static #FONT_SIZE = Object.freeze({ min: 11, max: 24, default: 14 });

    #preferences;
    #workspace;
    #fontSize;

    constructor(preferences, workspace) {
      this.#preferences = preferences;
      this.#workspace = workspace;
      const stored = Number.parseFloat(preferences.get(STORAGE_KEYS.fontSize));
      const { min, max } = Toolbar.#FONT_SIZE;
      this.#fontSize = Number.isFinite(stored) ? clamp(stored, min, max) : Toolbar.#FONT_SIZE.default;
    }

    mount() {
      const { min, max } = Toolbar.#FONT_SIZE;
      const bar = createElement('div', {
        className: 'cs-ui cs-toolbar',
        html: `
          <div class="cs-toolbar-title">ClaudePlus</div>
          <label class="cs-slider-wrap">
            <span>Aa</span>
            <input type="range" data-ref="fontSize" min="${min}" max="${max}" step="1" value="${this.#fontSize}">
            <span data-ref="fontSizeLabel"></span>
          </label>
          <div class="cs-grow"></div>
          <button class="cs-tb-btn" data-ref="reset">Reset layout</button>`,
      });
      const refs = collectRefs(bar);
      refs.fontSize.addEventListener('input', () => {
        this.#fontSize = Number.parseFloat(refs.fontSize.value);
        this.#preferences.set(STORAGE_KEYS.fontSize, this.#fontSize);
        this.#applyFontSize(refs.fontSizeLabel);
      });
      refs.reset.addEventListener('click', () => this.#workspace.resetLayout());
      this.#applyFontSize(refs.fontSizeLabel);
      document.body.append(bar);
    }

    #applyFontSize(label) {
      document.documentElement.style.setProperty('--cs-msg-font-size', `${this.#fontSize}px`);
      label.textContent = `${this.#fontSize}px`;
    }
  }

  // ============================================================================================
  // Styles
  // ============================================================================================

  const STYLES = `
    /* The only thing done to claude.ai's own UI: hide its two top-level mount points. Nothing
       inside them is ever queried, read, or touched. */
    #root, #portal-root { display: none !important; }

    :root {
      --cs-bg: #1a1918;
      --cs-bg-bar: #1c1b1a;
      --cs-bg-raised: #262523;
      --cs-bg-raised-hover: #3a3937;
      --cs-bg-human: #2a2927;
      --cs-bg-tool: #232221;
      --cs-bg-code: #101010;
      --cs-bg-button: #333;
      --cs-bg-button-hover: #444;
      --cs-text: #ececec;
      --cs-text-muted: #b8b6b3;
      --cs-text-faint: #8a8886;
      --cs-accent: #d97757;
      --cs-accent-soft: rgba(217, 119, 87, 0.18);
      --cs-accent-overlay: rgba(217, 119, 87, 0.35);
      --cs-error: #e57373;
      --cs-border-faint: rgba(255, 255, 255, 0.05);
      --cs-border: rgba(255, 255, 255, 0.08);
      --cs-border-strong: rgba(255, 255, 255, 0.12);
      --cs-hover: rgba(255, 255, 255, 0.06);
      --cs-font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --cs-z-chrome: 2147480000;
      --cs-z-panel: 2147480500;
      --cs-z-divider: 2147480600;
      --cs-z-toolbar: 2147483000;
      --cs-z-menu: 2147483001;
      --cs-z-drop: 2147483646;
      --cs-z-ghost: 2147483647;
    }
    .cs-ui { font-family: var(--cs-font); color: var(--cs-text); }
    .cs-ui [hidden], .cs-ui[hidden] { display: none !important; }
    html.cs-resizing-row, html.cs-resizing-row * { cursor: col-resize !important; user-select: none; }
    html.cs-resizing-column, html.cs-resizing-column * { cursor: row-resize !important; user-select: none; }

    /* Toolbar */
    .cs-toolbar { position: fixed; top: 0; left: 0; right: 0; height: ${LAYOUT.toolbarHeight}px; z-index: var(--cs-z-toolbar); background: var(--cs-bg-bar); border-bottom: 1px solid var(--cs-border-strong); display: flex; align-items: center; gap: 14px; padding: 0 10px; font-size: 12px; box-sizing: border-box; }
    .cs-toolbar-title { font-weight: 600; }
    .cs-tb-btn { background: var(--cs-bg-button); border: none; color: var(--cs-text); padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .cs-tb-btn:hover { background: var(--cs-bg-button-hover); }
    .cs-slider-wrap { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .cs-slider-wrap input[type=range] { width: 100px; }

    /* Dock chrome */
    .cs-chrome-layer { position: fixed; inset: 0; pointer-events: none; z-index: var(--cs-z-chrome); }
    .cs-frame { position: fixed; background: var(--cs-bg); border: 1px solid var(--cs-border); box-sizing: border-box; }
    .cs-tabstrip { position: fixed; display: flex; align-items: center; background: var(--cs-bg-bar); border-bottom: 1px solid var(--cs-border); overflow-x: auto; box-sizing: border-box; pointer-events: auto; }
    .cs-tab { padding: 5px 12px; font-size: 12px; color: var(--cs-text-muted); cursor: pointer; white-space: nowrap; border-right: 1px solid var(--cs-border-faint); user-select: none; }
    .cs-tab-active { color: var(--cs-text); border-bottom: 2px solid var(--cs-accent); }
    .cs-tab-add { padding: 5px 10px; cursor: pointer; color: var(--cs-text-faint); user-select: none; }
    .cs-tab-add:hover { color: var(--cs-text); }
    .cs-divider-layer { position: fixed; inset: 0; pointer-events: none; z-index: var(--cs-z-divider); }
    .cs-divider { position: fixed; pointer-events: auto; background: transparent; }
    .cs-divider-row { cursor: col-resize; }
    .cs-divider-column { cursor: row-resize; }
    .cs-divider:hover { background: var(--cs-accent); }
    .cs-drag-ghost { position: fixed; z-index: var(--cs-z-ghost); background: var(--cs-accent); color: #fff; padding: 4px 10px; border-radius: 6px; font-size: 12px; pointer-events: none; }
    .cs-drop-overlay { position: fixed; z-index: var(--cs-z-drop); background: var(--cs-accent-overlay); border: 2px solid var(--cs-accent); pointer-events: none; box-sizing: border-box; }
    .cs-add-menu { position: fixed; z-index: var(--cs-z-menu); background: var(--cs-bg-raised); border: 1px solid var(--cs-border-strong); border-radius: 6px; padding: 4px; min-width: 140px; font-size: 12px; }
    .cs-add-menu-item { padding: 6px 10px; cursor: pointer; border-radius: 4px; }
    .cs-add-menu-item:hover { background: var(--cs-bg-raised-hover); }

    /* Panels (shared) */
    .cs-panel-body { position: fixed; z-index: var(--cs-z-panel); box-sizing: border-box; padding: 10px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; font-size: 13px; background: var(--cs-bg); }
    .cs-panel-body summary { cursor: pointer; padding: 4px 0; }
    .cs-panel-body select, .cs-panel-body input[type=text], .cs-panel-body textarea { background: var(--cs-bg-bar); border: 1px solid var(--cs-border-strong); border-radius: 6px; color: var(--cs-text); font-size: 12px; font-family: inherit; }
    .cs-section { padding: 8px 0; border-bottom: 1px solid var(--cs-hover); flex-shrink: 0; }
    .cs-section:last-child { border-bottom: none; }
    .cs-row { display: flex; justify-content: space-between; padding: 2px 0; gap: 8px; }
    .cs-row span { color: var(--cs-text-muted); }
    .cs-spaced { margin-top: 6px; }
    .cs-hint { color: var(--cs-text-faint); font-size: 11px; margin-top: 4px; }
    .cs-scroll { overflow-y: auto; }
    .cs-grow { flex: 1; min-height: 0; }
    .cs-empty { color: var(--cs-text-faint); font-style: italic; padding: 6px 0; }
    .cs-empty-padded { padding: 24px; }
    .cs-pending { opacity: 0.4; pointer-events: none; }
    .cs-primary-btn { padding: 8px; background: var(--cs-accent); border: none; border-radius: 6px; color: #fff; font-size: 13px; cursor: pointer; font-weight: 600; flex-shrink: 0; }
    .cs-primary-btn:disabled { opacity: 0.6; cursor: default; }
    .cs-full-width { width: 100%; }

    /* Sidebar */
    .cs-search-input { flex-shrink: 0; padding: 6px 8px; }
    .cs-conv-row { padding: 8px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 4px; }
    .cs-conv-row:hover { background: var(--cs-hover); }
    .cs-conv-row:hover .cs-conv-delete { visibility: visible; }
    .cs-conv-row.active { background: var(--cs-accent-soft); }
    .cs-conv-main { flex: 1; min-width: 0; }
    .cs-conv-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cs-conv-date { font-size: 11px; color: var(--cs-text-faint); }
    .cs-conv-delete { visibility: hidden; background: none; border: none; cursor: pointer; font-size: 12px; padding: 4px; border-radius: 4px; flex-shrink: 0; }
    .cs-conv-delete:hover { background: rgba(255, 255, 255, 0.1); }

    /* Messages */
    .cs-messages { display: flex; flex-direction: column; gap: 14px; }
    .cs-bubble { padding: 10px 12px; border-radius: 8px; max-width: 100%; }
    .cs-bubble-human { background: var(--cs-bg-human); align-self: flex-end; }
    .cs-bubble-assistant { background: transparent; }
    .cs-bubble-role { font-size: 11px; color: var(--cs-text-faint); margin-bottom: 4px; font-weight: 600; }
    .cs-bubble-body { font-size: var(--cs-msg-font-size, 14px); line-height: 1.5; overflow-wrap: break-word; }
    .cs-msg-text { white-space: normal; }
    .cs-msg-text a { color: var(--cs-accent); }
    .cs-msg-file { color: var(--cs-text-muted); font-size: 12px; margin-bottom: 4px; }
    .cs-msg-tool { margin: 6px 0; background: var(--cs-bg-tool); border-radius: 6px; padding: 4px 8px; font-size: 12px; }
    .cs-msg-tool pre { white-space: pre-wrap; overflow-wrap: break-word; font-size: 11px; color: var(--cs-text-muted); }
    .cs-msg-error { color: var(--cs-error); margin-top: 6px; }
    .cs-code { background: var(--cs-bg-code); padding: 8px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
    .cs-cursor { animation: cs-blink 1s step-start infinite; }
    @keyframes cs-blink { 50% { opacity: 0; } }
    .cs-bubble-actions { display: flex; gap: 8px; margin-top: 6px; }
    .cs-bubble-action { background: none; border: none; color: var(--cs-text-faint); cursor: pointer; font-size: 11px; padding: 2px 6px; border-radius: 4px; }
    .cs-bubble-action:hover { background: var(--cs-border); color: var(--cs-text); }

    /* Composer */
    .cs-composer-opts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; flex-shrink: 0; }
    .cs-composer-opts select { padding: 4px 6px; }
    .cs-thinking-toggle { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--cs-text-muted); cursor: pointer; }
    .cs-panel-body .cs-composer-input { flex: 1; resize: none; border-radius: 8px; padding: 8px; font-size: 14px; }
    .cs-composer-send.cs-stop-btn { background: var(--cs-bg-button-hover); }

    /* Web sources */
    .cs-filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; flex-shrink: 0; }
    .cs-filters select, .cs-filters input[type=text] { flex: 1; min-width: 100px; padding: 5px 6px; }
    .cs-source-row { padding: 6px 0; border-top: 1px solid var(--cs-border-faint); }
    .cs-source-row:first-child { border-top: none; }
    .cs-source-row a { color: var(--cs-accent); text-decoration: none; }
    .cs-source-row a:hover { text-decoration: underline; }
    .cs-file-meta { color: var(--cs-text-faint); font-size: 11px; margin-top: 2px; }

    /* Files */
    .cs-folder-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 10px; align-content: start; }
    .cs-folder { display: flex; flex-direction: column; align-items: center; text-align: center; cursor: pointer; padding: 8px 4px; border-radius: 8px; }
    .cs-folder:hover { background: var(--cs-hover); }
    .cs-folder-icon { font-size: 28px; }
    .cs-folder-name { font-size: 11px; margin-top: 4px; overflow-wrap: anywhere; }
    .cs-folder-count { font-size: 10px; color: var(--cs-text-faint); }
    .cs-breadcrumb { font-size: 12px; color: var(--cs-text-muted); margin-bottom: 6px; flex-shrink: 0; }
    .cs-breadcrumb-link { color: var(--cs-accent); cursor: pointer; }
    .cs-files-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .cs-files-table th { text-align: left; cursor: pointer; padding: 4px 6px; color: var(--cs-text-muted); border-bottom: 1px solid var(--cs-border-strong); position: sticky; top: 0; background: var(--cs-bg-raised); }
    .cs-files-table td { padding: 4px 6px; border-bottom: 1px solid var(--cs-border-faint); }
  `;

  // ============================================================================================
  // Application
  // ============================================================================================

  class ClaudePlusApp {
    async start() {
      document.head.append(createElement('style', { text: STYLES }));

      const preferences = new Preferences();
      const api = new ClaudeApi();
      const db = new IndexedDbStore({
        name: DATABASE.name,
        version: DATABASE.version,
        upgrade: (database) => {
          for (const [store, keyPath] of [[DATABASE.stores.conversations, 'uuid'], [DATABASE.stores.activity, 'day']]) {
            if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath });
          }
        },
      });

      const settings = new ComposerSettings(preferences);
      const store = new ConversationStore(api, settings);
      const router = new Router(store);
      const stats = new StatsIndex(api, db);
      const activity = new ActivityTracker(db);
      const rateLimits = new RateLimitMonitor(api);

      store.on('conversationLoaded', conversation => stats.index(conversation));
      store.on('messageLimit', limits => rateLimits.update(limits));

      const panels = new Map([
        ['sidebar', new SidebarPanel(store, router)],
        ['messages', new MessagesPanel(store)],
        ['composer', new ComposerPanel(store, settings)],
        ['stats', new StatsPanel(stats, activity, rateLimits)],
        ['sources', new SourcesPanel(stats)],
        ['files', new FilesPanel(stats)],
      ]);
      const workspace = new DockWorkspace(panels, preferences);
      new Toolbar(preferences, workspace).mount();
      workspace.mount();

      rateLimits.start();
      await Promise.all([stats.refresh(), activity.start(), store.refreshConversations()]);
      await router.start();
    }
  }

  new ClaudePlusApp().start().catch(error => console.error(LOG_PREFIX, 'failed to start', error));
})();
