// ==UserScript==
// @name         ClaudePlus
// @namespace    skydotnet.claudeplus
// @version      1.1.0
// @description  Replaces claude.ai's UI with a VS Code-style dockable, resizable, tabbed workspace: conversation list, chat, composer, plus Stats / Web Sources / Files panels, all driven by claude.ai's internal REST/completion API.
// @match        https://claude.ai/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  /**
   * A rectangle in viewport coordinates, in CSS pixels.
   * @typedef {object} Rect
   * @property {number} left Distance of the left edge from the viewport's left edge.
   * @property {number} top Distance of the top edge from the viewport's top edge.
   * @property {number} width Width.
   * @property {number} height Height.
   */

  /**
   * A dock zone holding one or more panels as tabs.
   * @typedef {object} LeafNode
   * @property {'leaf'} type Node discriminator.
   * @property {string} id Stable identifier of the zone.
   * @property {string[]} tabs Panel ids shown as tabs, in tab order.
   * @property {?string} activeTab Panel id of the visible tab, or null when the zone is empty.
   */

  /**
   * A split dividing its area between two or more child nodes.
   * @typedef {object} SplitNode
   * @property {'split'} type Node discriminator.
   * @property {'row'|'column'} direction 'row' places children side by side, 'column' stacks them.
   * @property {number[]} sizes Fraction of the area given to each child; sums to 1.
   * @property {DockNode[]} children Child nodes, at least two.
   */

  /**
   * Any node of the dock tree.
   * @typedef {LeafNode|SplitNode} DockNode
   */

  /**
   * Where a zone is drawn.
   * @typedef {object} LeafPlacement
   * @property {LeafNode} leaf The zone.
   * @property {Rect} rect Its area, including the tab strip.
   */

  /**
   * Where a draggable divider between two split children is drawn.
   * @typedef {object} DividerPlacement
   * @property {SplitNode} split The split the divider belongs to.
   * @property {number} index Index of the child before the divider.
   * @property {Rect} rect Area of the whole split.
   * @property {number} position Divider coordinate along the split axis, in CSS pixels.
   */

  /**
   * Result of laying out a dock tree.
   * @typedef {object} DockLayout
   * @property {LeafPlacement[]} leaves Every zone and its area.
   * @property {DividerPlacement[]} dividers Every divider and its position.
   */

  /**
   * Where a dragged tab would be dropped.
   * @typedef {object} DropTarget
   * @property {?string} edge Outer workspace edge ('left' | 'right' | 'top' | 'bottom'), or null.
   * @property {?string} leafId Target zone when not docking at an edge, otherwise null.
   * @property {?string} region Part of the target zone ('center' | 'left' | 'right' | 'top' | 'bottom'), or null.
   * @property {Rect} rect Area to highlight while hovering.
   */

  /**
   * A conversation as listed by the API.
   * @typedef {object} ConversationListing
   * @property {string} uuid Conversation id.
   * @property {string} name Title; may be empty.
   * @property {string} updated_at ISO timestamp of the last change.
   */

  /**
   * A content block of an API message.
   * @typedef {object} ContentBlock
   * @property {string} type 'text', 'tool_use', 'tool_result' or another type that is ignored.
   * @property {string} [text] Text of a 'text' block.
   * @property {string} [name] Tool name of a 'tool_use' block.
   * @property {object} [input] Tool input of a 'tool_use' block.
   * @property {Array<object>} [content] Result items of a 'tool_result' block.
   * @property {string} [stop_timestamp] ISO timestamp the block completed.
   */

  /**
   * A message as returned by the API.
   * @typedef {object} ApiMessage
   * @property {string} uuid Message id.
   * @property {?string} [parent_message_uuid] Parent in the conversation tree.
   * @property {string} sender 'human' or 'assistant'.
   * @property {string} [text] Plain text, used by older messages.
   * @property {ContentBlock[]} [content] Structured content.
   * @property {Array<object>} [attachments] Uploaded attachments.
   * @property {Array<object>} [files] Uploaded files.
   * @property {string} created_at ISO creation timestamp.
   */

  /**
   * A full conversation as returned by the API.
   * @typedef {object} ApiConversation
   * @property {string} uuid Conversation id.
   * @property {string} name Title; may be empty.
   * @property {string} updated_at ISO timestamp of the last change.
   * @property {string} [current_leaf_message_uuid] Last message of the branch claude.ai shows.
   * @property {ApiMessage[]} chat_messages Every message of every branch.
   */

  /**
   * Utilization of one usage window.
   * @typedef {object} UsageWindow
   * @property {number} utilization Utilization as reported by the API.
   */

  /**
   * Latest known usage windows.
   * @typedef {object} RateLimits
   * @property {?UsageWindow} fiveHour The five-hour session window.
   * @property {?UsageWindow} sevenDay The weekly window.
   */

  /**
   * Model options sent with a completion request.
   * @typedef {object} ComposerSnapshot
   * @property {string} model Model id.
   * @property {string} effort Effort level id.
   * @property {string} thinkingMode One of THINKING_MODES.
   */

  /**
   * An entry of a select element or a menu.
   * @typedef {object} ChoiceOption
   * @property {string} id Value identifying the entry.
   * @property {string} label Displayed text.
   */

  /**
   * A web source cited by a tool result.
   * @typedef {object} SourceEntry
   * @property {string} title Page title.
   * @property {string} url Page URL.
   * @property {?string} outlet Host name without "www.".
   * @property {?string} topLevelDomain Top-level domain without the dot.
   * @property {string} timestamp ISO timestamp.
   * @property {string} [conversationTitle] Title of the conversation, set once aggregated.
   * @property {string} [conversationId] Id of the conversation, set once aggregated.
   */

  /**
   * A file uploaded by the user or produced by Claude.
   * @typedef {object} FileEntry
   * @property {string} path Path or name.
   * @property {string} title Display name.
   * @property {string} timestamp ISO timestamp.
   * @property {'user'|'claude'} source Who provided the file.
   * @property {string} [conversationTitle] Title of the conversation, set once aggregated.
   * @property {string} [conversationId] Id of the conversation, set once aggregated.
   * @property {string} [extension] Lower-case file extension, set once aggregated.
   */

  /**
   * Per-conversation statistics stored in IndexedDB.
   * @typedef {object} ConversationSummary
   * @property {string} conversationId Conversation id; the store's key.
   * @property {string} title Conversation title.
   * @property {string} updatedAt Version of the conversation the summary was computed from.
   * @property {number} promptCount Number of human messages.
   * @property {Object<string, number>} toolCallCounts Tool calls per tool name.
   * @property {SourceEntry[]} sources Cited web sources.
   * @property {FileEntry[]} files Uploaded and produced files.
   * @property {number} estimatedTokensIn Estimated tokens sent.
   * @property {number} estimatedTokensOut Estimated tokens received.
   * @property {number[]} responseTimesMs Time from each prompt to its answer.
   */

  /**
   * The files of one conversation, shown as a folder.
   * @typedef {object} FileFolder
   * @property {string} conversationTitle Conversation title.
   * @property {string} conversationId Conversation id.
   * @property {FileEntry[]} files Files in the folder.
   * @property {number} newestFileTime Newest file timestamp in epoch milliseconds.
   */

  /**
   * Progress of the full-history backfill.
   * @typedef {object} BackfillProgress
   * @property {boolean} isRunning Whether a backfill is in progress.
   * @property {number} processedCount Conversations processed.
   * @property {number} totalCount Conversations to process.
   */

  /**
   * A conversation in a format-neutral shape, as exported.
   * @typedef {object} ExportedConversation
   * @property {string} id Conversation id.
   * @property {string} title Conversation title.
   * @property {?string} createdAt ISO creation timestamp, or null when unknown.
   * @property {string} updatedAt ISO timestamp of the last change.
   * @property {string} exportedAt ISO timestamp of the export.
   * @property {ExportedMessage[]} messages Messages of the current branch, oldest first.
   */

  /**
   * One exported message.
   * @typedef {object} ExportedMessage
   * @property {string} id Message id.
   * @property {?string} parentId Parent message id, or null.
   * @property {string} sender 'human' or 'assistant'.
   * @property {?string} createdAt ISO creation timestamp, or null when unknown.
   * @property {string[]} attachments Names of the uploaded files.
   * @property {ExportedBlock[]} blocks Content, in order.
   */

  /**
   * One exported content block. Which optional fields are set depends on the type: text has text;
   * toolCall has name and input; toolResult has name and content; other keeps an unrecognised block
   * whole in content, with its API type in originalType.
   * @typedef {object} ExportedBlock
   * @property {'text'|'toolCall'|'toolResult'|'other'} type Block kind.
   * @property {string} [text] Markdown text.
   * @property {?string} [name] Tool name.
   * @property {*} [input] Tool input, unchanged.
   * @property {*} [content] Tool result content or the unrecognised block, unchanged.
   * @property {string} [originalType] API type of an unrecognised block.
   */

  /**
   * A file format a conversation can be exported to.
   * @typedef {object} ExportFormat
   * @property {string} label Name shown in the export menu.
   * @property {string} extension File extension without the dot.
   * @property {string} mimeType MIME type of the file.
   * @property {function(ExportedConversation): string} serialize Converts a conversation to the file content.
   */

  /**
   * An event yielded by ClaudeApi#streamCompletion.
   * @typedef {object} StreamEvent
   * @property {string} type STREAM_START or a server-sent event type.
   */

  /**
   * Prefix for every console message this script writes.
   * @type {string}
   */
  const LOG_PREFIX = '[ClaudePlus]';

  /**
   * Workspace geometry. Pixel values are CSS pixels; fractions are of the containing area.
   * toolbarHeight / tabStripHeight: fixed bar heights. minimumSplitFraction: smallest share a split
   * child can be resized to. edgeDockFraction: share of a panel docked at an outer edge.
   * edgeDropMargin: distance from the workspace edge that counts as an edge drop. sideDropFraction:
   * share of a zone near each side that counts as a side drop. dragThreshold: movement before a
   * press becomes a drag. dividerThickness: grab width of a divider. dragLabelOffset: distance of
   * the drag label from the pointer. edgeHighlightMaxWidth / edgeHighlightMaxHeight: size cap of
   * the edge drop highlight.
   * @type {Readonly<Record<string, number>>}
   */
  const LAYOUT = Object.freeze({
    toolbarHeight: 36,
    tabStripHeight: 26,
    minimumSplitFraction: 0.08,
    edgeDockFraction: 0.25,
    edgeDropMargin: 32,
    sideDropFraction: 0.25,
    dragThreshold: 4,
    dividerThickness: 6,
    dragLabelOffset: 12,
    edgeHighlightMaxWidth: 280,
    edgeHighlightMaxHeight: 220,
  });

  /**
   * Timing in milliseconds. rateLimitPollMs: usage polling interval. activitySampleMs: activity
   * sampling interval. idleAfterMs: time without input after which the user counts as idle.
   * activitySaveMs: how often activity is written to IndexedDB. backfillPauseMs: pause between
   * conversation fetches during a backfill. maxResponseGapMs: longest prompt-to-answer gap still
   * counted as a response time. copyFeedbackMs: how long the copy button shows a check mark.
   * downloadUrlLifetimeMs: how long a download's object URL stays valid after the download starts.
   * @type {Readonly<Record<string, number>>}
   */
  const TIMING = Object.freeze({
    rateLimitPollMs: 30_000,
    activitySampleMs: 1_000,
    idleAfterMs: 60_000,
    activitySaveMs: 15_000,
    backfillPauseMs: 300,
    maxResponseGapMs: 30 * 60 * 1000,
    copyFeedbackMs: 1_000,
    downloadUrlLifetimeMs: 10_000,
  });

  /**
   * Result limits. sidebarPageSize / backfillPageSize: conversations requested per API page.
   * listedSources: web sources listed at once. rankedOutlets: outlets in the ranking.
   * toolResultCharacters: characters of a tool result shown. provisionalTitleLength: characters of
   * the first prompt used as a new conversation's title. backfillRefreshInterval: conversations
   * stored between aggregate refreshes during a backfill. followOutputDistance: distance from the
   * bottom, in pixels, within which the chat keeps following new output. exportFileNameLength:
   * characters of the conversation title used in an export file name.
   * @type {Readonly<Record<string, number>>}
   */
  const LIMITS = Object.freeze({
    sidebarPageSize: 100,
    backfillPageSize: 100,
    listedSources: 500,
    rankedOutlets: 30,
    toolResultCharacters: 4000,
    provisionalTitleLength: 60,
    backfillRefreshInterval: 10,
    followOutputDistance: 40,
    exportFileNameLength: 80,
  });

  /**
   * localStorage keys.
   * @type {Readonly<Record<string, string>>}
   */
  const STORAGE_KEYS = Object.freeze({
    dockLayout: 'claudePlus.dockLayout',
    model: 'claudePlus.model',
    effort: 'claudePlus.effort',
    thinkingMode: 'claudePlus.thinkingMode',
    messageFontSize: 'claudePlus.messageFontSize',
    chatPanes: 'claudePlus.chatPanes',
    conversationListColumns: 'claudePlus.conversationListColumns',
    conversationListSort: 'claudePlus.conversationListSort',
  });

  /**
   * IndexedDB database: conversation summaries keyed by conversation id, and active time keyed by day.
   * Each store maps to its key path.
   * @type {Readonly<{name: string, version: number, stores: Readonly<Record<string, string>>, keyPaths: Readonly<Record<string, string>>}>}
   */
  const DATABASE = Object.freeze({
    name: 'claudePlus',
    version: 1,
    stores: Object.freeze({ conversationSummaries: 'conversationSummaries', activity: 'activity' }),
    keyPaths: Object.freeze({ conversationSummaries: 'conversationId', activity: 'day' }),
  });

  /**
   * Selectable models; the first is the default.
   * @type {ReadonlyArray<ChoiceOption>}
   */
  const MODELS = Object.freeze([
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ]);

  /**
   * Selectable effort levels; the first is the default.
   * @type {ReadonlyArray<ChoiceOption>}
   */
  const EFFORTS = Object.freeze([
    { id: 'low', label: 'Low effort' },
    { id: 'medium', label: 'Medium effort' },
    { id: 'high', label: 'High effort' },
  ]);

  /**
   * The only thinking modes the completion endpoint accepts; 'off' is the default.
   * @type {Readonly<{off: string, extended: string}>}
   */
  const THINKING_MODES = Object.freeze({ off: 'off', extended: 'extended' });

  /**
   * Locale tags the completion endpoint accepts. navigator.language (e.g. "en-GB", "de") is
   * usually not one of them, and sending it gets the request rejected with a 400.
   * @type {ReadonlyArray<string>}
   */
  const ALLOWED_LOCALES = Object.freeze(['en-US', 'de-DE', 'fr-FR', 'ko-KR', 'ja-JP', 'es-419', 'es-ES', 'it-IT', 'hi-IN', 'pt-BR', 'id-ID']);

  /**
   * Locale used when the browser language has no accepted equivalent.
   * @type {string}
   */
  const DEFAULT_LOCALE = 'en-US';

  /**
   * Parent of the first message in every claude.ai conversation tree. Used when a message's parent
   * is unknown locally.
   * @type {string}
   */
  const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000';

  /**
   * Type of the synthetic first event of a completion stream, carrying the client-generated ids.
   * @type {string}
   */
  const STREAM_START = 'claudeplus_stream_start';

  /**
   * Path of the new-chat page.
   * @type {string}
   */
  const NEW_CHAT_PATH = '/new';

  /**
   * Matches a conversation page path and captures the conversation id.
   * @type {RegExp}
   */
  const CHAT_PATH_PATTERN = /^\/chat\/([0-9a-f-]{36})/i;

  /**
   * Display title of a conversation without a title.
   * @type {string}
   */
  const UNTITLED = '(untitled)';

  /**
   * Characters XML 1.0 doesn't allow in documents, even escaped.
   * @type {RegExp}
   */
  const XML_FORBIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

  /**
   * Characters not allowed in file names on common operating systems.
   * @type {RegExp}
   */
  const FILE_NAME_FORBIDDEN_CHARACTERS = /[\\/:*?"<>|\u0000-\u001F]+/g;

  /**
   * Upload fields that may hold a display name, in order of preference.
   * @type {ReadonlyArray<string>}
   */
  const ATTACHMENT_NAME_FIELDS = Object.freeze(['file_name', 'name', 'filename', 'title']);

  /**
   * Characters escaped for HTML output and their entities.
   * @type {Readonly<Record<string, string>>}
   */
  const HTML_ENTITIES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

  /**
   * Escapes a value for safe insertion into HTML text or attribute values.
   * @param {*} value Value to escape; null and undefined become an empty string.
   * @returns {string} The escaped string.
   */
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => HTML_ENTITIES[character]);
  }

  /**
   * Escapes a value for XML text or attribute values and drops characters XML can't contain.
   * @param {*} value Value to escape; null and undefined become an empty string.
   * @returns {string} The escaped string.
   */
  function escapeXml(value) {
    return escapeHtml(String(value ?? '').replace(XML_FORBIDDEN_CHARACTERS, ''));
  }

  /**
   * Wraps content in a markdown code fence longer than any backtick run inside it, so the content
   * can't close the fence early.
   * @param {string} content Code to wrap.
   * @param {string} language Language tag after the opening fence; may be empty.
   * @returns {string} The fenced block.
   */
  function markdownCodeFence(content, language) {
    const longestBacktickRun = Math.max(2, ...(content.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longestBacktickRun + 1);
    return `${fence}${language}\n${content}\n${fence}`;
  }

  /**
   * Makes a conversation title usable in a file name.
   * @param {string} title Conversation title.
   * @returns {string} The title without forbidden characters and shortened, or "conversation" if nothing remains.
   */
  function fileNameFromTitle(title) {
    const cleaned = title.replace(FILE_NAME_FORBIDDEN_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.slice(0, LIMITS.exportFileNameLength).trim() || 'conversation';
  }

  /**
   * Lets the browser save text as a file.
   * @param {string} fileName Suggested file name.
   * @param {string} content File content.
   * @param {string} mimeType MIME type of the content.
   * @returns {void}
   */
  function downloadTextFile(fileName, content, mimeType) {
    const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
    const link = createElement('a', { href: url, download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), TIMING.downloadUrlLifetimeMs);
  }

  /**
   * Formats a duration compactly, e.g. "2h 5m", "3m 12s" or "40s".
   * @param {number} durationMs Duration in milliseconds; negative values count as zero.
   * @returns {string} The formatted duration.
   */
  function formatDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  /**
   * Formats a usage window's utilization as a percentage rounded to two decimals.
   * @param {?UsageWindow} usageWindow The window, or null when unknown.
   * @returns {string} The percentage, or "–" when unknown.
   */
  function formatUtilization(usageWindow) {
    if (!usageWindow) return '–';
    return `${Math.round((usageWindow.utilization || 0) * 100) / 100}%`;
  }

  /**
   * Arithmetic mean of a list of numbers.
   * @param {number[]} values The numbers.
   * @returns {number} The mean, or 0 for an empty list.
   */
  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  /**
   * Waits for a given time.
   * @param {number} durationMs Milliseconds to wait.
   * @returns {Promise<void>} Resolves after the delay.
   */
  function wait(durationMs) {
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }

  /**
   * Limits a number to a range.
   * @param {number} value The number.
   * @param {number} minimum Lower bound.
   * @param {number} maximum Upper bound.
   * @returns {number} The value, raised to the minimum or lowered to the maximum if outside the range.
   */
  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  /**
   * Parses a date string into epoch milliseconds.
   * @param {?string} isoDate ISO date string.
   * @returns {number} Epoch milliseconds, or 0 when missing or invalid.
   */
  function toEpochMs(isoDate) {
    return Date.parse(isoDate) || 0;
  }

  /**
   * Adds to a counter in a count map, creating it at zero first.
   * @param {Object<string, number>} counts The count map; modified in place.
   * @param {string} key Counter to increase.
   * @param {number} amount Amount to add.
   * @returns {void}
   */
  function addToCount(counts, key, amount) {
    counts[key] = (counts[key] ?? 0) + amount;
  }

  /**
   * Entries of a count map, highest count first.
   * @param {Object<string, number>} counts The count map.
   * @returns {Array<[string, number]>} [key, count] pairs sorted by descending count.
   */
  function entriesByDescendingCount(counts) {
    return Object.entries(counts).sort((first, second) => second[1] - first[1]);
  }

  /**
   * Orders two sortable values ascending.
   * @param {string|number} first First value.
   * @param {string|number} second Second value.
   * @returns {number} Negative if the first sorts first, positive if the second does, 0 if equal.
   */
  function compareAscending(first, second) {
    if (first === second) return 0;
    return first < second ? -1 : 1;
  }

  /**
   * Estimates a token count from text length, at four characters per token. claude.ai doesn't
   * expose real token counts.
   * @param {?string} text The text.
   * @returns {number} Estimated tokens; 0 for empty text.
   */
  function estimateTokens(text) {
    return text ? Math.ceil(text.length / 4) : 0;
  }

  /**
   * Last segment of a slash-separated path.
   * @param {?string} path The path.
   * @returns {string} The last segment, or an empty string.
   */
  function lastPathSegment(path) {
    return (path || '').split('/').pop();
  }

  /**
   * Lower-case extension of a file name or path, ignoring any query string.
   * @param {?string} fileName File name or path.
   * @returns {string} The extension without the dot, or "file" when there is none.
   */
  function fileExtension(fileName) {
    const match = lastPathSegment(fileName).split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
    return match ? match[1].toLowerCase() : 'file';
  }

  /**
   * Splits a URL's host into outlet (host without "www.") and top-level domain.
   * @param {string} url Absolute URL.
   * @returns {{outlet: ?string, topLevelDomain: ?string}} The parts; both null for an invalid URL.
   */
  function hostParts(url) {
    try {
      const outlet = new URL(url).hostname.replace(/^www\./, '');
      const labels = outlet.split('.');
      return { outlet, topLevelDomain: labels.length > 1 ? labels[labels.length - 1] : '' };
    } catch {
      return { outlet: null, topLevelDomain: null };
    }
  }

  /**
   * Reads a cookie of the current page.
   * @param {string} name Cookie name.
   * @returns {?string} The decoded value, or null when the cookie isn't set.
   */
  function readCookie(name) {
    const cookie = document.cookie.split('; ').find(entry => entry.startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
  }

  /**
   * The browser language mapped to a locale the completion endpoint accepts: an exact match, else
   * the first accepted locale of the same language, else DEFAULT_LOCALE.
   * @returns {string} An entry of ALLOWED_LOCALES.
   */
  function resolveLocale() {
    const language = navigator.language || DEFAULT_LOCALE;
    if (ALLOWED_LOCALES.includes(language)) return language;
    const baseLanguage = language.split('-')[0];
    return ALLOWED_LOCALES.find(locale => locale.startsWith(`${baseLanguage}-`)) ?? DEFAULT_LOCALE;
  }

  /**
   * The browser's IANA time zone.
   * @returns {string} The time zone name, or "UTC" when unavailable.
   */
  function currentTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  /**
   * Extracts the conversation id from a page path.
   * @param {string} pathname Path such as "/chat/<uuid>".
   * @returns {?string} The conversation id, or null when the path isn't a conversation page.
   */
  function conversationIdFromPath(pathname) {
    const match = pathname.match(CHAT_PATH_PATTERN);
    return match ? match[1] : null;
  }

  /**
   * Page path of a conversation.
   * @param {string} conversationId Conversation id.
   * @returns {string} The path.
   */
  function conversationPath(conversationId) {
    return `/chat/${conversationId}`;
  }

  /**
   * Creates an id for a message that exists only locally.
   * @returns {string} A unique id prefixed with "local-".
   */
  function createLocalMessageId() {
    return `local-${crypto.randomUUID()}`;
  }

  /**
   * Serializes a value as gzip-compressed JSON, the body format the completion endpoint requires.
   * @param {*} value JSON-serializable value.
   * @returns {Promise<Uint8Array>} The compressed bytes.
   */
  async function gzipJson(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const compressedStream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(compressedStream).arrayBuffer());
  }

  /**
   * Creates an element and assigns properties to it.
   * @param {string} tagName Tag name.
   * @param {object} properties Element properties to set, e.g. className, textContent, innerHTML, title, hidden.
   * @returns {HTMLElement} The new element.
   */
  function createElement(tagName, properties) {
    return Object.assign(document.createElement(tagName), properties);
  }

  /**
   * Shows a themed modal in place of the native confirm() dialog, which Chrome silently disables
   * ("prevent this page from creating additional dialogs") after repeated use on the same page,
   * making a delete button appear to do nothing with no feedback.
   * @param {string} message Question to show.
   * @param {string} [confirmLabel] Label of the confirming button.
   * @returns {Promise<boolean>} Resolves true if confirmed, false if cancelled.
   */
  function confirmDialog(message, confirmLabel = 'Confirm') {
    return new Promise(resolve => {
      const { overlay, dialog } = createDialogShell(message, `
        <button class="claude-plus-toolbar__button" data-name="cancel">Cancel</button>
        <button class="claude-plus-primary-button" data-name="confirm">${escapeHtml(confirmLabel)}</button>`);
      const finish = result => {
        overlay.remove();
        resolve(result);
      };
      dialog.querySelector('[data-name="cancel"]').addEventListener('click', () => finish(false));
      dialog.querySelector('[data-name="confirm"]').addEventListener('click', () => finish(true));
      overlay.addEventListener('mousedown', event => {
        if (event.target === overlay) finish(false);
      });
      document.body.append(overlay);
    });
  }

  /**
   * Shows a themed modal in place of the native alert() dialog, for the same reason as
   * confirmDialog: repeated native dialogs can be silently disabled by the browser.
   * @param {string} message Message to show.
   * @returns {Promise<void>} Resolves once dismissed.
   */
  function alertDialog(message) {
    return new Promise(resolve => {
      const { overlay, dialog } = createDialogShell(message, '<button class="claude-plus-primary-button" data-name="ok">OK</button>');
      const finish = () => {
        overlay.remove();
        resolve();
      };
      dialog.querySelector('[data-name="ok"]').addEventListener('click', finish);
      overlay.addEventListener('mousedown', event => {
        if (event.target === overlay) finish();
      });
      document.body.append(overlay);
    });
  }

  /**
   * Builds the overlay and dialog box shared by confirmDialog and alertDialog.
   * @param {string} message Message to show.
   * @param {string} actionsHtml HTML of the action buttons.
   * @returns {{overlay: HTMLElement, dialog: HTMLElement}} The overlay and the dialog inside it.
   */
  function createDialogShell(message, actionsHtml) {
    const overlay = createElement('div', { className: 'claude-plus-themed claude-plus-dialog-overlay' });
    const dialog = createElement('div', {
      className: 'claude-plus-dialog',
      innerHTML: `<p class="claude-plus-dialog__message"></p><div class="claude-plus-dialog__actions">${actionsHtml}</div>`,
    });
    dialog.querySelector('.claude-plus-dialog__message').textContent = message;
    overlay.append(dialog);
    return { overlay, dialog };
  }

  /**
   * Positions a fixed-position element over a rectangle.
   * @param {HTMLElement} element The element.
   * @param {Rect} rect Target rectangle.
   * @returns {void}
   */
  function placeElement(element, rect) {
    Object.assign(element.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  /**
   * Collects every descendant marked with a data-name attribute, keyed by that name.
   * @param {HTMLElement} root Element to search.
   * @returns {Object<string, HTMLElement>} The marked elements by name.
   */
  function collectNamedElements(root) {
    return Object.fromEntries([...root.querySelectorAll('[data-name]')].map(element => [element.dataset.name, element]));
  }

  /**
   * HTML for the options of a select element.
   * @param {ReadonlyArray<ChoiceOption>} options The options.
   * @param {string} selectedId Value of the option to preselect.
   * @returns {string} The option elements.
   */
  function optionsHtml(options, selectedId) {
    return options.map(option => `<option value="${escapeHtml(option.id)}"${option.id === selectedId ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
  }

  /**
   * HTML for an empty-state message.
   * @param {string} message The message.
   * @returns {string} A div with the message.
   */
  function emptyStateHtml(message) {
    return `<div class="claude-plus-empty-state">${escapeHtml(message)}</div>`;
  }

  /**
   * HTML for a label/value row.
   * @param {string} label Row label.
   * @param {string|number} value Row value.
   * @returns {string} The row.
   */
  function valueRowHtml(label, value) {
    return `<div class="claude-plus-value-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
  }

  /**
   * Tracks one mouse drag gesture on the window. Its listeners exist only while the button is held
   * and are always removed on release.
   */
  class DragGesture {
    /**
     * Pointer x when the button was pressed.
     * @type {number}
     */
    #startPointerX;

    /**
     * Pointer y when the button was pressed.
     * @type {number}
     */
    #startPointerY;

    /**
     * Movement in pixels before the gesture counts as a drag.
     * @type {number}
     */
    #threshold;

    /**
     * Called on every move once dragging.
     * @type {function(MouseEvent): void}
     */
    #onMove;

    /**
     * Called on release with whether a drag happened.
     * @type {function(MouseEvent, boolean): void}
     */
    #onEnd;

    /**
     * Whether the threshold has been passed.
     * @type {boolean}
     */
    #isDragging;

    /**
     * Starts tracking from a mousedown event.
     * @param {MouseEvent} startEvent The mousedown that starts the gesture.
     * @param {object} handlers Gesture configuration.
     * @param {number} handlers.threshold Movement in pixels before moves are reported; 0 reports all.
     * @param {function(MouseEvent): void} handlers.onMove Called for each move while dragging.
     * @param {function(MouseEvent, boolean): void} handlers.onEnd Called on release with whether the threshold was passed.
     */
    constructor(startEvent, { threshold, onMove, onEnd }) {
      this.#startPointerX = startEvent.clientX;
      this.#startPointerY = startEvent.clientY;
      this.#threshold = threshold;
      this.#onMove = onMove;
      this.#onEnd = onEnd;
      this.#isDragging = threshold === 0;
      window.addEventListener('mousemove', this.#handleMove);
      window.addEventListener('mouseup', this.#handleRelease);
    }

    /**
     * Reports a move once the threshold has been passed.
     * @param {MouseEvent} event The mousemove event.
     * @returns {void}
     */
    #handleMove = (event) => {
      if (!this.#isDragging && !this.#hasPassedThreshold(event)) return;
      this.#isDragging = true;
      this.#onMove(event);
    };

    /**
     * Ends the gesture and removes the window listeners.
     * @param {MouseEvent} event The mouseup event.
     * @returns {void}
     */
    #handleRelease = (event) => {
      window.removeEventListener('mousemove', this.#handleMove);
      window.removeEventListener('mouseup', this.#handleRelease);
      this.#onEnd(event, this.#isDragging);
    };

    /**
     * Whether the pointer has moved far enough from the start to count as a drag.
     * @param {MouseEvent} event Current pointer event.
     * @returns {boolean} True once either axis moved at least the threshold.
     */
    #hasPassedThreshold(event) {
      const movedX = Math.abs(event.clientX - this.#startPointerX);
      const movedY = Math.abs(event.clientY - this.#startPointerY);
      return movedX >= this.#threshold || movedY >= this.#threshold;
    }
  }

  /**
   * Coalesces repeated requests into one callback per animation frame.
   */
  class FrameScheduler {
    /**
     * Work to run.
     * @type {function(): void}
     */
    #callback;

    /**
     * Pending animation frame id, or 0 when none is pending.
     * @type {number}
     */
    #pendingFrameId = 0;

    /**
     * Creates a scheduler for a callback.
     * @param {function(): void} callback Work to run at most once per frame.
     */
    constructor(callback) {
      this.#callback = callback;
    }

    /**
     * Runs the callback on the next animation frame unless already scheduled.
     * @returns {void}
     */
    schedule() {
      if (this.#pendingFrameId) return;
      this.#pendingFrameId = requestAnimationFrame(() => {
        this.#pendingFrameId = 0;
        this.#callback();
      });
    }

    /**
     * Cancels a pending run.
     * @returns {void}
     */
    cancel() {
      cancelAnimationFrame(this.#pendingFrameId);
      this.#pendingFrameId = 0;
    }
  }

  /**
   * Minimal publish/subscribe base class.
   */
  class EventEmitter {
    /**
     * Listeners per event name.
     * @type {Map<string, Set<function(*): void>>}
     */
    #listenersByEvent = new Map();

    /**
     * Subscribes to an event.
     * @param {string} eventName Event name.
     * @param {function(*): void} listener Called with the event payload.
     * @returns {function(): void} Unsubscribes the listener.
     */
    subscribe(eventName, listener) {
      if (!this.#listenersByEvent.has(eventName)) this.#listenersByEvent.set(eventName, new Set());
      this.#listenersByEvent.get(eventName).add(listener);
      return () => this.#listenersByEvent.get(eventName).delete(listener);
    }

    /**
     * Calls every listener of an event. Listeners added or removed during the call don't affect it.
     * @param {string} eventName Event name.
     * @param {*} [payload] Value passed to each listener.
     * @returns {void}
     */
    publish(eventName, payload) {
      for (const listener of [...(this.#listenersByEvent.get(eventName) ?? [])]) listener(payload);
    }
  }

  /**
   * localStorage access that degrades to no-ops when storage is unavailable (private mode, blocked
   * site data), because every accessor can throw there.
   */
  class Preferences {
    /**
     * Reads a string value.
     * @param {string} key Storage key.
     * @returns {?string} The stored value, or null when missing or unavailable.
     */
    read(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    }

    /**
     * Stores a value as a string; silently skipped when storage is unavailable.
     * @param {string} key Storage key.
     * @param {*} value Value to store.
     * @returns {void}
     */
    write(key, value) {
      try {
        localStorage.setItem(key, String(value));
      } catch {
        return;
      }
    }

    /**
     * Removes a value; silently skipped when storage is unavailable.
     * @param {string} key Storage key.
     * @returns {void}
     */
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        return;
      }
    }

    /**
     * Reads and parses a JSON value.
     * @param {string} key Storage key.
     * @returns {*} The parsed value, or null when missing, unavailable or not valid JSON.
     */
    readJson(key) {
      try {
        return JSON.parse(this.read(key));
      } catch {
        return null;
      }
    }

    /**
     * Stores a value as JSON.
     * @param {string} key Storage key.
     * @param {*} value JSON-serializable value.
     * @returns {void}
     */
    writeJson(key, value) {
      this.write(key, JSON.stringify(value));
    }
  }

  /**
   * Promise-based access to one IndexedDB database. The connection opens on first use and is
   * retried after a failure.
   */
  class IndexedDbStore {
    /**
     * Database name.
     * @type {string}
     */
    #databaseName;

    /**
     * Schema version.
     * @type {number}
     */
    #schemaVersion;

    /**
     * Creates missing object stores on upgrade.
     * @type {function(IDBDatabase): void}
     */
    #upgradeSchema;

    /**
     * The open connection, or null before first use or after a failure.
     * @type {?Promise<IDBDatabase>}
     */
    #connection = null;

    /**
     * Describes the database; nothing is opened yet.
     * @param {object} options Database description.
     * @param {string} options.name Database name.
     * @param {number} options.version Schema version.
     * @param {function(IDBDatabase): void} options.upgrade Called when the schema must be created or upgraded.
     */
    constructor({ name, version, upgrade }) {
      this.#databaseName = name;
      this.#schemaVersion = version;
      this.#upgradeSchema = upgrade;
    }

    /**
     * Reads one record.
     * @param {string} storeName Object store.
     * @param {IDBValidKey} key Record key.
     * @returns {Promise<*>} The record, or undefined when absent.
     * @throws {DOMException} When the database can't be opened or read.
     */
    read(storeName, key) {
      return this.#runRequest(storeName, 'readonly', store => store.get(key));
    }

    /**
     * Reads every record of a store.
     * @param {string} storeName Object store.
     * @returns {Promise<Array<*>>} All records.
     * @throws {DOMException} When the database can't be opened or read.
     */
    readAll(storeName) {
      return this.#runRequest(storeName, 'readonly', store => store.getAll());
    }

    /**
     * Inserts or replaces a record.
     * @param {string} storeName Object store.
     * @param {object} record Record; its key comes from the store's key path.
     * @returns {Promise<IDBValidKey>} The record's key.
     * @throws {DOMException} When the database can't be opened or written.
     */
    write(storeName, record) {
      return this.#runRequest(storeName, 'readwrite', store => store.put(record));
    }

    /**
     * Deletes a record; deleting a missing record succeeds.
     * @param {string} storeName Object store.
     * @param {IDBValidKey} key Record key.
     * @returns {Promise<void>} Resolves once deleted.
     * @throws {DOMException} When the database can't be opened or written.
     */
    remove(storeName, key) {
      return this.#runRequest(storeName, 'readwrite', store => store.delete(key));
    }

    /**
     * Reads a record and writes back a replacement in one transaction, so concurrent tabs can't
     * overwrite each other's changes.
     * @param {string} storeName Object store.
     * @param {IDBValidKey} key Record key.
     * @param {function(*): object} createReplacement Receives the current record (or undefined) and returns the replacement.
     * @returns {Promise<*>} The record as it was before the update.
     * @throws {DOMException} When the database can't be opened or written.
     */
    update(storeName, key, createReplacement) {
      return this.#runRequest(storeName, 'readwrite', (store) => {
        const readRequest = store.get(key);
        readRequest.onsuccess = () => store.put(createReplacement(readRequest.result));
        return readRequest;
      });
    }

    /**
     * The database connection, opening it on first use.
     * @returns {Promise<IDBDatabase>} The open database.
     * @throws {DOMException} When opening fails; the next call retries.
     */
    #openConnection() {
      this.#connection ??= this.#connect().catch((error) => {
        this.#connection = null;
        throw error;
      });
      return this.#connection;
    }

    /**
     * Opens the database, upgrading the schema when needed.
     * @returns {Promise<IDBDatabase>} The open database.
     * @throws {DOMException} When the request fails.
     */
    #connect() {
      return new Promise((resolve, reject) => {
        const openRequest = indexedDB.open(this.#databaseName, this.#schemaVersion);
        openRequest.onupgradeneeded = () => this.#upgradeSchema(openRequest.result);
        openRequest.onsuccess = () => resolve(openRequest.result);
        openRequest.onerror = () => reject(openRequest.error);
      });
    }

    /**
     * Runs one request in its own transaction and resolves once the transaction completes.
     * @param {string} storeName Object store.
     * @param {IDBTransactionMode} mode Transaction mode.
     * @param {function(IDBObjectStore): IDBRequest} issueRequest Issues the request whose result is returned.
     * @returns {Promise<*>} The request's result.
     * @throws {DOMException} When the transaction fails or aborts.
     */
    async #runRequest(storeName, mode, issueRequest) {
      const database = await this.#openConnection();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const request = issueRequest(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }
  }

  /**
   * A non-success HTTP response from the claude.ai API.
   */
  class ApiError extends Error {
    /**
     * Creates the error.
     * @param {number} status HTTP status code.
     * @param {string} responseBody Response body; its first 200 characters become part of the message.
     */
    constructor(status, responseBody) {
      super(`${status} ${responseBody.slice(0, 200)}`.trim());
      this.name = 'ApiError';
      this.status = status;
    }

    /**
     * Creates an error from a failed response, including its body when readable.
     * @param {Response} response The failed response.
     * @returns {Promise<ApiError>} The error.
     */
    static async fromResponse(response) {
      return new ApiError(response.status, await response.text().catch(() => ''));
    }
  }

  /**
   * Incrementally splits a server-sent event stream into parsed JSON events.
   */
  class ServerSentEventDecoder {
    /**
     * Blank line separating two events.
     * @type {RegExp}
     */
    static #EVENT_SEPARATOR = /\r?\n\r?\n/;

    /**
     * Text received but not yet part of a complete event.
     * @type {string}
     */
    #pendingText = '';

    /**
     * Reads a byte stream to the end, yielding each event's parsed JSON data.
     * @param {ReadableStream<Uint8Array>} byteStream The response body.
     * @yields {object} Each event's data. Events without data or with invalid JSON are skipped.
     * @returns {AsyncGenerator<object, void, void>} The events in arrival order.
     * @throws {DOMException} An AbortError when the request is aborted mid-stream.
     */
    static async *decodeStream(byteStream) {
      const reader = byteStream.pipeThrough(new TextDecoderStream()).getReader();
      const decoder = new ServerSentEventDecoder();
      try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          yield* decoder.appendText(chunk.value);
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
    }

    /**
     * Adds received text and returns every event it completes.
     * @param {string} text Newly received text.
     * @returns {object[]} Parsed data of the completed events, in order.
     */
    appendText(text) {
      this.#pendingText += text;
      const events = [];
      for (let separator = this.#findSeparator(); separator; separator = this.#findSeparator()) {
        events.push(...ServerSentEventDecoder.#parseEvent(this.#pendingText.slice(0, separator.index)));
        this.#pendingText = this.#pendingText.slice(separator.index + separator[0].length);
      }
      return events;
    }

    /**
     * Finds the first event separator in the pending text.
     * @returns {?RegExpExecArray} The match, or null when no event is complete.
     */
    #findSeparator() {
      return ServerSentEventDecoder.#EVENT_SEPARATOR.exec(this.#pendingText);
    }

    /**
     * Parses one raw event, joining multiple data lines as the SSE format specifies.
     * @param {string} rawEvent Raw event text.
     * @returns {object[]} The parsed data as a single-element array, or an empty array when the event has no data or invalid JSON.
     */
    static #parseEvent(rawEvent) {
      const data = rawEvent.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n');
      try {
        return data ? [JSON.parse(data)] : [];
      } catch {
        return [];
      }
    }
  }

  /**
   * Client for claude.ai's internal API, the only source of data and actions for the whole UI.
   */
  class ClaudeApi {
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
     * Sends a prompt and streams the reply. The first event has type STREAM_START and carries the
     * client-generated humanMessageId and assistantMessageId; every following event is a parsed
     * server-sent event.
     * @param {object} request The prompt to send.
     * @param {string} request.conversationId Conversation id; a new random id when isNew.
     * @param {string} request.prompt Prompt text.
     * @param {string} request.parentMessageId Message to reply to; ignored when isNew.
     * @param {boolean} request.isNew Whether this creates the conversation.
     * @param {ComposerSnapshot} request.settings Model options.
     * @param {AbortSignal} request.signal Aborts the request and the stream.
     * @yields {StreamEvent} The start event, then each server-sent event.
     * @returns {AsyncGenerator<StreamEvent, void, void>} The events in order.
     * @throws {ApiError} When the server rejects the request.
     * @throws {DOMException} An AbortError when aborted.
     */
    async *streamCompletion({ conversationId, prompt, parentMessageId, isNew, settings, signal }) {
      const body = ClaudeApi.#buildCompletionBody({ prompt, parentMessageId, isNew, settings });
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
     * @returns {object} The body, with conversation-creation parameters or a parent message id.
     */
    static #buildCompletionBody({ prompt, parentMessageId, isNew, settings }) {
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
        files: [],
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

  /**
   * Minimal markdown renderer: fenced code blocks, inline code, bold, italic and http(s) links.
   * All other text is HTML-escaped.
   */
  class Markdown {
    /**
     * A fenced code block, with or without a language line; captures the code.
     * @type {RegExp}
     */
    static #CODE_FENCE = /```(?:[^\n`]*\n)?([\s\S]*?)```/;

    /**
     * Renders markdown text as HTML.
     * @param {?string} text Markdown text.
     * @returns {string} The HTML; empty for empty text.
     */
    static toHtml(text) {
      if (!text) return '';
      const segments = text.split(Markdown.#CODE_FENCE);
      return segments.map((segment, index) => Markdown.#segmentHtml(segment, index, segments.length)).join('');
    }

    /**
     * Renders one segment of the split text. Splitting with one capture group alternates plain text
     * (even indexes) and code (odd indexes).
     * @param {string} segment The text of the segment.
     * @param {number} index Position of the segment.
     * @param {number} segmentCount Total number of segments.
     * @returns {string} The HTML of the segment.
     */
    static #segmentHtml(segment, index, segmentCount) {
      if (index % 2) return `<pre class="claude-plus-code-block"><code>${escapeHtml(segment)}</code></pre>`;
      return Markdown.#inlineMarkupHtml(Markdown.#trimFenceLineBreaks(segment, index, segmentCount)).replace(/\n/g, '<br>');
    }

    /**
     * Removes the line breaks directly before and after a code fence, which belong to the fence.
     * @param {string} text Plain text segment.
     * @param {number} index Position of the segment.
     * @param {number} segmentCount Total number of segments.
     * @returns {string} The text without fence-adjacent line breaks.
     */
    static #trimFenceLineBreaks(text, index, segmentCount) {
      const withoutLeading = index > 0 ? text.replace(/^\n/, '') : text;
      return index < segmentCount - 1 ? withoutLeading.replace(/\n$/, '') : withoutLeading;
    }

    /**
     * Renders inline markup of escaped plain text.
     * @param {string} text Plain text.
     * @returns {string} The HTML.
     */
    static #inlineMarkupHtml(text) {
      return escapeHtml(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }
  }

  /**
   * Reads text, uploads and renderable HTML from API messages.
   */
  class MessageContent {
    /**
     * Shown for an API message with nothing to render.
     * @type {string}
     */
    static #NO_CONTENT_HTML = '<div class="claude-plus-message-text claude-plus-empty-state">(no content)</div>';

    /**
     * HTML renderer per content block type.
     * @type {Map<string, function(ContentBlock): string>}
     */
    static #BLOCK_RENDERERS = new Map([
      ['text', block => MessageContent.textHtml(block.text)],
      ['tool_use', block => MessageContent.#toolCallHtml(block)],
      ['tool_result', block => MessageContent.#toolResultHtml(block)],
    ]);

    /**
     * Uploaded attachments and files of a message.
     * @param {ApiMessage} apiMessage The message.
     * @returns {object[]} The uploads, without empty entries.
     */
    static uploads(apiMessage) {
      return [...(apiMessage.attachments ?? []), ...(apiMessage.files ?? [])].filter(Boolean);
    }

    /**
     * Display name of an upload.
     * @param {object} upload The upload.
     * @returns {string} The first name field present, or "(uploaded file)".
     */
    static uploadName(upload) {
      return ATTACHMENT_NAME_FIELDS.map(field => upload[field]).find(Boolean) ?? '(uploaded file)';
    }

    /**
     * Plain text of a message: its text field, or its text blocks joined by line breaks.
     * @param {ApiMessage} apiMessage The message.
     * @returns {string} The text; empty when there is none.
     */
    static plainText(apiMessage) {
      return apiMessage.text || MessageContent.#textBlocks(apiMessage).map(block => block.text).join('\n');
    }

    /**
     * HTML of a text passage rendered as markdown.
     * @param {?string} text The text.
     * @returns {string} The HTML, or an empty string for empty text.
     */
    static textHtml(text) {
      return text ? `<div class="claude-plus-message-text">${Markdown.toHtml(text)}</div>` : '';
    }

    /**
     * HTML of a whole API message: uploads, text and tool blocks.
     * @param {ApiMessage} apiMessage The message.
     * @returns {string} The HTML, or a "(no content)" placeholder.
     */
    static toHtml(apiMessage) {
      const parts = [
        ...MessageContent.uploads(apiMessage).map(upload => `<div class="claude-plus-message-attachment">📎 ${escapeHtml(MessageContent.uploadName(upload))}</div>`),
        MessageContent.#textFieldHtml(apiMessage),
        ...(apiMessage.content ?? []).map(block => MessageContent.#contentBlockHtml(block)),
      ];
      return parts.join('') || MessageContent.#NO_CONTENT_HTML;
    }

    /**
     * HTML of the text field, used only when the message has no text blocks, so text isn't shown twice.
     * @param {ApiMessage} apiMessage The message.
     * @returns {string} The HTML, or an empty string.
     */
    static #textFieldHtml(apiMessage) {
      return MessageContent.#textBlocks(apiMessage).length === 0 ? MessageContent.textHtml(apiMessage.text) : '';
    }

    /**
     * Text blocks of a message that contain text.
     * @param {ApiMessage} apiMessage The message.
     * @returns {ContentBlock[]} The blocks.
     */
    static #textBlocks(apiMessage) {
      return (apiMessage.content ?? []).filter(block => block.type === 'text' && block.text);
    }

    /**
     * HTML of one content block.
     * @param {ContentBlock} block The block.
     * @returns {string} The HTML; empty for unsupported block types.
     */
    static #contentBlockHtml(block) {
      const renderBlock = MessageContent.#BLOCK_RENDERERS.get(block.type);
      return renderBlock ? renderBlock(block) : '';
    }

    /**
     * HTML of a tool call: its name, with the input in a collapsible section.
     * @param {ContentBlock} block A tool_use block.
     * @returns {string} The HTML.
     */
    static #toolCallHtml(block) {
      return MessageContent.#collapsibleHtml(`🔧 ${escapeHtml(block.name || 'tool')}`, JSON.stringify(block.input ?? {}, null, 2));
    }

    /**
     * HTML of a tool result: the titles of its items, with the truncated JSON in a collapsible section.
     * @param {ContentBlock} block A tool_result block.
     * @returns {string} The HTML.
     */
    static #toolResultHtml(block) {
      const items = Array.isArray(block.content) ? block.content : [];
      const itemLabels = items.map(item => MessageContent.#resultItemLabel(item)).filter(Boolean).join(', ');
      const summaryHtml = itemLabels ? `📄 result: ${escapeHtml(itemLabels)}` : '📄 result';
      return MessageContent.#collapsibleHtml(summaryHtml, JSON.stringify(items, null, 2).slice(0, LIMITS.toolResultCharacters));
    }

    /**
     * Short label of a tool result item.
     * @param {?object} item The item.
     * @returns {string} Its title, else its type, else an empty string.
     */
    static #resultItemLabel(item) {
      return item ? item.title || item.type || '' : '';
    }

    /**
     * HTML of a collapsible section with preformatted content.
     * @param {string} summaryHtml HTML of the always-visible summary.
     * @param {string} detailText Plain text shown when expanded.
     * @returns {string} The HTML.
     */
    static #collapsibleHtml(summaryHtml, detailText) {
      return `<details class="claude-plus-tool-details"><summary>${summaryHtml}</summary><pre>${escapeHtml(detailText)}</pre></details>`;
    }
  }

  /**
   * One message as shown in the chat. Messages with isPersisted = false exist only locally (a
   * prompt the server never accepted, or an error notice) and are never used as a parent.
   */
  class ChatMessage {
    /**
     * Values of fields not given to the constructor.
     * @type {object}
     */
    static #DEFAULTS = Object.freeze({ parentId: null, text: '', apiMessage: null, isPersisted: true, isStreaming: false, errorText: null });

    /**
     * Cached HTML; null when it must be re-rendered.
     * @type {?string}
     */
    #cachedHtml = null;

    /**
     * Creates a message.
     * @param {object} fields Message fields; omitted ones take the defaults in parentheses.
     * @param {string} fields.id Message id.
     * @param {string} fields.sender 'human' or 'assistant'.
     * @param {?string} [fields.parentId] Parent message id (null).
     * @param {string} [fields.text] Plain text ('').
     * @param {?ApiMessage} [fields.apiMessage] API message to render instead of the text (null).
     * @param {boolean} [fields.isPersisted] Whether the server has the message (true).
     * @param {boolean} [fields.isStreaming] Whether text is still arriving (false).
     * @param {?string} [fields.errorText] Error shown under the message (null).
     */
    constructor(fields) {
      const values = { ...ChatMessage.#DEFAULTS, ...fields };
      this.id = values.id;
      this.sender = values.sender;
      this.parentId = values.parentId;
      this.text = values.text;
      this.apiMessage = values.apiMessage;
      this.isPersisted = values.isPersisted;
      this.isStreaming = values.isStreaming;
      this.errorText = values.errorText;
    }

    /**
     * Creates a message from its API representation.
     * @param {ApiMessage} apiMessage The API message.
     * @returns {ChatMessage} The persisted message.
     */
    static fromApi(apiMessage) {
      return new ChatMessage({
        id: apiMessage.uuid,
        parentId: apiMessage.parent_message_uuid ?? null,
        sender: apiMessage.sender,
        text: MessageContent.plainText(apiMessage),
        apiMessage,
      });
    }

    /**
     * Rendered content, cached until the text changes.
     * @returns {string} HTML of the API message, or of the plain text for local messages.
     */
    get html() {
      this.#cachedHtml ??= this.apiMessage ? MessageContent.toHtml(this.apiMessage) : MessageContent.textHtml(this.text);
      return this.#cachedHtml;
    }

    /**
     * Appends streamed text.
     * @param {string} addedText Text to append.
     * @returns {void}
     */
    appendText(addedText) {
      this.text += addedText;
      this.#cachedHtml = null;
    }
  }

  /**
   * Selects the branch of a conversation tree that claude.ai shows.
   */
  class ConversationTree {
    /**
     * The messages from the root to the current leaf. Falls back to every message when the tree
     * fields aren't present.
     * @param {ApiConversation} conversation The conversation.
     * @returns {ApiMessage[]} The branch, oldest first.
     */
    static currentBranch(conversation) {
      const messages = conversation.chat_messages ?? [];
      const messagesById = new Map(messages.map(message => [message.uuid, message]));
      const leafMessage = messagesById.get(conversation.current_leaf_message_uuid);
      return ConversationTree.#hasTreeFields(messages, leafMessage) ? ConversationTree.#pathToRoot(leafMessage, messagesById) : messages;
    }

    /**
     * Whether the messages carry enough information to walk the tree.
     * @param {ApiMessage[]} messages All messages.
     * @param {ApiMessage|undefined} leafMessage The current leaf, if found.
     * @returns {boolean} True when the leaf exists and every message has a parent field.
     */
    static #hasTreeFields(messages, leafMessage) {
      return Boolean(leafMessage) && messages.every(message => 'parent_message_uuid' in message);
    }

    /**
     * Follows parent links from a message to the root, stopping at a missing or repeated message.
     * @param {ApiMessage} leafMessage Starting message.
     * @param {Map<string, ApiMessage>} messagesById Every message by id.
     * @returns {ApiMessage[]} The path, root first.
     */
    static #pathToRoot(leafMessage, messagesById) {
      const path = [];
      const visitedIds = new Set();
      for (let message = leafMessage; message && !visitedIds.has(message.uuid); message = messagesById.get(message.parent_message_uuid)) {
        visitedIds.add(message.uuid);
        path.push(message);
      }
      return path.reverse();
    }
  }

  /**
   * Composer options persisted in localStorage, shared by all chat panes. Values outside the allowed
   * list read as the default.
   * @fires ComposerSettings#settings An option changed.
   */
  class ComposerSettings extends EventEmitter {
    /**
     * Backing storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Creates the settings on top of a preference store.
     * @param {Preferences} preferences Backing storage.
     */
    constructor(preferences) {
      super();
      this.#preferences = preferences;
    }

    /**
     * Selected model id.
     * @returns {string} An id from MODELS.
     */
    get model() {
      return this.#readAllowed(STORAGE_KEYS.model, MODELS.map(option => option.id));
    }

    /**
     * Selects a model; ids not in MODELS are ignored.
     * @param {string} modelId Model id.
     */
    set model(modelId) {
      this.#writeIfAllowed(STORAGE_KEYS.model, modelId, MODELS.map(option => option.id));
    }

    /**
     * Selected effort level.
     * @returns {string} An id from EFFORTS.
     */
    get effort() {
      return this.#readAllowed(STORAGE_KEYS.effort, EFFORTS.map(option => option.id));
    }

    /**
     * Selects an effort level; ids not in EFFORTS are ignored.
     * @param {string} effortId Effort id.
     */
    set effort(effortId) {
      this.#writeIfAllowed(STORAGE_KEYS.effort, effortId, EFFORTS.map(option => option.id));
    }

    /**
     * Selected thinking mode.
     * @returns {string} A value of THINKING_MODES.
     */
    get thinkingMode() {
      return this.#readAllowed(STORAGE_KEYS.thinkingMode, Object.values(THINKING_MODES));
    }

    /**
     * Selects a thinking mode; values not in THINKING_MODES are ignored.
     * @param {string} thinkingMode Thinking mode.
     */
    set thinkingMode(thinkingMode) {
      this.#writeIfAllowed(STORAGE_KEYS.thinkingMode, thinkingMode, Object.values(THINKING_MODES));
    }

    /**
     * Current values for a completion request.
     * @returns {ComposerSnapshot} The options.
     */
    snapshot() {
      return { model: this.model, effort: this.effort, thinkingMode: this.thinkingMode };
    }

    /**
     * Reads a stored option.
     * @param {string} key Storage key.
     * @param {string[]} allowedValues Allowed values; the first is the default.
     * @returns {string} The stored value if allowed, otherwise the default.
     */
    #readAllowed(key, allowedValues) {
      const storedValue = this.#preferences.read(key);
      return allowedValues.includes(storedValue) ? storedValue : allowedValues[0];
    }

    /**
     * Stores an option if it is allowed and announces the change.
     * @param {string} key Storage key.
     * @param {string} value Value to store.
     * @param {string[]} allowedValues Allowed values.
     * @returns {void}
     */
    #writeIfAllowed(key, value, allowedValues) {
      if (!allowedValues.includes(value)) return;
      this.#preferences.write(key, value);
      this.publish('settings');
    }
  }

  /**
   * State of one prompt/reply exchange while it is being sent.
   */
  class Turn {
    /**
     * Creates the turn.
     * @param {object} fields Turn fields.
     * @param {string} fields.conversationId Conversation the prompt belongs to.
     * @param {boolean} fields.isNewConversation Whether the prompt creates the conversation.
     * @param {string} fields.prompt Prompt text.
     * @param {ChatMessage} fields.promptMessage The prompt's message.
     * @param {AbortController} fields.abortController Aborts the request.
     */
    constructor({ conversationId, isNewConversation, prompt, promptMessage, abortController }) {
      this.conversationId = conversationId;
      this.isNewConversation = isNewConversation;
      this.prompt = prompt;
      this.promptMessage = promptMessage;
      this.abortController = abortController;
      this.replyMessage = null;
      this.hasFailed = false;
    }
  }

  /**
   * The shared list of the user's conversations, as shown in the sidebar.
   * @fires ConversationDirectory#conversations The list changed.
   * @fires ConversationDirectory#conversationDeleted A conversation was deleted; payload is its id.
   */
  class ConversationDirectory extends EventEmitter {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Conversations, newest first.
     * @type {ConversationListing[]}
     */
    #conversations = [];

    /**
     * Creates the directory.
     * @param {ClaudeApi} api API client.
     */
    constructor(api) {
      super();
      this.#api = api;
    }

    /**
     * The listed conversations.
     * @returns {ConversationListing[]} Conversations, newest first.
     */
    get conversations() {
      return this.#conversations;
    }

    /**
     * Reloads the list. Failures are logged and leave the current list in place.
     * @returns {Promise<void>} Resolves once reloaded or failed.
     */
    async refresh() {
      try {
        this.#conversations = await this.#api.listConversations(0, LIMITS.sidebarPageSize);
      } catch (error) {
        console.warn(LOG_PREFIX, 'loading conversations failed', error);
      }
      this.publish('conversations');
    }

    /**
     * Display title of a listed conversation.
     * @param {string} conversationId Conversation id.
     * @returns {string} Its title, or UNTITLED when it has none or isn't listed.
     */
    titleOf(conversationId) {
      const conversation = this.#conversations.find(listing => listing.uuid === conversationId);
      return (conversation && conversation.name) || UNTITLED;
    }

    /**
     * Adds a just-created conversation to the top of the list.
     * @param {string} conversationId Conversation id.
     * @param {string} prompt First prompt, used as a provisional title.
     * @returns {void}
     */
    registerNewConversation(conversationId, prompt) {
      const listing = { uuid: conversationId, name: prompt.slice(0, LIMITS.provisionalTitleLength), updated_at: new Date().toISOString() };
      this.#conversations = [listing, ...this.#conversations];
      this.publish('conversations');
    }

    /**
     * Updates a listed conversation's title and time from the server and moves it to the top.
     * @param {ApiConversation} conversation The fetched conversation.
     * @returns {void}
     */
    updateListing(conversation) {
      const existing = this.#conversations.find(listing => listing.uuid === conversation.uuid);
      if (!existing) return;
      const updated = { ...existing, name: conversation.name || existing.name, updated_at: conversation.updated_at || existing.updated_at };
      this.#conversations = [updated, ...this.#conversations.filter(listing => listing !== existing)];
      this.publish('conversations');
    }

    /**
     * Permanently deletes a conversation.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once deleted.
     * @throws {ApiError} When the server refuses; nothing changes locally.
     */
    async deleteConversation(conversationId) {
      await this.#api.deleteConversation(conversationId);
      this.#conversations = this.#conversations.filter(conversation => conversation.uuid !== conversationId);
      this.publish('conversations');
      this.publish('conversationDeleted', conversationId);
    }
  }

  /**
   * One chat: the conversation open in a chat pane, its messages and the prompt being sent. Every
   * chat pane has its own session, so several conversations can be open and streaming at once.
   * @fires ChatSession#openConversation The open conversation changed.
   * @fires ChatSession#messages The message list changed.
   * @fires ChatSession#messageContent One message's content changed; payload is the ChatMessage.
   * @fires ChatSession#sending Sending started or ended.
   * @fires ChatSession#conversationLoaded A conversation was fetched; payload is the ApiConversation.
   * @fires ChatSession#rateLimits Usage windows arrived in a stream; payload is RateLimits.
   */
  class ChatSession extends EventEmitter {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Model options for new prompts.
     * @type {ComposerSettings}
     */
    #settings;

    /**
     * Shared conversation list, updated when this session creates or reloads a conversation.
     * @type {ConversationDirectory}
     */
    #directory;

    /**
     * Open conversation id, or null for a new chat.
     * @type {?string}
     */
    #openConversationId = null;

    /**
     * Messages of the open conversation's current branch.
     * @type {ChatMessage[]}
     */
    #messages = [];

    /**
     * Whether a prompt is being sent.
     * @type {boolean}
     */
    #isSending = false;

    /**
     * Aborts the prompt being sent.
     * @type {?AbortController}
     */
    #abortController = null;

    /**
     * Incremented on every navigation, so late responses for an old one are dropped.
     * @type {number}
     */
    #navigationCount = 0;

    /**
     * Handler per stream event type.
     * @type {Map<string, function(Turn, object): void>}
     */
    #streamEventHandlers = new Map([
      [STREAM_START, (turn, event) => this.#onStreamStart(turn, event)],
      ['content_block_delta', (turn, event) => this.#onContentDelta(turn, event)],
      ['message_limit', (turn, event) => this.#onMessageLimit(event)],
      ['message_stop', turn => this.#onMessageStop(turn)],
    ]);

    /**
     * Creates an empty session showing a new chat.
     * @param {ClaudeApi} api API client.
     * @param {ComposerSettings} settings Model options for new prompts.
     * @param {ConversationDirectory} directory Shared conversation list.
     */
    constructor(api, settings, directory) {
      super();
      this.#api = api;
      this.#settings = settings;
      this.#directory = directory;
    }

    /**
     * Open conversation.
     * @returns {?string} Its id, or null for a new chat.
     */
    get openConversationId() {
      return this.#openConversationId;
    }

    /**
     * Messages of the open conversation.
     * @returns {ChatMessage[]} The current branch, oldest first.
     */
    get messages() {
      return this.#messages;
    }

    /**
     * Whether a prompt is being sent.
     * @returns {boolean} True while sending.
     */
    get isSending() {
      return this.#isSending;
    }

    /**
     * Opens a conversation, stopping any reply in progress. A load failure is shown as an error notice.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once the messages or the error notice are shown.
     */
    async openConversation(conversationId) {
      const navigation = this.#beginNavigation(conversationId);
      try {
        const conversation = await this.#api.getConversation(conversationId);
        if (this.#isLatestNavigation(navigation)) this.#showConversation(conversation);
      } catch (error) {
        this.#showLoadError(navigation, error);
      }
    }

    /**
     * Switches to an empty new chat, stopping any reply in progress.
     * @returns {void}
     */
    startNewConversation() {
      this.#beginNavigation(null);
    }

    /**
     * Aborts the reply in progress, keeping the text received so far.
     * @returns {void}
     */
    stopReply() {
      if (this.#abortController) this.#abortController.abort();
    }

    /**
     * Sends a prompt as a reply to the last persisted message. Ignored while sending or for blank prompts.
     * @param {string} prompt Prompt text.
     * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
     */
    sendPrompt(prompt) {
      return this.#sendPromptAfter(prompt, this.#lastPersistedMessageIdBefore(this.#messages.length));
    }

    /**
     * Asks the last prompt again as a new branch from the same parent, replacing the answer shown.
     * Ignored while sending.
     * @returns {void}
     */
    retryLastPrompt() {
      if (this.#isSending) return;
      const promptIndex = this.#messages.findLastIndex(message => message.sender === 'human');
      if (promptIndex === -1) return;
      const promptMessage = this.#messages[promptIndex];
      this.#setMessages(this.#messages.slice(0, promptIndex));
      this.#sendPromptAfter(promptMessage.text, promptMessage.parentId ?? this.#lastPersistedMessageIdBefore(promptIndex));
    }

    /**
     * Stops any reply, clears the messages and makes a conversation (or a new chat) open.
     * @param {?string} conversationId Conversation to open, or null for a new chat.
     * @returns {number} Number identifying this navigation.
     */
    #beginNavigation(conversationId) {
      this.stopReply();
      this.#navigationCount += 1;
      this.#setOpenConversation(conversationId);
      this.#setMessages([]);
      return this.#navigationCount;
    }

    /**
     * Whether a navigation is still the latest one.
     * @param {number} navigation Number returned by #beginNavigation.
     * @returns {boolean} True if no navigation happened since.
     */
    #isLatestNavigation(navigation) {
      return navigation === this.#navigationCount;
    }

    /**
     * Shows a conversation load failure, unless the user has navigated away since.
     * @param {number} navigation Number of the failed navigation.
     * @param {Error} error The failure.
     * @returns {void}
     */
    #showLoadError(navigation, error) {
      if (!this.#isLatestNavigation(navigation)) return;
      console.warn(LOG_PREFIX, 'loading conversation failed', error);
      this.#setMessages([ChatSession.#createErrorNotice(`Could not load this conversation (${error.message}).`)]);
    }

    /**
     * Sends a prompt as a reply to a given message and streams the answer into the chat.
     * @param {string} prompt Prompt text; ignored if blank.
     * @param {?string} parentMessageId Message to reply to; null for the conversation root.
     * @returns {Promise<void>} Resolves when the reply has ended, failed or been stopped.
     */
    async #sendPromptAfter(prompt, parentMessageId) {
      if (!prompt.trim() || this.#isSending) return;
      const turn = this.#beginTurn(prompt, parentMessageId);
      try {
        await this.#streamReply(turn);
      } catch (error) {
        this.#showSendFailure(turn, error);
      } finally {
        this.#finishTurn(turn);
      }
    }

    /**
     * Shows the prompt and marks the session as sending.
     * @param {string} prompt Prompt text.
     * @param {?string} parentMessageId Message to reply to.
     * @returns {Turn} The new turn.
     */
    #beginTurn(prompt, parentMessageId) {
      const promptMessage = new ChatMessage({ id: createLocalMessageId(), parentId: parentMessageId, sender: 'human', text: prompt, isPersisted: false });
      const turn = new Turn({
        conversationId: this.#openConversationId ?? crypto.randomUUID(),
        isNewConversation: this.#openConversationId === null,
        prompt,
        promptMessage,
        abortController: new AbortController(),
      });
      this.#abortController = turn.abortController;
      this.#setMessages([...this.#messages, promptMessage]);
      this.#setSending(true);
      return turn;
    }

    /**
     * Sends the turn's prompt and applies each stream event.
     * @param {Turn} turn The turn.
     * @returns {Promise<void>} Resolves when the stream ends.
     * @throws {ApiError|DOMException} When the request fails or is aborted.
     */
    async #streamReply(turn) {
      const events = this.#api.streamCompletion({
        conversationId: turn.conversationId,
        prompt: turn.prompt,
        parentMessageId: turn.promptMessage.parentId ?? ROOT_MESSAGE_UUID,
        isNew: turn.isNewConversation,
        settings: this.#settings.snapshot(),
        signal: turn.abortController.signal,
      });
      for await (const event of events) this.#handleStreamEvent(turn, event);
    }

    /**
     * Applies one stream event; unknown types are ignored.
     * @param {Turn} turn The turn.
     * @param {StreamEvent} event The event.
     * @returns {void}
     */
    #handleStreamEvent(turn, event) {
      const handleEvent = this.#streamEventHandlers.get(event.type);
      if (handleEvent) handleEvent(turn, event);
    }

    /**
     * Marks the prompt as accepted and adds the empty reply; registers a new conversation.
     * @param {Turn} turn The turn.
     * @param {{humanMessageId: string, assistantMessageId: string}} event The STREAM_START event.
     * @returns {void}
     */
    #onStreamStart(turn, event) {
      turn.promptMessage.id = event.humanMessageId;
      turn.promptMessage.isPersisted = true;
      turn.replyMessage = new ChatMessage({ id: event.assistantMessageId, parentId: event.humanMessageId, sender: 'assistant', isStreaming: true });
      if (turn.isNewConversation) this.#registerNewConversation(turn.conversationId, turn.prompt);
      this.#setMessages([...this.#messages, turn.replyMessage]);
    }

    /**
     * Appends streamed reply text.
     * @param {Turn} turn The turn.
     * @param {{delta: ?{type: string, text: string}}} event A content_block_delta event.
     * @returns {void}
     */
    #onContentDelta(turn, event) {
      if (!turn.replyMessage || !ChatSession.#isTextDelta(event)) return;
      turn.replyMessage.appendText(event.delta.text);
      this.publish('messageContent', turn.replyMessage);
    }

    /**
     * Whether a content_block_delta event carries text.
     * @param {{delta: ?{type: string}}} event The event.
     * @returns {boolean} True for text deltas.
     */
    static #isTextDelta(event) {
      return Boolean(event.delta) && event.delta.type === 'text_delta';
    }

    /**
     * Publishes the usage windows reported during the stream.
     * @param {{message_limit: ?{windows: ?Object<string, UsageWindow>}}} event A message_limit event.
     * @returns {void}
     */
    #onMessageLimit(event) {
      const windows = event.message_limit ? event.message_limit.windows : null;
      if (windows) this.publish('rateLimits', { fiveHour: windows['5h'], sevenDay: windows['7d'] });
    }

    /**
     * Marks the reply as complete.
     * @param {Turn} turn The turn.
     * @returns {void}
     */
    #onMessageStop(turn) {
      if (!turn.replyMessage) return;
      turn.replyMessage.isStreaming = false;
      this.publish('messageContent', turn.replyMessage);
    }

    /**
     * Shows a send failure under the reply, or as a separate notice when no reply exists yet. A user
     * stop (AbortError) isn't a failure.
     * @param {Turn} turn The turn.
     * @param {Error} error The failure.
     * @returns {void}
     */
    #showSendFailure(turn, error) {
      if (error.name === 'AbortError') return;
      turn.hasFailed = true;
      console.warn(LOG_PREFIX, 'send failed', error);
      if (turn.replyMessage) turn.replyMessage.errorText = error.message;
      else this.#messages.push(ChatSession.#createErrorNotice(error.message));
    }

    /**
     * Ends sending and, if the server accepted the prompt, reloads the conversation from the server.
     * @param {Turn} turn The turn.
     * @returns {void}
     */
    #finishTurn(turn) {
      if (turn.replyMessage) turn.replyMessage.isStreaming = false;
      if (this.#abortController === turn.abortController) this.#abortController = null;
      this.#setSending(false);
      this.publish('messages');
      if (turn.promptMessage.isPersisted) this.#reloadAfterSend(turn.conversationId, !turn.hasFailed);
    }

    /**
     * Fetches the conversation after a send to update the list and the stats, and replaces the
     * optimistic messages with the server's copy (real tool blocks and parent ids).
     * @param {string} conversationId Conversation id.
     * @param {boolean} replaceMessages False after a failure, so the error stays on screen.
     * @returns {Promise<void>} Resolves once done; failures are logged.
     */
    async #reloadAfterSend(conversationId, replaceMessages) {
      try {
        const conversation = await this.#api.getConversation(conversationId);
        this.#directory.updateListing(conversation);
        this.publish('conversationLoaded', conversation);
        if (replaceMessages && this.#isOpenAndIdle(conversationId)) this.#setMessages(ChatSession.#branchMessages(conversation));
      } catch (error) {
        console.warn(LOG_PREFIX, 'refreshing conversation failed', error);
      }
    }

    /**
     * Whether a conversation is open here and not sending.
     * @param {string} conversationId Conversation id.
     * @returns {boolean} True when its messages can be replaced safely.
     */
    #isOpenAndIdle(conversationId) {
      return this.#openConversationId === conversationId && !this.#isSending;
    }

    /**
     * Shows a fetched conversation's current branch and publishes it for the stats.
     * @param {ApiConversation} conversation The conversation.
     * @returns {void}
     */
    #showConversation(conversation) {
      this.#setMessages(ChatSession.#branchMessages(conversation));
      this.publish('conversationLoaded', conversation);
    }

    /**
     * Chat messages of a conversation's current branch.
     * @param {ApiConversation} conversation The conversation.
     * @returns {ChatMessage[]} The messages, oldest first.
     */
    static #branchMessages(conversation) {
      return ConversationTree.currentBranch(conversation).map(apiMessage => ChatMessage.fromApi(apiMessage));
    }

    /**
     * Lists a just-created conversation and makes it the open one.
     * @param {string} conversationId Conversation id.
     * @param {string} prompt First prompt, used as a provisional title.
     * @returns {void}
     */
    #registerNewConversation(conversationId, prompt) {
      this.#directory.registerNewConversation(conversationId, prompt);
      this.#setOpenConversation(conversationId);
    }

    /**
     * Id of the last persisted message before a position.
     * @param {number} index Position to search backwards from (exclusive).
     * @returns {?string} The id, or null when there is none.
     */
    #lastPersistedMessageIdBefore(index) {
      const message = this.#messages.slice(0, index).findLast(candidate => candidate.isPersisted);
      return message ? message.id : null;
    }

    /**
     * Creates a local assistant message showing an error.
     * @param {string} errorText Error text.
     * @returns {ChatMessage} The notice.
     */
    static #createErrorNotice(errorText) {
      return new ChatMessage({ id: createLocalMessageId(), sender: 'assistant', isPersisted: false, errorText });
    }

    /**
     * Changes the open conversation.
     * @param {?string} conversationId Conversation id, or null for a new chat.
     * @returns {void}
     */
    #setOpenConversation(conversationId) {
      if (this.#openConversationId === conversationId) return;
      this.#openConversationId = conversationId;
      this.publish('openConversation');
    }

    /**
     * Replaces the message list.
     * @param {ChatMessage[]} messages New list.
     * @returns {void}
     */
    #setMessages(messages) {
      this.#messages = messages;
      this.publish('messages');
    }

    /**
     * Changes the sending state.
     * @param {boolean} isSending Whether a prompt is being sent.
     * @returns {void}
     */
    #setSending(isSending) {
      this.#isSending = isSending;
      this.publish('sending');
    }
  }

  /**
   * Owns the chat panes: creates, restores, focuses and closes them, and remembers which
   * conversation each one shows. The focused pane is the one the sidebar, the URL and the export act on.
   * @fires ChatPaneManager#focus The focused pane changed.
   * @fires ChatPaneManager#paneConversations A pane opened another conversation; payload is the pane id.
   * @fires ChatPaneManager#conversationLoaded A pane fetched a conversation; payload is the ApiConversation.
   * @fires ChatPaneManager#rateLimits A pane received usage windows; payload is RateLimits.
   */
  class ChatPaneManager extends EventEmitter {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Shared model options.
     * @type {ComposerSettings}
     */
    #settings;

    /**
     * Shared conversation list.
     * @type {ConversationDirectory}
     */
    #directory;

    /**
     * Storage for the open panes.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Session and panel of every pane, by pane id, in creation order.
     * @type {Map<string, {session: ChatSession, panel: ChatPanel}>}
     */
    #panes = new Map();

    /**
     * Conversations to reopen in restored panes once the data has loaded, by pane id.
     * @type {Map<string, string>}
     */
    #conversationsToRestore = new Map();

    /**
     * Id of the focused pane.
     * @type {?string}
     */
    #focusedPaneId = null;

    /**
     * Workspace the panes are docked in; set by attachWorkspace.
     * @type {?DockWorkspace}
     */
    #workspace = null;

    /**
     * Creates the manager without any pane.
     * @param {object} services Shared services.
     * @param {ClaudeApi} services.api API client.
     * @param {ComposerSettings} services.settings Shared model options.
     * @param {ConversationDirectory} services.directory Shared conversation list.
     * @param {Preferences} services.preferences Storage for the open panes.
     */
    constructor({ api, settings, directory, preferences }) {
      super();
      this.#api = api;
      this.#settings = settings;
      this.#directory = directory;
      this.#preferences = preferences;
      directory.subscribe('conversationDeleted', conversationId => this.#closeDeletedConversation(conversationId));
    }

    /**
     * Ids of all panes.
     * @returns {string[]} The ids, in creation order.
     */
    get paneIds() {
      return [...this.#panes.keys()];
    }

    /**
     * Number of open panes.
     * @returns {number} The count.
     */
    get paneCount() {
      return this.#panes.size;
    }

    /**
     * The focused pane.
     * @returns {string} Its id.
     */
    get focusedPaneId() {
      return this.#focusedPaneId;
    }

    /**
     * Session of the focused pane.
     * @returns {ChatSession} The session.
     */
    get focusedSession() {
      return this.#panes.get(this.#focusedPaneId).session;
    }

    /**
     * Recreates the panes stored by the last visit, or one empty pane. Focuses the pane that showed
     * the preferred conversation, otherwise the first one. Their conversations are reopened later by
     * openRestoredConversations.
     * @param {?string} preferredConversationId Conversation in the URL, or null.
     * @returns {void}
     */
    restorePanes(preferredConversationId) {
      const storedPanes = ChatPaneManager.#validStoredPanes(this.#preferences.readJson(STORAGE_KEYS.chatPanes));
      const panes = storedPanes.length ? storedPanes : [{ paneId: ChatPaneManager.#createPaneId(), conversationId: null }];
      panes.forEach(pane => this.#restorePane(pane));
      const preferredPane = panes.find(pane => pane.conversationId !== null && pane.conversationId === preferredConversationId);
      this.#focusedPaneId = (preferredPane || panes[0]).paneId;
    }

    /**
     * The panel of every pane, for docking.
     * @returns {Array<[string, ChatPanel]>} [pane id, panel] pairs.
     */
    panelEntries() {
      return [...this.#panes].map(([paneId, pane]) => [paneId, pane.panel]);
    }

    /**
     * Connects the workspace that new panes are docked in.
     * @param {DockWorkspace} workspace The workspace.
     * @returns {void}
     */
    attachWorkspace(workspace) {
      this.#workspace = workspace;
    }

    /**
     * Reopens the stored conversations of every restored pane except the focused one, whose
     * conversation comes from the URL.
     * @returns {void}
     */
    openRestoredConversations() {
      this.#conversationsToRestore.delete(this.#focusedPaneId);
      this.#conversationsToRestore.forEach((conversationId, paneId) => this.#panes.get(paneId).session.openConversation(conversationId));
      this.#conversationsToRestore.clear();
    }

    /**
     * Opens a new pane next to the focused one and focuses it.
     * @param {?string} conversationId Conversation to show, or null for a new chat.
     * @returns {void}
     */
    openPane(conversationId) {
      const paneId = ChatPaneManager.#createPaneId();
      const pane = this.#createPane(paneId);
      this.#workspace.addPanel(paneId, pane.panel, this.#focusedPaneId);
      this.focusPane(paneId);
      if (conversationId) pane.session.openConversation(conversationId);
      this.#savePanes();
    }

    /**
     * Opens a conversation as a new pane docked exactly where a drag was released, instead of always
     * beside the focused pane. Used to compose several chats side by side without switching between
     * them or mixing their context.
     * @param {string} conversationId Conversation to show.
     * @param {DropTarget} dropTarget Where to dock the new pane.
     * @returns {void}
     */
    openPaneAt(conversationId, dropTarget) {
      const paneId = ChatPaneManager.#createPaneId();
      const pane = this.#createPane(paneId);
      this.#workspace.addPanelAt(paneId, pane.panel, dropTarget);
      this.focusPane(paneId);
      pane.session.openConversation(conversationId);
      this.#savePanes();
    }

    /**
     * Starts dragging a conversation out of the sidebar; releasing over a valid drop target opens it
     * as a new pane docked there.
     * @param {MouseEvent} startEvent The mousedown that starts the drag.
     * @param {string} conversationId Conversation to open on drop.
     * @param {string} label Text shown in the floating drag label.
     * @returns {void}
     */
    beginDragToOpenPane(startEvent, conversationId, label) {
      this.#workspace.beginExternalDrag(startEvent, label, dropTarget => this.openPaneAt(conversationId, dropTarget));
    }

    /**
     * Closes a pane, stopping its reply. The last remaining pane can't be closed.
     * @param {string} paneId Pane id.
     * @returns {void}
     */
    closePane(paneId) {
      if (this.#panes.size <= 1 || !this.#panes.has(paneId)) return;
      if (this.#focusedPaneId === paneId) this.focusPane(this.paneIds.find(id => id !== paneId));
      this.#panes.get(paneId).session.stopReply();
      this.#panes.delete(paneId);
      this.#workspace.removePanel(paneId);
      this.#savePanes();
    }

    /**
     * Makes a pane the focused one.
     * @param {string} paneId Pane id; unknown ids are ignored.
     * @returns {void}
     */
    focusPane(paneId) {
      if (this.#focusedPaneId === paneId || !this.#panes.has(paneId)) return;
      this.#focusedPaneId = paneId;
      this.publish('focus');
    }

    /**
     * Opens a conversation in the focused pane.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once it is shown.
     */
    openInFocusedPane(conversationId) {
      return this.focusedSession.openConversation(conversationId);
    }

    /**
     * Starts a new chat in the focused pane.
     * @returns {void}
     */
    startNewInFocusedPane() {
      this.focusedSession.startNewConversation();
    }

    /**
     * Conversations shown in any pane.
     * @returns {Set<string>} Their ids.
     */
    openConversationIds() {
      return new Set([...this.#panes.values()].map(pane => pane.session.openConversationId).filter(Boolean));
    }

    /**
     * Creates a pane from its stored state, remembering its conversation for later.
     * @param {{paneId: string, conversationId: ?string}} storedPane Stored pane.
     * @returns {void}
     */
    #restorePane({ paneId, conversationId }) {
      this.#createPane(paneId);
      if (conversationId) this.#conversationsToRestore.set(paneId, conversationId);
    }

    /**
     * Creates a pane's session and panel and forwards the session's events.
     * @param {string} paneId Pane id.
     * @returns {{session: ChatSession, panel: ChatPanel}} The pane.
     */
    #createPane(paneId) {
      const session = new ChatSession(this.#api, this.#settings, this.#directory);
      const panel = new ChatPanel({ paneId, session, settings: this.#settings, directory: this.#directory, paneManager: this });
      session.subscribe('openConversation', () => this.#onPaneConversationChanged(paneId));
      session.subscribe('conversationLoaded', conversation => this.publish('conversationLoaded', conversation));
      session.subscribe('rateLimits', limits => this.publish('rateLimits', limits));
      const pane = { session, panel };
      this.#panes.set(paneId, pane);
      return pane;
    }

    /**
     * Saves the panes and announces that a pane shows another conversation.
     * @param {string} paneId Pane id.
     * @returns {void}
     */
    #onPaneConversationChanged(paneId) {
      this.#savePanes();
      this.publish('paneConversations', paneId);
    }

    /**
     * Switches every pane showing a deleted conversation to a new chat.
     * @param {string} conversationId The deleted conversation.
     * @returns {void}
     */
    #closeDeletedConversation(conversationId) {
      for (const pane of this.#panes.values()) {
        if (pane.session.openConversationId === conversationId) pane.session.startNewConversation();
      }
    }

    /**
     * Stores every pane and its conversation.
     * @returns {void}
     */
    #savePanes() {
      const storedPanes = [...this.#panes].map(([paneId, pane]) => ({ paneId, conversationId: pane.session.openConversationId }));
      this.#preferences.writeJson(STORAGE_KEYS.chatPanes, storedPanes);
    }

    /**
     * Creates a unique pane id.
     * @returns {string} An id starting with "chat-".
     */
    static #createPaneId() {
      return `chat-${crypto.randomUUID()}`;
    }

    /**
     * The well-formed entries of a stored pane list.
     * @param {*} storedPanes Parsed stored value.
     * @returns {Array<{paneId: string, conversationId: ?string}>} Valid panes; empty when nothing valid is stored.
     */
    static #validStoredPanes(storedPanes) {
      return Array.isArray(storedPanes) ? storedPanes.filter(ChatPaneManager.#isValidStoredPane) : [];
    }

    /**
     * Whether a stored pane entry is well formed.
     * @param {*} storedPane Stored entry.
     * @returns {boolean} True for an object with a "chat-" pane id and a string or null conversation id.
     */
    static #isValidStoredPane(storedPane) {
      return Boolean(storedPane) && String(storedPane.paneId).startsWith('chat-') && (storedPane.conversationId === null || typeof storedPane.conversationId === 'string');
    }
  }

  /**
   * Keeps the URL in sync with the focused pane's conversation and handles back/forward navigation.
   */
  class Router {
    /**
     * Chat panes.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Creates the router.
     * @param {ChatPaneManager} paneManager Chat panes.
     */
    constructor(paneManager) {
      this.#paneManager = paneManager;
    }

    /**
     * Opens what the current URL points to in the focused pane and starts following navigation.
     * @returns {Promise<void>} Resolves once the conversation is shown.
     */
    async start() {
      window.addEventListener('popstate', () => this.#openFromUrl());
      this.#paneManager.subscribe('focus', () => this.#updateUrlToFocusedConversation());
      this.#paneManager.subscribe('paneConversations', paneId => this.#onPaneConversationChanged(paneId));
      await this.#openFromUrl();
    }

    /**
     * Opens a conversation in the focused pane as a user navigation, adding a history entry.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once the conversation is shown.
     */
    openConversation(conversationId) {
      if (conversationIdFromPath(location.pathname) !== conversationId) history.pushState(null, '', conversationPath(conversationId));
      return this.#paneManager.openInFocusedPane(conversationId);
    }

    /**
     * Starts a new chat in the focused pane as a user navigation, adding a history entry.
     * @returns {void}
     */
    startNewConversation() {
      if (location.pathname !== NEW_CHAT_PATH) history.pushState(null, '', NEW_CHAT_PATH);
      this.#paneManager.startNewInFocusedPane();
    }

    /**
     * Opens the conversation in the URL, or a new chat, in the focused pane.
     * @returns {Promise<void>} Resolves once a conversation is shown.
     */
    async #openFromUrl() {
      const conversationId = conversationIdFromPath(location.pathname);
      if (conversationId) await this.#paneManager.openInFocusedPane(conversationId);
      else this.#paneManager.startNewInFocusedPane();
    }

    /**
     * Follows conversation changes of the focused pane only.
     * @param {string} paneId Pane whose conversation changed.
     * @returns {void}
     */
    #onPaneConversationChanged(paneId) {
      if (paneId === this.#paneManager.focusedPaneId) this.#updateUrlToFocusedConversation();
    }

    /**
     * Points the URL at the focused pane's conversation, replacing the history entry rather than adding one.
     * @returns {void}
     */
    #updateUrlToFocusedConversation() {
      const openId = this.#paneManager.focusedSession.openConversationId;
      if (openId === conversationIdFromPath(location.pathname)) return;
      history.replaceState(null, '', openId ? conversationPath(openId) : NEW_CHAT_PATH);
    }
  }

  /**
   * Computes a ConversationSummary from a full conversation.
   */
  class ConversationSummarizer {
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
     */
    constructor(conversation) {
      this.#summary = {
        conversationId: conversation.uuid,
        title: conversation.name || UNTITLED,
        updatedAt: conversation.updated_at,
        promptCount: 0,
        toolCallCounts: Object.create(null),
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
     * @returns {ConversationSummary} The summary.
     */
    static summarize(conversation) {
      const summarizer = new ConversationSummarizer(conversation);
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
        this.#summary.files.push({ path: name, title: name, timestamp: upload.created_at || message.created_at, source: 'user' });
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
      for (const block of message.content ?? []) this.#addContentBlock(block, block.stop_timestamp || message.created_at, producedFilesByPath);
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
     * @param {Map<string, FileEntry>} producedFilesByPath Files produced by the reply, keyed by path; the last write wins.
     * @returns {void}
     */
    #addContentBlock(block, blockTime, producedFilesByPath) {
      if (block.type === 'tool_use') this.#addToolCall(block, blockTime, producedFilesByPath);
      else if (block.type === 'tool_result') this.#addToolResult(block, blockTime);
    }

    /**
     * Counts a tool call and records the file it produced, if any.
     * @param {ContentBlock} block A tool_use block.
     * @param {string} blockTime Timestamp of the block.
     * @param {Map<string, FileEntry>} producedFilesByPath Files produced by the reply, keyed by path.
     * @returns {void}
     */
    #addToolCall(block, blockTime, producedFilesByPath) {
      const toolName = block.name || 'unknown_tool';
      addToCount(this.#summary.toolCallCounts, toolName, 1);
      const describeFile = ConversationSummarizer.#FILE_PRODUCING_TOOLS.get(toolName);
      if (!describeFile || !block.input) return;
      const { path, title } = describeFile(block.input);
      producedFilesByPath.set(path, { path, title: title || lastPathSegment(path), timestamp: blockTime, source: 'claude' });
    }

    /**
     * Records the web sources a tool result cites.
     * @param {ContentBlock} block A tool_result block.
     * @param {string} blockTime Timestamp of the block.
     * @returns {void}
     */
    #addToolResult(block, blockTime) {
      const items = Array.isArray(block.content) ? block.content : [];
      for (const item of items.filter(ConversationSummarizer.#isWebSource)) {
        this.#summary.sources.push({ title: item.title, url: item.url, ...hostParts(item.url), timestamp: blockTime });
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

  /**
   * Totals across every stored conversation summary.
   */
  class StatsAggregate {
    /**
     * Creates empty totals.
     */
    constructor() {
      this.conversationCount = 0;
      this.promptCount = 0;
      this.estimatedTokensIn = 0;
      this.estimatedTokensOut = 0;
      this.responseTimesMs = [];
      this.toolCallCounts = Object.create(null);
      this.outletCounts = Object.create(null);
      this.topLevelDomains = new Set();
      this.sources = [];
      this.folders = [];

      /**
       * Prompt and file counts by conversation id, for showing them as sidebar columns without
       * needing a separate lookup structure. Only conversations that have been indexed (opened, or
       * pulled in by a backfill) appear here.
       * @type {Map<string, {promptCount: number, fileCount: number}>}
       */
      this.perConversation = new Map();
    }

    /**
     * Aggregates summaries. Sources end up newest first; folders most recently active first.
     * @param {ConversationSummary[]} summaries Stored summaries.
     * @returns {StatsAggregate} The totals.
     */
    static fromSummaries(summaries) {
      const aggregate = new StatsAggregate();
      summaries.forEach(summary => aggregate.#addSummary(summary));
      aggregate.sources.sort((first, second) => toEpochMs(second.timestamp) - toEpochMs(first.timestamp));
      aggregate.folders.sort((first, second) => second.newestFileTime - first.newestFileTime);
      return aggregate;
    }

    /**
     * Adds one conversation's summary.
     * @param {ConversationSummary} summary The summary.
     * @returns {void}
     */
    #addSummary(summary) {
      const origin = { conversationTitle: summary.title, conversationId: summary.conversationId };
      this.conversationCount += 1;
      this.promptCount += summary.promptCount;
      this.estimatedTokensIn += summary.estimatedTokensIn;
      this.estimatedTokensOut += summary.estimatedTokensOut;
      this.responseTimesMs.push(...summary.responseTimesMs);
      this.#addToolCallCounts(summary.toolCallCounts);
      this.#addSources(summary.sources, origin);
      this.#addFolder(summary.files, origin);
      this.perConversation.set(summary.conversationId, { promptCount: summary.promptCount, fileCount: summary.files.length });
    }

    /**
     * Adds tool call counts.
     * @param {Object<string, number>} toolCallCounts Calls per tool name.
     * @returns {void}
     */
    #addToolCallCounts(toolCallCounts) {
      for (const [toolName, count] of Object.entries(toolCallCounts)) addToCount(this.toolCallCounts, toolName, count);
    }

    /**
     * Adds web sources and counts their outlets and top-level domains.
     * @param {SourceEntry[]} sources The sources.
     * @param {{conversationTitle: string, conversationId: string}} origin Conversation they came from.
     * @returns {void}
     */
    #addSources(sources, origin) {
      for (const source of sources) {
        this.sources.push({ ...source, ...origin });
        if (source.outlet) addToCount(this.outletCounts, source.outlet, 1);
        if (source.topLevelDomain) this.topLevelDomains.add(source.topLevelDomain);
      }
    }

    /**
     * Adds a conversation's files as one folder; conversations without files get none.
     * @param {FileEntry[]} files The files.
     * @param {{conversationTitle: string, conversationId: string}} origin Conversation they came from.
     * @returns {void}
     */
    #addFolder(files, origin) {
      if (files.length === 0) return;
      const entries = files.map(file => ({ ...file, ...origin, extension: fileExtension(file.title || file.path) }));
      this.folders.push({ ...origin, files: entries, newestFileTime: Math.max(...entries.map(entry => toEpochMs(entry.timestamp))) });
    }
  }

  /**
   * Per-conversation summaries cached in IndexedDB, plus their aggregate.
   * @fires StatsIndex#aggregate The aggregate was recomputed.
   * @fires StatsIndex#backfill Backfill progress changed.
   */
  class StatsIndex extends EventEmitter {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Summary cache.
     * @type {IndexedDbStore}
     */
    #database;

    /**
     * Current totals.
     * @type {StatsAggregate}
     */
    #aggregate = new StatsAggregate();

    /**
     * Backfill state.
     * @type {BackfillProgress}
     */
    #backfill = { isRunning: false, processedCount: 0, totalCount: 0 };

    /**
     * Conversations stored during the running backfill.
     * @type {number}
     */
    #storedDuringBackfill = 0;

    /**
     * Creates the index.
     * @param {ClaudeApi} api API client.
     * @param {IndexedDbStore} database Summary cache.
     */
    constructor(api, database) {
      super();
      this.#api = api;
      this.#database = database;
    }

    /**
     * Current totals.
     * @returns {StatsAggregate} The aggregate.
     */
    get aggregate() {
      return this.#aggregate;
    }

    /**
     * Backfill state.
     * @returns {BackfillProgress} A copy of the progress.
     */
    get backfill() {
      return { ...this.#backfill };
    }

    /**
     * Recomputes the aggregate from the cache. Failures are logged and keep the previous totals.
     * @returns {Promise<void>} Resolves once recomputed or failed.
     */
    async refreshAggregate() {
      try {
        this.#aggregate = StatsAggregate.fromSummaries(await this.#database.readAll(DATABASE.stores.conversationSummaries));
        this.publish('aggregate');
      } catch (error) {
        console.warn(LOG_PREFIX, 'reading stats failed', error);
      }
    }

    /**
     * Stores a conversation's summary if it changed, then recomputes the aggregate. Failures are logged.
     * @param {ApiConversation} conversation The conversation.
     * @returns {Promise<void>} Resolves once done.
     */
    async indexConversation(conversation) {
      try {
        if (await this.#storeSummaryIfOutdated(conversation)) await this.refreshAggregate();
      } catch (error) {
        console.warn(LOG_PREFIX, 'indexing conversation failed', error);
      }
    }

    /**
     * Removes a deleted conversation's summary, then recomputes the aggregate. Failures are logged.
     * @param {string} conversationId Conversation id.
     * @returns {Promise<void>} Resolves once done.
     */
    async removeConversation(conversationId) {
      try {
        await this.#database.remove(DATABASE.stores.conversationSummaries, conversationId);
        await this.refreshAggregate();
      } catch (error) {
        console.warn(LOG_PREFIX, 'removing conversation stats failed', error);
      }
    }

    /**
     * Fetches and stores every conversation not yet cached at its current version. Ignored while
     * running; cancellable with cancelBackfill. Failures are logged.
     * @returns {Promise<void>} Resolves when finished, cancelled or failed.
     */
    async runBackfill() {
      if (this.#backfill.isRunning) return;
      this.#storedDuringBackfill = 0;
      this.#updateBackfill({ isRunning: true, processedCount: 0, totalCount: 0 });
      try {
        await this.#indexListings(await this.#listAllConversations());
      } catch (error) {
        console.warn(LOG_PREFIX, 'indexing history failed', error);
      } finally {
        this.#updateBackfill({ isRunning: false });
        await this.refreshAggregate();
      }
    }

    /**
     * Stops a running backfill after the conversation in progress.
     * @returns {void}
     */
    cancelBackfill() {
      if (this.#backfill.isRunning) this.#updateBackfill({ isRunning: false });
    }

    /**
     * Lists every conversation page by page; stops early when the backfill is cancelled.
     * @returns {Promise<ConversationListing[]>} The conversations.
     * @throws {ApiError} When a page can't be fetched.
     */
    async #listAllConversations() {
      const listings = [];
      for (let page = null; this.#shouldRequestNextPage(page); ) {
        page = await this.#api.listConversations(listings.length, LIMITS.backfillPageSize);
        listings.push(...page);
      }
      return listings;
    }

    /**
     * Whether another listing page should be requested.
     * @param {?ConversationListing[]} previousPage Previous page, or null before the first.
     * @returns {boolean} True before the first page, and while pages are full and the backfill runs.
     */
    #shouldRequestNextPage(previousPage) {
      return previousPage === null || (previousPage.length === LIMITS.backfillPageSize && this.#backfill.isRunning);
    }

    /**
     * Indexes listed conversations one at a time, reporting progress.
     * @param {ConversationListing[]} listings The conversations.
     * @returns {Promise<void>} Resolves when done or cancelled.
     * @throws {ApiError|DOMException} When fetching or storing fails.
     */
    async #indexListings(listings) {
      this.#updateBackfill({ totalCount: listings.length });
      for (const listing of listings) {
        if (!this.#backfill.isRunning) return;
        await this.#indexListing(listing);
        this.#updateBackfill({ processedCount: this.#backfill.processedCount + 1 });
      }
    }

    /**
     * Fetches and stores one conversation if its cached summary is outdated, refreshing the
     * aggregate every LIMITS.backfillRefreshInterval stored conversations.
     * @param {ConversationListing} listing The conversation.
     * @returns {Promise<void>} Resolves once done.
     * @throws {ApiError|DOMException} When fetching or storing fails.
     */
    async #indexListing(listing) {
      if (!(await this.#isOutdated(listing.uuid, listing.updated_at))) return;
      await this.#storeSummaryIfOutdated(await this.#api.getConversation(listing.uuid));
      this.#storedDuringBackfill += 1;
      if (this.#storedDuringBackfill % LIMITS.backfillRefreshInterval === 0) await this.refreshAggregate();
      await wait(TIMING.backfillPauseMs);
    }

    /**
     * Whether the cache lacks a conversation or holds another version of it.
     * @param {string} conversationId Conversation id.
     * @param {string} updatedAt Current version timestamp of the conversation.
     * @returns {Promise<boolean>} True when it must be (re)indexed.
     * @throws {DOMException} When the cache can't be read.
     */
    async #isOutdated(conversationId, updatedAt) {
      const summary = await this.#database.read(DATABASE.stores.conversationSummaries, conversationId);
      return !summary || summary.updatedAt !== updatedAt;
    }

    /**
     * Stores a conversation's summary if the cached one is outdated.
     * @param {ApiConversation} conversation The conversation.
     * @returns {Promise<boolean>} True if a summary was written.
     * @throws {DOMException} When the cache can't be read or written.
     */
    async #storeSummaryIfOutdated(conversation) {
      if (!(await this.#isOutdated(conversation.uuid, conversation.updated_at))) return false;
      await this.#database.write(DATABASE.stores.conversationSummaries, ConversationSummarizer.summarize(conversation));
      return true;
    }

    /**
     * Updates backfill progress and notifies listeners.
     * @param {Partial<BackfillProgress>} changes Fields to change.
     * @returns {void}
     */
    #updateBackfill(changes) {
      Object.assign(this.#backfill, changes);
      this.publish('backfill');
    }
  }

  /**
   * Counts time the tab is visible and receiving input, per day. Time is added to the stored day
   * total rather than overwriting it, so several open tabs accumulate.
   * @fires ActivityTracker#activity After every sample.
   */
  class ActivityTracker extends EventEmitter {
    /**
     * Events that count as user input.
     * @type {string[]}
     */
    static #INPUT_EVENTS = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'];

    /**
     * Activity storage.
     * @type {IndexedDbStore}
     */
    #database;

    /**
     * Day being counted, as YYYY-MM-DD in UTC.
     * @type {string}
     */
    #countedDay = ActivityTracker.#today();

    /**
     * Epoch milliseconds of the last input.
     * @type {number}
     */
    #lastInputTime = Date.now();

    /**
     * Active milliseconds not yet written to storage.
     * @type {number}
     */
    #unsavedMs = 0;

    /**
     * Creates the tracker.
     * @param {IndexedDbStore} database Activity storage.
     */
    constructor(database) {
      super();
      this.#database = database;
      this.activeTodayMs = 0;
      this.activeAllTimeMs = 0;
      this.isIdle = false;
    }

    /**
     * The current day key.
     * @returns {string} Today as YYYY-MM-DD in UTC.
     */
    static #today() {
      return new Date().toISOString().slice(0, 10);
    }

    /**
     * Loads stored totals and starts sampling and periodic saving. Also saves when the tab is hidden
     * or closed.
     * @returns {Promise<void>} Resolves once started.
     */
    async start() {
      await this.#loadTotals();
      for (const eventType of ActivityTracker.#INPUT_EVENTS) document.addEventListener(eventType, this.#recordInput, { passive: true });
      document.addEventListener('visibilitychange', this.#saveWhenHidden);
      window.addEventListener('pagehide', () => this.#saveUnsavedTime());
      setInterval(() => this.#sampleActivity(), TIMING.activitySampleMs);
      setInterval(() => this.#saveUnsavedTime(), TIMING.activitySaveMs);
      this.publish('activity');
    }

    /**
     * Records the time of user input.
     * @returns {void}
     */
    #recordInput = () => {
      this.#lastInputTime = Date.now();
    };

    /**
     * Saves unsaved time when the tab becomes hidden.
     * @returns {void}
     */
    #saveWhenHidden = () => {
      if (document.visibilityState === 'hidden') this.#saveUnsavedTime();
    };

    /**
     * Reads today's and the all-time totals. Failures are logged and leave both at zero.
     * @returns {Promise<void>} Resolves once loaded or failed.
     */
    async #loadTotals() {
      try {
        const records = await this.#database.readAll(DATABASE.stores.activity);
        const todayRecord = records.find(record => record.day === this.#countedDay);
        this.activeTodayMs = todayRecord ? todayRecord.activeMs : 0;
        this.activeAllTimeMs = records.reduce((sum, record) => sum + (record.activeMs || 0), 0);
      } catch (error) {
        console.warn(LOG_PREFIX, 'reading activity failed', error);
      }
    }

    /**
     * Takes one sample: rolls over at midnight, then counts the interval if the user is active.
     * @returns {void}
     */
    #sampleActivity() {
      if (ActivityTracker.#today() !== this.#countedDay) this.#startNewDay();
      this.isIdle = !this.#isUserActive();
      if (!this.isIdle) this.#addActiveTime(TIMING.activitySampleMs);
      this.publish('activity');
    }

    /**
     * Saves the finished day and starts counting a new one.
     * @returns {void}
     */
    #startNewDay() {
      this.#saveUnsavedTime();
      this.#countedDay = ActivityTracker.#today();
      this.activeTodayMs = 0;
    }

    /**
     * Whether the tab is visible and had input within the idle timeout.
     * @returns {boolean} True when the user counts as active.
     */
    #isUserActive() {
      return document.visibilityState === 'visible' && Date.now() - this.#lastInputTime <= TIMING.idleAfterMs;
    }

    /**
     * Adds active time to the totals and to the unsaved amount.
     * @param {number} durationMs Time to add.
     * @returns {void}
     */
    #addActiveTime(durationMs) {
      this.activeTodayMs += durationMs;
      this.activeAllTimeMs += durationMs;
      this.#unsavedMs += durationMs;
    }

    /**
     * Adds unsaved time to the stored day total. On failure the time is kept for the next attempt
     * unless the day has changed.
     * @returns {Promise<void>} Resolves once saved or failed.
     */
    async #saveUnsavedTime() {
      if (this.#unsavedMs === 0) return;
      const day = this.#countedDay;
      const durationMs = this.#unsavedMs;
      this.#unsavedMs = 0;
      try {
        await this.#database.update(DATABASE.stores.activity, day, record => ({ day, activeMs: (record ? record.activeMs : 0) + durationMs }));
      } catch (error) {
        this.#keepUnsavedTime(day, durationMs);
        console.warn(LOG_PREFIX, 'saving activity failed', error);
      }
    }

    /**
     * Puts back time that failed to save, if it belongs to the day still being counted.
     * @param {string} day Day the time belongs to.
     * @param {number} durationMs Time that failed to save.
     * @returns {void}
     */
    #keepUnsavedTime(day, durationMs) {
      if (day === this.#countedDay) this.#unsavedMs += durationMs;
    }
  }

  /**
   * Latest known usage windows, from polling and from message_limit stream events.
   * @fires RateLimitMonitor#rateLimits The limits changed.
   */
  class RateLimitMonitor extends EventEmitter {
    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Creates the monitor.
     * @param {ClaudeApi} api API client.
     */
    constructor(api) {
      super();
      this.#api = api;
      this.limits = null;
    }

    /**
     * Polls now and then every TIMING.rateLimitPollMs.
     * @returns {void}
     */
    start() {
      this.#fetchLimits();
      setInterval(() => this.#fetchLimits(), TIMING.rateLimitPollMs);
    }

    /**
     * Replaces the known limits.
     * @param {RateLimits} limits New limits.
     * @returns {void}
     */
    setLimits(limits) {
      this.limits = limits;
      this.publish('rateLimits');
    }

    /**
     * Fetches the limits; on failure the last known values stay and the next poll retries.
     * @returns {Promise<void>} Resolves once fetched or failed.
     */
    async #fetchLimits() {
      try {
        this.setLimits(await this.#api.getUsage());
      } catch {
        return;
      }
    }
  }

  /**
   * A dockable panel. Its DOM is built on first access and immediately rendered from current state,
   * so a panel opened late is never blank. Subclasses override createBodyHtml, bindEvents and
   * render, look up elements only inside their own root through elements, and subscribe through
   * listenTo so dispose can undo every subscription.
   */
  class Panel {
    /**
     * Root element, or null until first access.
     * @type {?HTMLElement}
     */
    #root = null;

    /**
     * Tab title.
     * @type {string}
     */
    #title;

    /**
     * Undoes each subscription made through listenTo.
     * @type {Array<function(): void>}
     */
    #unsubscribers = [];

    /**
     * Creates the panel.
     * @param {string} title Tab title.
     */
    constructor(title) {
      this.#title = title;
      this.elements = {};
    }

    /**
     * Tab title.
     * @returns {string} The title.
     */
    get title() {
      return this.#title;
    }

    /**
     * Whether the DOM has been built.
     * @returns {boolean} True after the first access of element.
     */
    get isBuilt() {
      return this.#root !== null;
    }

    /**
     * Root element, built, wired and rendered on first access.
     * @returns {HTMLElement} The root.
     */
    get element() {
      if (!this.#root) this.#buildElement();
      return this.#root;
    }

    /**
     * Whether the panel's tab offers a close button.
     * @returns {boolean} False; closable panels override this.
     */
    canClose() {
      return false;
    }

    /**
     * Handles the tab's close button.
     * @returns {void}
     */
    close() {
      return undefined;
    }

    /**
     * Subscribes to an emitter for as long as the panel exists.
     * @param {EventEmitter} emitter Event source.
     * @param {string} eventName Event name.
     * @param {function(*): void} listener Called with the event payload.
     * @returns {void}
     */
    listenTo(emitter, eventName, listener) {
      this.#unsubscribers.push(emitter.subscribe(eventName, listener));
    }

    /**
     * Ends every subscription and removes the panel from the page.
     * @returns {void}
     */
    dispose() {
      this.#unsubscribers.forEach(unsubscribe => unsubscribe());
      this.#unsubscribers = [];
      if (this.#root) this.#root.remove();
    }

    /**
     * HTML of the panel body; elements used later carry a data-name attribute.
     * @returns {string} The HTML.
     */
    createBodyHtml() {
      return '';
    }

    /**
     * Attaches event listeners and subscriptions once the DOM exists.
     * @returns {void}
     */
    bindEvents() {
      return undefined;
    }

    /**
     * Updates the DOM from current state.
     * @returns {void}
     */
    render() {
      return undefined;
    }

    /**
     * Builds the root from the body HTML, collects named elements, wires and renders it.
     * @returns {void}
     */
    #buildElement() {
      this.#root = createElement('div', { className: 'claude-plus-themed claude-plus-panel', innerHTML: this.createBodyHtml() });
      this.elements = collectNamedElements(this.#root);
      this.bindEvents();
      this.render();
    }
  }

  /**
   * Conversation list with search, new chat, open in a new pane, and delete. Clicking a conversation
   * opens it in the focused chat pane.
   */
  class ConversationListPanel extends Panel {
    /**
     * Column ids that can be shown for each entry, in display order.
     * @type {ReadonlyArray<string>}
     */
    static #COLUMNS = Object.freeze(['date', 'turns', 'files']);

    /**
     * Label of each column, for its toggle checkbox.
     * @type {Readonly<Record<string, string>>}
     */
    static #COLUMN_LABELS = Object.freeze({ date: 'Date', turns: 'Turns', files: 'Files' });

    /**
     * Label of each sort key, for the sort dropdown, in menu order.
     * @type {ReadonlyArray<{key: string, label: string}>}
     */
    static #SORT_OPTIONS = Object.freeze([
      { key: 'date', label: 'Date' },
      { key: 'name', label: 'Name' },
      { key: 'turns', label: 'Turns' },
      { key: 'files', label: 'Files' },
    ]);

    /**
     * Shared conversation list.
     * @type {ConversationDirectory}
     */
    #directory;

    /**
     * Navigation.
     * @type {Router}
     */
    #router;

    /**
     * Chat panes.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Conversation statistics, for the optional turn- and file-count columns and for sorting by them.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Column and sort preference storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Lower-case search text.
     * @type {string}
     */
    #searchText = '';

    /**
     * Ids of the columns currently shown, besides the title.
     * @type {Set<string>}
     */
    #visibleColumns;

    /**
     * Current sort.
     * @type {{key: string, direction: number}}
     */
    #sort;

    /**
     * Handler per button data-action value inside a conversation entry.
     * @type {Map<string, function(HTMLElement): void>}
     */
    #entryActionHandlers = new Map([
      ['delete', entry => this.#confirmAndDelete(entry)],
      ['openInNewPane', entry => this.#paneManager.openPane(entry.dataset.conversationId)],
    ]);

    /**
     * Creates the panel.
     * @param {object} services Panel dependencies.
     * @param {ConversationDirectory} services.directory Shared conversation list.
     * @param {Router} services.router Navigation.
     * @param {ChatPaneManager} services.paneManager Chat panes.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {Preferences} services.preferences Column and sort preference storage.
     */
    constructor({ directory, router, paneManager, stats, preferences }) {
      super('Chats');
      this.#directory = directory;
      this.#router = router;
      this.#paneManager = paneManager;
      this.#stats = stats;
      this.#preferences = preferences;
      this.#visibleColumns = ConversationListPanel.#loadVisibleColumns(preferences);
      this.#sort = ConversationListPanel.#loadSort(preferences);
    }

    /**
     * HTML of the panel body: new chat button, search box, a sort and column toolbar, and the list.
     * @returns {string} The body.
     */
    createBodyHtml() {
      return `
        <button class="claude-plus-primary-button" data-name="newChatButton">+ New chat</button>
        <input class="claude-plus-search-input" data-name="searchInput" type="text" placeholder="Search chats…" />
        <div class="claude-plus-conversation-list-toolbar">
          <select data-name="sortKeySelect">${ConversationListPanel.#sortOptionsHtml()}</select>
          <button class="claude-plus-toolbar__button" data-name="sortDirectionButton" title="Toggle sort direction"></button>
        </div>
        <div class="claude-plus-column-toggles" data-name="columnToggles">${ConversationListPanel.#columnToggleHtml()}</div>
        <div class="claude-plus-scrollable claude-plus-fill-remaining" data-name="conversationList"></div>`;
    }

    /**
     * Wires the buttons, search, sort, column toggles and list; follows list, focus, pane and stats
     * changes; and applies the loaded sort and column preferences to the new controls.
     * @returns {void}
     */
    bindEvents() {
      this.elements.newChatButton.addEventListener('click', () => this.#router.startNewConversation());
      this.elements.searchInput.addEventListener('input', () => this.#applySearch(this.elements.searchInput.value));
      this.elements.sortKeySelect.addEventListener('change', () => this.#setSortKey(this.elements.sortKeySelect.value));
      this.elements.sortDirectionButton.addEventListener('click', () => this.#toggleSortDirection());
      this.elements.columnToggles.addEventListener('change', event => this.#onColumnToggle(event));
      this.elements.conversationList.addEventListener('mousedown', event => this.#onConversationListPress(event));
      this.elements.conversationList.addEventListener('click', event => this.#onConversationListClick(event));
      this.listenTo(this.#directory, 'conversations', () => this.render());
      this.listenTo(this.#paneManager, 'focus', () => this.render());
      this.listenTo(this.#paneManager, 'paneConversations', () => this.render());
      this.listenTo(this.#stats, 'aggregate', () => this.render());
      this.#applyPreferencesToControls();
    }

    /**
     * Shows the conversations matching the search, sorted by the current sort, marking the focused
     * pane's conversation and those open in other panes.
     * @returns {void}
     */
    render() {
      const openIds = this.#paneManager.openConversationIds();
      const focusedId = this.#paneManager.focusedSession.openConversationId;
      const matching = this.#directory.conversations.filter(conversation => this.#matchesSearch(conversation));
      const sorted = this.#sortedConversations(matching);
      const emptyText = this.#searchText ? 'No chats match your search.' : 'No conversations yet.';
      this.elements.conversationList.innerHTML = sorted.map(conversation => this.#conversationHtml(conversation, focusedId, openIds)).join('') || emptyStateHtml(emptyText);
    }

    /**
     * Moves keyboard focus to the search box and selects its text.
     * @returns {void}
     */
    focusSearch() {
      this.elements.searchInput.focus();
      this.elements.searchInput.select();
    }

    /**
     * Filters the list by title.
     * @param {string} text Search text.
     * @returns {void}
     */
    #applySearch(text) {
      this.#searchText = text.toLowerCase();
      this.render();
    }

    /**
     * Whether a conversation's title contains the search text.
     * @param {ConversationListing} conversation The conversation.
     * @returns {boolean} True when it matches or there is no search.
     */
    #matchesSearch(conversation) {
      return (conversation.name || '').toLowerCase().includes(this.#searchText);
    }

    /**
     * Sets the checkboxes and select to match the loaded preferences, since the HTML they were built
     * from is static.
     * @returns {void}
     */
    #applyPreferencesToControls() {
      this.elements.sortKeySelect.value = this.#sort.key;
      this.#renderSortDirectionButton();
      for (const checkbox of this.elements.columnToggles.querySelectorAll('[data-column]')) {
        checkbox.checked = this.#visibleColumns.has(checkbox.dataset.column);
      }
    }

    /**
     * Sets the sort key, keeping the current direction, and re-renders.
     * @param {string} key One of ConversationListPanel.#SORT_OPTIONS' keys.
     * @returns {void}
     */
    #setSortKey(key) {
      this.#sort = { ...this.#sort, key };
      this.#saveSort();
      this.render();
    }

    /**
     * Flips the sort direction and re-renders.
     * @returns {void}
     */
    #toggleSortDirection() {
      this.#sort = { ...this.#sort, direction: -this.#sort.direction };
      this.#saveSort();
      this.#renderSortDirectionButton();
      this.render();
    }

    /**
     * Shows an arrow matching the current sort direction.
     * @returns {void}
     */
    #renderSortDirectionButton() {
      this.elements.sortDirectionButton.textContent = this.#sort.direction === 1 ? '↑' : '↓';
    }

    /**
     * Persists the current sort.
     * @returns {void}
     */
    #saveSort() {
      this.#preferences.writeJson(STORAGE_KEYS.conversationListSort, this.#sort);
    }

    /**
     * Toggles a column on or off, persists it and re-renders.
     * @param {Event} event Change event from a column checkbox.
     * @returns {void}
     */
    #onColumnToggle(event) {
      const checkbox = event.target.closest('[data-column]');
      if (!checkbox) return;
      const column = checkbox.dataset.column;
      if (checkbox.checked) this.#visibleColumns.add(column);
      else this.#visibleColumns.delete(column);
      this.#preferences.writeJson(STORAGE_KEYS.conversationListColumns, [...this.#visibleColumns]);
      this.render();
    }

    /**
     * Sorts conversations by the current sort key and direction. Turns and files fall back to -1 for
     * conversations not yet indexed (opened, or pulled in by a stats backfill), sorting them to one
     * end rather than scattering them by search-list order.
     * @param {ConversationListing[]} conversations Conversations to sort.
     * @returns {ConversationListing[]} A new, sorted array.
     */
    #sortedConversations(conversations) {
      return [...conversations].sort((first, second) => {
        const firstValue = this.#sortValue(first);
        const secondValue = this.#sortValue(second);
        if (firstValue < secondValue) return -this.#sort.direction;
        if (firstValue > secondValue) return this.#sort.direction;
        return 0;
      });
    }

    /**
     * A conversation's value for the current sort key.
     * @param {ConversationListing} conversation The conversation.
     * @returns {number|string} The value to compare.
     */
    #sortValue(conversation) {
      if (this.#sort.key === 'name') return (conversation.name || '').toLowerCase();
      if (this.#sort.key === 'date') return toEpochMs(conversation.updated_at);
      const summary = this.#stats.aggregate.perConversation.get(conversation.uuid);
      if (!summary) return -1;
      return this.#sort.key === 'turns' ? summary.promptCount : summary.fileCount;
    }

    /**
     * HTML of one conversation entry: title, a badge per visible column, then the action buttons.
     * @param {ConversationListing} conversation The conversation.
     * @param {?string} focusedId Conversation of the focused pane.
     * @param {Set<string>} openIds Conversations open in any pane.
     * @returns {string} The entry.
     */
    #conversationHtml(conversation, focusedId, openIds) {
      const badges = ConversationListPanel.#COLUMNS.filter(column => this.#visibleColumns.has(column))
        .map(column => this.#columnBadgeHtml(column, conversation))
        .join('');
      return `
        <div class="claude-plus-conversation${ConversationListPanel.#stateModifier(conversation.uuid, focusedId, openIds)}" data-conversation-id="${escapeHtml(conversation.uuid)}">
          <div class="claude-plus-conversation__summary">
            <div class="claude-plus-conversation__title">${escapeHtml(conversation.name || UNTITLED)}</div>
            ${badges ? `<div class="claude-plus-conversation__badges">${badges}</div>` : ''}
          </div>
          <button class="claude-plus-conversation__action-button" data-action="openInNewPane" title="Open in new pane">⧉</button>
          <button class="claude-plus-conversation__action-button" data-action="delete" title="Delete chat">🗑</button>
        </div>`;
    }

    /**
     * HTML of one column's badge for a conversation. Turns and files show "–" until the conversation
     * has been indexed.
     * @param {string} column 'date', 'turns' or 'files'.
     * @param {ConversationListing} conversation The conversation.
     * @returns {string} The badge.
     */
    #columnBadgeHtml(column, conversation) {
      if (column === 'date') {
        const date = conversation.updated_at ? new Date(conversation.updated_at).toLocaleDateString() : '–';
        return `<span class="claude-plus-conversation__badge">${escapeHtml(date)}</span>`;
      }
      const summary = this.#stats.aggregate.perConversation.get(conversation.uuid);
      const value = summary ? (column === 'turns' ? summary.promptCount : summary.fileCount) : '–';
      return `<span class="claude-plus-conversation__badge">${escapeHtml(String(value))} ${escapeHtml(ConversationListPanel.#COLUMN_LABELS[column].toLowerCase())}</span>`;
    }

    /**
     * Modifier class marking where a conversation is open.
     * @param {string} conversationId Conversation id.
     * @param {?string} focusedId Conversation of the focused pane.
     * @param {Set<string>} openIds Conversations open in any pane.
     * @returns {string} The active modifier, the open-elsewhere modifier, or an empty string.
     */
    static #stateModifier(conversationId, focusedId, openIds) {
      if (conversationId === focusedId) return ' claude-plus-conversation--active';
      return openIds.has(conversationId) ? ' claude-plus-conversation--open-elsewhere' : '';
    }

    /**
     * Starts dragging a conversation out of the list on a primary-button press away from its action
     * buttons; releasing over a valid dock target opens it as a new pane docked there, so several
     * conversations can be compared side by side without switching between them or mixing their
     * context. A plain click (no real drag) still falls through to #onConversationListClick, which
     * opens it in the focused pane as before.
     * @param {MouseEvent} event Mousedown inside the list.
     * @returns {void}
     */
    #onConversationListPress(event) {
      if (event.button !== 0) return;
      const entry = event.target.closest('.claude-plus-conversation');
      if (!entry || event.target.closest('[data-action]')) return;
      const conversationId = entry.dataset.conversationId;
      this.#paneManager.beginDragToOpenPane(event, conversationId, this.#directory.titleOf(conversationId));
    }

    /**
     * Runs the clicked entry button's action, or opens the clicked conversation in the focused pane.
     * @param {MouseEvent} event Click inside the list.
     * @returns {void}
     */
    #onConversationListClick(event) {
      const entry = event.target.closest('.claude-plus-conversation');
      if (!entry) return;
      const button = event.target.closest('[data-action]');
      if (button) this.#entryActionHandlers.get(button.dataset.action)(entry);
      else this.#router.openConversation(entry.dataset.conversationId);
    }

    /**
     * Asks for confirmation, then deletes a conversation. The entry is dimmed while deleting and
     * restored if deleting fails.
     * @param {HTMLElement} entry The conversation's entry.
     * @returns {Promise<void>} Resolves once deleted, declined or failed.
     */
    async #confirmAndDelete(entry) {
      const conversationId = entry.dataset.conversationId;
      const confirmed = await confirmDialog(`Delete "${this.#directory.titleOf(conversationId)}"? This cannot be undone.`, 'Delete');
      if (!confirmed) return;
      entry.classList.add('claude-plus-pending');
      try {
        await this.#directory.deleteConversation(conversationId);
      } catch (error) {
        console.warn(LOG_PREFIX, 'delete failed', error);
        entry.classList.remove('claude-plus-pending');
      }
    }

    /**
     * HTML of the sort key dropdown's options.
     * @returns {string} The options.
     */
    static #sortOptionsHtml() {
      return ConversationListPanel.#SORT_OPTIONS.map(({ key, label }) => `<option value="${key}">${escapeHtml(label)}</option>`).join('');
    }

    /**
     * HTML of the column toggle checkboxes. Their checked state is applied after insertion, by
     * #applyPreferencesToControls, since it depends on instance state.
     * @returns {string} The checkboxes.
     */
    static #columnToggleHtml() {
      return ConversationListPanel.#COLUMNS.map(column => `<label class="claude-plus-column-toggle"><input type="checkbox" data-column="${column}" /> ${escapeHtml(ConversationListPanel.#COLUMN_LABELS[column])}</label>`).join('');
    }

    /**
     * Loads which columns are visible, defaulting to none (matching the previous, column-free list).
     * @param {Preferences} preferences Preference storage.
     * @returns {Set<string>} The visible column ids.
     */
    static #loadVisibleColumns(preferences) {
      const stored = preferences.readJson(STORAGE_KEYS.conversationListColumns);
      const valid = Array.isArray(stored) ? stored.filter(column => ConversationListPanel.#COLUMNS.includes(column)) : [];
      return new Set(valid);
    }

    /**
     * Loads the sort, defaulting to newest first (matching the previous, server-ordered list).
     * @param {Preferences} preferences Preference storage.
     * @returns {{key: string, direction: number}} The sort.
     */
    static #loadSort(preferences) {
      const stored = preferences.readJson(STORAGE_KEYS.conversationListSort);
      const validKey = Boolean(stored) && ConversationListPanel.#SORT_OPTIONS.some(option => option.key === stored.key);
      return { key: validKey ? stored.key : 'date', direction: stored && stored.direction === 1 ? 1 : -1 };
    }
  }

  /**
   * The messages of a chat session with copy and retry actions. Streaming updates re-render only
   * the affected message, at most once per animation frame.
   */
  class MessageListView {
    /**
     * List element the messages are rendered into.
     * @type {HTMLElement}
     */
    #listElement;

    /**
     * Session whose messages are shown.
     * @type {ChatSession}
     */
    #session;

    /**
     * Messages whose content changed since the last frame.
     * @type {Set<ChatMessage>}
     */
    #changedMessages = new Set();

    /**
     * Batches message updates per frame.
     * @type {FrameScheduler}
     */
    #updateScheduler = new FrameScheduler(() => this.#renderChangedMessages());

    /**
     * Handler per data-action value.
     * @type {Map<string, function(HTMLElement): void>}
     */
    #actionHandlers = new Map([
      ['retry', () => this.#session.retryLastPrompt()],
      ['copy', button => this.#copyMessageText(button)],
    ]);

    /**
     * Wires the view to its list element and session.
     * @param {Panel} ownerPanel Panel owning the subscriptions.
     * @param {HTMLElement} listElement List element the messages are rendered into.
     * @param {ChatSession} session Session whose messages are shown.
     */
    constructor(ownerPanel, listElement, session) {
      this.#listElement = listElement;
      this.#session = session;
      listElement.addEventListener('click', event => this.#onClick(event));
      ownerPanel.listenTo(session, 'messages', () => this.render());
      ownerPanel.listenTo(session, 'sending', () => this.render());
      ownerPanel.listenTo(session, 'messageContent', message => this.#scheduleMessageUpdate(message));
    }

    /**
     * Re-renders every message, keeping the view at the bottom if it was there.
     * @returns {void}
     */
    render() {
      this.#changedMessages.clear();
      this.#updateScheduler.cancel();
      const wasAtBottom = this.#isScrolledToBottom();
      const messages = this.#session.messages;
      const retryableIndex = this.#session.isSending ? -1 : messages.findLastIndex(message => message.sender === 'assistant');
      this.#listElement.innerHTML = messages.map((message, index) => MessageListView.#messageHtml(message, index, index === retryableIndex)).join('')
        || '<div class="claude-plus-empty-state claude-plus-empty-state--padded">Start a conversation using the message box below.</div>';
      this.#scrollToBottomIf(wasAtBottom);
    }

    /**
     * Queues a message for re-rendering on the next frame.
     * @param {ChatMessage} message The changed message.
     * @returns {void}
     */
    #scheduleMessageUpdate(message) {
      this.#changedMessages.add(message);
      this.#updateScheduler.schedule();
    }

    /**
     * Re-renders the queued messages.
     * @returns {void}
     */
    #renderChangedMessages() {
      const wasAtBottom = this.#isScrolledToBottom();
      this.#changedMessages.forEach(message => this.#renderMessageBody(message));
      this.#changedMessages.clear();
      this.#scrollToBottomIf(wasAtBottom);
    }

    /**
     * Re-renders one message's body, if it is still shown.
     * @param {ChatMessage} message The message.
     * @returns {void}
     */
    #renderMessageBody(message) {
      const index = this.#session.messages.indexOf(message);
      const body = this.#listElement.querySelector(`[data-message-index="${index}"] .claude-plus-message__body`);
      if (body) body.innerHTML = MessageListView.#messageBodyHtml(message);
    }

    /**
     * HTML of one message.
     * @param {ChatMessage} message The message.
     * @param {number} index Position in the list.
     * @param {boolean} offersRetry Whether to offer retry on it.
     * @returns {string} The message.
     */
    static #messageHtml(message, index, offersRetry) {
      const sender = message.sender === 'human' ? 'human' : 'assistant';
      return `
        <div class="claude-plus-message claude-plus-message--${sender}" data-message-index="${index}">
          <div class="claude-plus-message__sender">${sender === 'human' ? 'You' : 'Claude'}</div>
          <div class="claude-plus-message__body">${MessageListView.#messageBodyHtml(message)}</div>
          ${message.isStreaming ? '' : MessageListView.#actionButtonsHtml(offersRetry)}
        </div>`;
    }

    /**
     * HTML of a message's action buttons.
     * @param {boolean} offersRetry Whether to include retry.
     * @returns {string} The buttons.
     */
    static #actionButtonsHtml(offersRetry) {
      const retryButton = offersRetry ? '<button class="claude-plus-message__action-button" data-action="retry" title="Retry">🔁 Retry</button>' : '';
      return `<div class="claude-plus-message__actions"><button class="claude-plus-message__action-button" data-action="copy" title="Copy">📋</button>${retryButton}</div>`;
    }

    /**
     * HTML of a message's body: content, error and streaming cursor.
     * @param {ChatMessage} message The message.
     * @returns {string} The body.
     */
    static #messageBodyHtml(message) {
      const errorHtml = message.errorText ? `<div class="claude-plus-message-error">Error: ${escapeHtml(message.errorText)}</div>` : '';
      const cursorHtml = message.isStreaming ? '<span class="claude-plus-streaming-cursor">▍</span>' : '';
      return `${message.html}${errorHtml}${cursorHtml}`;
    }

    /**
     * Runs the action of a clicked button.
     * @param {MouseEvent} event Click inside the list.
     * @returns {void}
     */
    #onClick(event) {
      const button = event.target.closest('[data-action]');
      const handleAction = button ? this.#actionHandlers.get(button.dataset.action) : null;
      if (handleAction) handleAction(button);
    }

    /**
     * Copies a message's text to the clipboard and briefly shows a check mark.
     * @param {HTMLElement} button The copy button.
     * @returns {void}
     */
    #copyMessageText(button) {
      const message = this.#session.messages[Number(button.closest('.claude-plus-message').dataset.messageIndex)];
      navigator.clipboard.writeText(MessageListView.#copyableText(message)).catch(() => undefined);
      button.textContent = '✓';
      setTimeout(() => { button.textContent = '📋'; }, TIMING.copyFeedbackMs);
    }

    /**
     * Text copied for a message.
     * @param {?ChatMessage} message The message.
     * @returns {string} Its text, else its error, else an empty string.
     */
    static #copyableText(message) {
      return message ? message.text || message.errorText || '' : '';
    }

    /**
     * Whether the list is scrolled to (or near) the bottom.
     * @returns {boolean} True within LIMITS.followOutputDistance of the bottom.
     */
    #isScrolledToBottom() {
      const list = this.#listElement;
      return list.scrollHeight - list.scrollTop - list.clientHeight < LIMITS.followOutputDistance;
    }

    /**
     * Scrolls to the bottom if the list was there before an update.
     * @param {boolean} wasAtBottom Whether the list was at the bottom.
     * @returns {void}
     */
    #scrollToBottomIf(wasAtBottom) {
      if (wasAtBottom) this.#listElement.scrollTop = this.#listElement.scrollHeight;
    }
  }

  /**
   * Prompt input of a chat session with model, effort and thinking options, and a send/stop button.
   * The options are shared by all panes and stay in sync between them.
   */
  class ComposerView {
    /**
     * Session prompts are sent in.
     * @type {ChatSession}
     */
    #session;

    /**
     * Shared model options.
     * @type {ComposerSettings}
     */
    #settings;

    /**
     * Named elements of the composer.
     * @type {Object<string, HTMLElement>}
     */
    #elements;

    /**
     * Builds the composer into its container and wires it.
     * @param {Panel} ownerPanel Panel owning the subscriptions.
     * @param {HTMLElement} container Element the composer is built into.
     * @param {ChatSession} session Session prompts are sent in.
     * @param {ComposerSettings} settings Shared model options.
     */
    constructor(ownerPanel, container, session, settings) {
      this.#session = session;
      this.#settings = settings;
      container.innerHTML = ComposerView.#bodyHtml();
      this.#elements = collectNamedElements(container);
      this.#bindControls();
      ownerPanel.listenTo(session, 'sending', () => this.render());
      ownerPanel.listenTo(settings, 'settings', () => this.#showSettings());
      this.#showSettings();
    }

    /**
     * Shows Stop while sending and Send otherwise.
     * @returns {void}
     */
    render() {
      const { sendButton } = this.#elements;
      sendButton.textContent = this.#session.isSending ? 'Stop' : 'Send';
      sendButton.classList.toggle('claude-plus-composer__send-button--stop', this.#session.isSending);
    }

    /**
     * HTML of the composer.
     * @returns {string} Option controls, text area and button.
     */
    static #bodyHtml() {
      return `
        <div class="claude-plus-composer__options">
          <select data-name="modelSelect">${optionsHtml(MODELS, '')}</select>
          <select data-name="effortSelect">${optionsHtml(EFFORTS, '')}</select>
          <label class="claude-plus-composer__thinking-toggle"><input type="checkbox" data-name="thinkingCheckbox" /> Extended thinking</label>
        </div>
        <textarea class="claude-plus-composer__input" data-name="promptInput" placeholder="Message Claude…" rows="3"></textarea>
        <button class="claude-plus-primary-button claude-plus-composer__send-button" data-name="sendButton">Send</button>`;
    }

    /**
     * Wires the options, the button and Enter-to-send.
     * @returns {void}
     */
    #bindControls() {
      const { modelSelect, effortSelect, thinkingCheckbox, promptInput, sendButton } = this.#elements;
      modelSelect.addEventListener('change', () => { this.#settings.model = modelSelect.value; });
      effortSelect.addEventListener('change', () => { this.#settings.effort = effortSelect.value; });
      thinkingCheckbox.addEventListener('change', () => { this.#settings.thinkingMode = thinkingCheckbox.checked ? THINKING_MODES.extended : THINKING_MODES.off; });
      sendButton.addEventListener('click', () => this.#onSendButtonClick());
      promptInput.addEventListener('keydown', event => this.#onPromptKeydown(event));
    }

    /**
     * Shows the current shared options.
     * @returns {void}
     */
    #showSettings() {
      this.#elements.modelSelect.value = this.#settings.model;
      this.#elements.effortSelect.value = this.#settings.effort;
      this.#elements.thinkingCheckbox.checked = this.#settings.thinkingMode === THINKING_MODES.extended;
    }

    /**
     * Stops the reply while sending, otherwise sends the prompt.
     * @returns {void}
     */
    #onSendButtonClick() {
      if (this.#session.isSending) this.#session.stopReply();
      else this.#sendTypedPrompt();
    }

    /**
     * Sends on Enter; Shift+Enter inserts a line break and IME composition is left alone.
     * @param {KeyboardEvent} event Key press in the text area.
     * @returns {void}
     */
    #onPromptKeydown(event) {
      if (!ComposerView.#isSendShortcut(event)) return;
      event.preventDefault();
      this.#sendTypedPrompt();
    }

    /**
     * Whether a key press sends the prompt.
     * @param {KeyboardEvent} event The key press.
     * @returns {boolean} True for Enter without Shift outside IME composition.
     */
    static #isSendShortcut(event) {
      return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
    }

    /**
     * Sends the typed prompt and clears the input; ignored for blank input or while sending.
     * @returns {void}
     */
    #sendTypedPrompt() {
      const { promptInput } = this.#elements;
      if (!promptInput.value.trim() || this.#session.isSending) return;
      const prompt = promptInput.value;
      promptInput.value = '';
      this.#session.sendPrompt(prompt);
    }
  }

  /**
   * A chat pane: one session's messages above its composer. Its tab shows the conversation title,
   * it becomes the focused pane when clicked or typed in, and it can be closed while other panes exist.
   */
  class ChatPanel extends Panel {
    /**
     * Pane id.
     * @type {string}
     */
    #paneId;

    /**
     * Session shown in this pane.
     * @type {ChatSession}
     */
    #session;

    /**
     * Shared model options.
     * @type {ComposerSettings}
     */
    #settings;

    /**
     * Shared conversation list, for the tab title.
     * @type {ConversationDirectory}
     */
    #directory;

    /**
     * Chat panes, for focus and closing.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * The message list.
     * @type {?MessageListView}
     */
    #messageListView = null;

    /**
     * The composer.
     * @type {?ComposerView}
     */
    #composerView = null;

    /**
     * Creates the pane's panel.
     * @param {object} services Panel dependencies.
     * @param {string} services.paneId Pane id.
     * @param {ChatSession} services.session Session shown in this pane.
     * @param {ComposerSettings} services.settings Shared model options.
     * @param {ConversationDirectory} services.directory Shared conversation list, for the tab title.
     * @param {ChatPaneManager} services.paneManager Chat panes, for focus and closing.
     */
    constructor({ paneId, session, settings, directory, paneManager }) {
      super('Chat');
      this.#paneId = paneId;
      this.#session = session;
      this.#settings = settings;
      this.#directory = directory;
      this.#paneManager = paneManager;
    }

    /**
     * Tab title.
     * @returns {string} Title of the open conversation, or "New chat".
     */
    get title() {
      const conversationId = this.#session.openConversationId;
      return conversationId ? this.#directory.titleOf(conversationId) : 'New chat';
    }

    /**
     * Whether the tab offers a close button.
     * @returns {boolean} True while other panes exist.
     */
    canClose() {
      return this.#paneManager.paneCount > 1;
    }

    /**
     * Closes this pane.
     * @returns {void}
     */
    close() {
      this.#paneManager.closePane(this.#paneId);
    }

    /**
     * HTML of the panel body.
     * @returns {string} Containers for the message list and the composer.
     */
    createBodyHtml() {
      return `
        <div class="claude-plus-scrollable claude-plus-fill-remaining claude-plus-message-list" data-name="messageList"></div>
        <div class="claude-plus-composer" data-name="composer"></div>`;
    }

    /**
     * Creates the views, focuses the pane on interaction and follows focus changes.
     * @returns {void}
     */
    bindEvents() {
      this.#messageListView = new MessageListView(this, this.elements.messageList, this.#session);
      this.#composerView = new ComposerView(this, this.elements.composer, this.#session, this.#settings);
      this.element.addEventListener('mousedown', () => this.#paneManager.focusPane(this.#paneId));
      this.element.addEventListener('focusin', () => this.#paneManager.focusPane(this.#paneId));
      this.listenTo(this.#paneManager, 'focus', () => this.#renderFocus());
    }

    /**
     * Renders the focus marker, the messages and the composer.
     * @returns {void}
     */
    render() {
      this.#renderFocus();
      this.#messageListView.render();
      this.#composerView.render();
    }

    /**
     * Marks the pane while it is the focused one.
     * @returns {void}
     */
    #renderFocus() {
      this.element.classList.toggle('claude-plus-panel--focused', this.#paneManager.focusedPaneId === this.#paneId);
    }
  }

  /**
   * Activity, usage, token estimates, tool calls and the history backfill.
   */
  class StatsPanel extends Panel {
    /**
     * Conversation statistics.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Active-time tracking.
     * @type {ActivityTracker}
     */
    #activity;

    /**
     * Usage windows.
     * @type {RateLimitMonitor}
     */
    #rateLimits;

    /**
     * Creates the panel.
     * @param {StatsIndex} stats Conversation statistics.
     * @param {ActivityTracker} activity Active-time tracking.
     * @param {RateLimitMonitor} rateLimits Usage windows.
     */
    constructor(stats, activity, rateLimits) {
      super('Stats');
      this.#stats = stats;
      this.#activity = activity;
      this.#rateLimits = rateLimits;
    }

    /**
     * HTML of the panel body.
     * @returns {string} The stat sections.
     */
    createBodyHtml() {
      const row = StatsPanel.#namedValueRowHtml;
      return `
        <div class="claude-plus-panel__section">${row('Active today', 'activeToday')}${row('Active all-time', 'activeAllTime')}${row('Status', 'activityStatus')}</div>
        <div class="claude-plus-panel__section">${row('Turns (all chats)', 'promptCount')}${row('Avg response time', 'averageResponseTime')}</div>
        <div class="claude-plus-panel__section">${row('Session limit (5h)', 'sessionLimit')}${row('Weekly limit', 'weeklyLimit')}</div>
        <div class="claude-plus-panel__section">${row('Est. tokens in / out', 'estimatedTokens')}
          <div class="claude-plus-hint">Estimated from text length — claude.ai doesn't expose real token counts.</div></div>
        <details class="claude-plus-panel__section" open><summary>Tool calls (<span data-name="toolCallTotal">0</span>)</summary><div class="claude-plus-scrollable" data-name="toolCallRanking"></div></details>
        <div class="claude-plus-panel__section">
          <button class="claude-plus-primary-button claude-plus-full-width" data-name="backfillButton">Index full history</button>
          <div class="claude-plus-hint" data-name="backfillStatus"></div>
          <div class="claude-plus-spaced-above">${row('Conversations indexed', 'indexedConversationCount')}</div>
        </div>`;
    }

    /**
     * Wires the backfill button and follows every data source.
     * @returns {void}
     */
    bindEvents() {
      this.elements.backfillButton.addEventListener('click', () => this.#toggleBackfill());
      this.listenTo(this.#activity, 'activity', () => this.#renderActivity());
      this.listenTo(this.#rateLimits, 'rateLimits', () => this.#renderRateLimits());
      this.listenTo(this.#stats, 'aggregate', () => this.#renderAggregate());
      this.listenTo(this.#stats, 'backfill', () => this.#renderBackfill());
    }

    /**
     * Renders every section.
     * @returns {void}
     */
    render() {
      this.#renderActivity();
      this.#renderRateLimits();
      this.#renderAggregate();
      this.#renderBackfill();
    }

    /**
     * HTML of a labelled value filled in later through its data-name.
     * @param {string} label Row label.
     * @param {string} valueName data-name of the value element.
     * @returns {string} The row.
     */
    static #namedValueRowHtml(label, valueName) {
      return `<div class="claude-plus-value-row"><span>${escapeHtml(label)}</span><b data-name="${valueName}">–</b></div>`;
    }

    /**
     * Starts the backfill, or cancels it while running.
     * @returns {void}
     */
    #toggleBackfill() {
      if (this.#stats.backfill.isRunning) this.#stats.cancelBackfill();
      else this.#stats.runBackfill();
    }

    /**
     * Shows active time and idle state.
     * @returns {void}
     */
    #renderActivity() {
      this.elements.activeToday.textContent = formatDuration(this.#activity.activeTodayMs);
      this.elements.activeAllTime.textContent = formatDuration(this.#activity.activeAllTimeMs);
      this.elements.activityStatus.textContent = this.#activity.isIdle ? 'idle' : 'active';
    }

    /**
     * Shows the usage windows, once known.
     * @returns {void}
     */
    #renderRateLimits() {
      const limits = this.#rateLimits.limits;
      if (!limits) return;
      this.elements.sessionLimit.textContent = formatUtilization(limits.fiveHour);
      this.elements.weeklyLimit.textContent = formatUtilization(limits.sevenDay);
    }

    /**
     * Shows the totals and the tool call ranking.
     * @returns {void}
     */
    #renderAggregate() {
      const aggregate = this.#stats.aggregate;
      const toolRanking = entriesByDescendingCount(aggregate.toolCallCounts);
      const responseTimes = aggregate.responseTimesMs;
      this.elements.promptCount.textContent = aggregate.promptCount;
      this.elements.averageResponseTime.textContent = responseTimes.length ? formatDuration(average(responseTimes)) : '–';
      this.elements.estimatedTokens.textContent = `~${aggregate.estimatedTokensIn.toLocaleString()} in / ~${aggregate.estimatedTokensOut.toLocaleString()} out`;
      this.elements.indexedConversationCount.textContent = aggregate.conversationCount;
      this.elements.toolCallTotal.textContent = toolRanking.reduce((sum, [, count]) => sum + count, 0);
      this.elements.toolCallRanking.innerHTML = toolRanking.map(([toolName, count]) => valueRowHtml(toolName, count)).join('') || emptyStateHtml('No tool calls indexed yet.');
    }

    /**
     * Shows the backfill button label and progress.
     * @returns {void}
     */
    #renderBackfill() {
      const progress = this.#stats.backfill;
      this.elements.backfillButton.textContent = progress.isRunning ? 'Cancel indexing' : 'Index full history';
      this.elements.backfillStatus.textContent = StatsPanel.#backfillStatusText(progress);
    }

    /**
     * Status line under the backfill button.
     * @param {BackfillProgress} progress Backfill state.
     * @returns {string} Progress while running, the last result after a run, or a hint before any.
     */
    static #backfillStatusText({ isRunning, processedCount, totalCount }) {
      if (isRunning) return `Indexing… ${processedCount} / ${totalCount}`;
      if (totalCount) return `Last run: ${processedCount} / ${totalCount} indexed`;
      return 'Not run yet — pulls every past conversation once.';
    }
  }

  /**
   * Web sources cited in tool results, filterable by top-level domain and outlet, plus an outlet ranking.
   */
  class WebSourcesPanel extends Panel {
    /**
     * Conversation statistics.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Creates the panel.
     * @param {StatsIndex} stats Conversation statistics.
     */
    constructor(stats) {
      super('Web Sources');
      this.#stats = stats;
    }

    /**
     * HTML of the panel body.
     * @returns {string} Filters, source list and outlet ranking.
     */
    createBodyHtml() {
      return `
        <div class="claude-plus-source-filters">
          <select data-name="topLevelDomainSelect"><option value="">All TLDs</option></select>
          <input data-name="outletInput" type="text" placeholder="Outlet contains…" />
        </div>
        <div class="claude-plus-scrollable claude-plus-fill-remaining" data-name="sourceList"></div>
        <details class="claude-plus-panel__section"><summary>Top outlets (<span data-name="outletTotal">0</span>)</summary><div class="claude-plus-scrollable" data-name="outletRanking"></div></details>`;
    }

    /**
     * Wires the filters and follows aggregate changes.
     * @returns {void}
     */
    bindEvents() {
      this.elements.topLevelDomainSelect.addEventListener('change', () => this.#renderSourceList());
      this.elements.outletInput.addEventListener('input', () => this.#renderSourceList());
      this.listenTo(this.#stats, 'aggregate', () => this.render());
    }

    /**
     * Renders the filter options, the list and the ranking.
     * @returns {void}
     */
    render() {
      this.#renderTopLevelDomainOptions();
      this.#renderSourceList();
      this.#renderOutletRanking();
    }

    /**
     * Rebuilds the top-level domain options, keeping the selection if it still exists.
     * @returns {void}
     */
    #renderTopLevelDomainOptions() {
      const { topLevelDomainSelect } = this.elements;
      const selected = topLevelDomainSelect.value;
      const domains = [...this.#stats.aggregate.topLevelDomains].sort();
      topLevelDomainSelect.innerHTML = `<option value="">All TLDs</option>${domains.map(domain => `<option value="${escapeHtml(domain)}">.${escapeHtml(domain)}</option>`).join('')}`;
      topLevelDomainSelect.value = domains.includes(selected) ? selected : '';
    }

    /**
     * Lists the newest sources matching the filters, up to LIMITS.listedSources.
     * @returns {void}
     */
    #renderSourceList() {
      const topLevelDomain = this.elements.topLevelDomainSelect.value;
      const outletText = this.elements.outletInput.value.toLowerCase();
      const sources = this.#stats.aggregate.sources
        .filter(source => WebSourcesPanel.#matchesFilters(source, topLevelDomain, outletText))
        .slice(0, LIMITS.listedSources);
      this.elements.sourceList.innerHTML = sources.map(source => WebSourcesPanel.#sourceHtml(source)).join('') || emptyStateHtml('No web sources match these filters.');
    }

    /**
     * Whether a source passes both filters.
     * @param {SourceEntry} source The source.
     * @param {string} topLevelDomain Required top-level domain; empty for any.
     * @param {string} outletText Lower-case text the outlet must contain; empty for any.
     * @returns {boolean} True when it matches.
     */
    static #matchesFilters(source, topLevelDomain, outletText) {
      return (!topLevelDomain || source.topLevelDomain === topLevelDomain) && (source.outlet || '').toLowerCase().includes(outletText);
    }

    /**
     * HTML of one source: linked title and details line.
     * @param {SourceEntry} source The source.
     * @returns {string} The entry.
     */
    static #sourceHtml(source) {
      const details = [source.outlet, source.topLevelDomain ? `.${source.topLevelDomain}` : null, new Date(source.timestamp).toLocaleString(), source.conversationTitle]
        .filter(detail => detail !== null)
        .map(escapeHtml)
        .join(' · ');
      return `<div class="claude-plus-source"><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a><div class="claude-plus-source__details">${details}</div></div>`;
    }

    /**
     * Shows the most cited outlets, up to LIMITS.rankedOutlets.
     * @returns {void}
     */
    #renderOutletRanking() {
      const outletCounts = this.#stats.aggregate.outletCounts;
      this.elements.outletTotal.textContent = Object.keys(outletCounts).length;
      this.elements.outletRanking.innerHTML = entriesByDescendingCount(outletCounts).slice(0, LIMITS.rankedOutlets)
        .map(([outlet, count]) => valueRowHtml(outlet, count)).join('') || emptyStateHtml('No sources yet.');
    }
  }

  /**
   * Uploaded and produced files, one folder per conversation, with a sortable table per folder.
   */
  class FilesPanel extends Panel {
    /**
     * Sort value per column.
     * @type {Readonly<Record<string, function(FileEntry): (string|number)>>}
     */
    static #SORT_VALUE_BY_COLUMN = Object.freeze({
      name: file => (file.title || '').toLowerCase(),
      type: file => file.extension,
      date: file => toEpochMs(file.timestamp),
      source: file => file.source || '',
    });

    /**
     * Conversation statistics.
     * @type {StatsIndex}
     */
    #stats;

    /**
     * Conversation id of the open folder, or null for the folder view.
     * @type {?string}
     */
    #openFolderId = null;

    /**
     * Sort column and direction (1 ascending, -1 descending).
     * @type {{column: string, direction: number}}
     */
    #sortOrder = { column: 'date', direction: -1 };

    /**
     * Creates the panel.
     * @param {StatsIndex} stats Conversation statistics.
     */
    constructor(stats) {
      super('Files');
      this.#stats = stats;
    }

    /**
     * HTML of the panel body.
     * @returns {string} Breadcrumb, folder grid and file table.
     */
    createBodyHtml() {
      return `
        <div class="claude-plus-breadcrumb" data-name="breadcrumb"></div>
        <div class="claude-plus-scrollable claude-plus-fill-remaining claude-plus-folder-grid" data-name="folderGrid"></div>
        <div class="claude-plus-scrollable claude-plus-fill-remaining" data-name="fileTableContainer" hidden>
          <table class="claude-plus-file-table">
            <thead data-name="fileTableHeader"><tr><th data-sort-column="name">Name</th><th data-sort-column="type">Type</th><th data-sort-column="date">Date</th><th data-sort-column="source">Source</th></tr></thead>
            <tbody data-name="fileTableBody"></tbody>
          </table>
        </div>`;
    }

    /**
     * Wires navigation and sorting, and follows aggregate changes.
     * @returns {void}
     */
    bindEvents() {
      this.elements.breadcrumb.addEventListener('click', event => this.#onBreadcrumbClick(event));
      this.elements.folderGrid.addEventListener('dblclick', event => this.#onFolderDoubleClick(event));
      this.elements.fileTableHeader.addEventListener('click', event => this.#onColumnHeaderClick(event));
      this.listenTo(this.#stats, 'aggregate', () => this.render());
    }

    /**
     * Shows the open folder's table, or the folder grid when none is open or it no longer exists.
     * @returns {void}
     */
    render() {
      const openFolder = this.#stats.aggregate.folders.find(folder => folder.conversationId === this.#openFolderId);
      if (openFolder) this.#renderFileTable(openFolder);
      else this.#renderFolderGrid();
    }

    /**
     * Returns to the folder grid when the back link is clicked.
     * @param {MouseEvent} event Click in the breadcrumb.
     * @returns {void}
     */
    #onBreadcrumbClick(event) {
      if (event.target.closest('[data-action="back"]')) this.#openFolder(null);
    }

    /**
     * Opens the double-clicked folder.
     * @param {MouseEvent} event Double click in the folder grid.
     * @returns {void}
     */
    #onFolderDoubleClick(event) {
      const folder = event.target.closest('.claude-plus-folder');
      if (folder) this.#openFolder(folder.dataset.conversationId);
    }

    /**
     * Sorts by the clicked column.
     * @param {MouseEvent} event Click in the table header.
     * @returns {void}
     */
    #onColumnHeaderClick(event) {
      const header = event.target.closest('th[data-sort-column]');
      if (header) this.#sortBy(header.dataset.sortColumn);
    }

    /**
     * Opens a folder, or the folder grid.
     * @param {?string} conversationId Folder to open, or null for the folder grid.
     * @returns {void}
     */
    #openFolder(conversationId) {
      this.#openFolderId = conversationId;
      this.render();
    }

    /**
     * Sorts by a column; the current column toggles direction, a new one starts ascending.
     * @param {string} column Column key from #SORT_VALUE_BY_COLUMN.
     * @returns {void}
     */
    #sortBy(column) {
      const direction = this.#sortOrder.column === column ? -this.#sortOrder.direction : 1;
      this.#sortOrder = { column, direction };
      this.render();
    }

    /**
     * Shows the folder grid.
     * @returns {void}
     */
    #renderFolderGrid() {
      this.#openFolderId = null;
      this.elements.breadcrumb.innerHTML = '<span>All folders</span>';
      this.elements.folderGrid.hidden = false;
      this.elements.fileTableContainer.hidden = true;
      this.elements.folderGrid.innerHTML = this.#stats.aggregate.folders.map(FilesPanel.#folderHtml).join('') || emptyStateHtml('No files or attachments indexed yet.');
    }

    /**
     * HTML of one folder tile.
     * @param {FileFolder} folder The folder.
     * @returns {string} The tile.
     */
    static #folderHtml(folder) {
      const fileCount = folder.files.length;
      return `
        <div class="claude-plus-folder" data-conversation-id="${escapeHtml(folder.conversationId)}" title="${escapeHtml(folder.conversationTitle)}">
          <div class="claude-plus-folder__icon">📁</div>
          <div class="claude-plus-folder__title">${escapeHtml(folder.conversationTitle)}</div>
          <div class="claude-plus-folder__file-count">${fileCount} file${fileCount === 1 ? '' : 's'}</div>
        </div>`;
    }

    /**
     * Shows a folder's files as a sorted table.
     * @param {FileFolder} folder The folder.
     * @returns {void}
     */
    #renderFileTable(folder) {
      this.elements.breadcrumb.innerHTML = `<span class="claude-plus-breadcrumb__back-link" data-action="back">← All folders</span> / ${escapeHtml(folder.conversationTitle)}`;
      this.elements.folderGrid.hidden = true;
      this.elements.fileTableContainer.hidden = false;
      this.elements.fileTableBody.innerHTML = this.#sortedFiles(folder.files).map(FilesPanel.#fileRowHtml).join('')
        || '<tr><td colspan="4" class="claude-plus-empty-state">No files here.</td></tr>';
    }

    /**
     * Files in the current sort order.
     * @param {FileEntry[]} files The files.
     * @returns {FileEntry[]} A sorted copy.
     */
    #sortedFiles(files) {
      const sortValue = FilesPanel.#SORT_VALUE_BY_COLUMN[this.#sortOrder.column];
      return [...files].sort((first, second) => compareAscending(sortValue(first), sortValue(second)) * this.#sortOrder.direction);
    }

    /**
     * HTML of one table row.
     * @param {FileEntry} file The file.
     * @returns {string} The row.
     */
    static #fileRowHtml(file) {
      return `
        <tr>
          <td>${escapeHtml(file.title || '(file)')}</td>
          <td>${escapeHtml(file.extension)}</td>
          <td>${escapeHtml(new Date(file.timestamp).toLocaleString())}</td>
          <td>${file.source === 'user' ? 'User' : 'Claude'}</td>
        </tr>`;
    }
  }

  /**
   * The dock layout as pure data: splits with fractional sizes whose leaves hold tabbed panels.
   */
  class DockTree {
    /**
     * Creates a tree around a root node.
     * @param {DockNode} root The root.
     */
    constructor(root) {
      this.root = root;
    }

    /**
     * The default layout: the conversation list on the left, the chat panes tabbed in the middle,
     * stats, web sources and files tabbed on the right.
     * @param {string[]} chatPaneIds Panel ids of the chat panes, at least one.
     * @returns {DockTree} A new tree.
     */
    static createDefault(chatPaneIds) {
      return new DockTree({
        type: 'split', direction: 'row', sizes: [0.18, 0.62, 0.2],
        children: [
          DockTree.#createLeaf(['conversations'], 'leaf-conversations'),
          DockTree.#createLeaf(chatPaneIds, 'leaf-chat'),
          DockTree.#createLeaf(['stats', 'webSources', 'files'], 'leaf-extras'),
        ],
      });
    }

    /**
     * Rebuilds a stored layout, dropping anything malformed, unknown or duplicated.
     * @param {*} storedLayout Parsed stored layout.
     * @param {Iterable<string>} knownPanelIds Ids of the existing panels.
     * @returns {?DockTree} The restored tree, or null when nothing valid remains.
     */
    static fromStored(storedLayout, knownPanelIds) {
      const root = DockTree.#sanitizeNode(storedLayout, new Set(knownPanelIds), new Set());
      return root ? new DockTree(root) : null;
    }

    /**
     * Serializable form.
     * @returns {DockNode} The root node.
     */
    toJSON() {
      return this.root;
    }

    /**
     * Finds a zone by id.
     * @param {string} leafId Zone id.
     * @returns {?LeafNode} The zone, or null.
     */
    findLeaf(leafId) {
      return this.#findNode(node => node.type === 'leaf' && node.id === leafId);
    }

    /**
     * Finds the zone containing a panel.
     * @param {string} panelId Panel id.
     * @returns {?LeafNode} The zone, or null when the panel isn't docked.
     */
    findLeafContaining(panelId) {
      return this.#findNode(node => node.type === 'leaf' && node.tabs.includes(panelId));
    }

    /**
     * The first zone in tree order.
     * @returns {LeafNode} The zone.
     */
    firstLeaf() {
      return this.#findNode(node => node.type === 'leaf');
    }

    /**
     * Makes a panel the visible tab of its zone; ignored if the zone doesn't hold it.
     * @param {string} leafId Zone id.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    activateTab(leafId, panelId) {
      const leaf = this.findLeaf(leafId);
      if (leaf && leaf.tabs.includes(panelId)) leaf.activeTab = panelId;
    }

    /**
     * Removes a panel from its zone; an emptied zone is removed unless it is the root.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    removePanel(panelId) {
      const leaf = this.findLeafContaining(panelId);
      if (!leaf) return;
      DockTree.#removeTab(leaf, panelId);
      if (leaf.tabs.length === 0 && leaf !== this.root) this.#removeNode(leaf);
    }

    /**
     * Moves a panel into a zone: 'center' adds it as a tab, a side splits the zone and puts the panel
     * on that side. Dropping a panel onto its own zone only activates it. A missing target falls
     * back to adding a tab to the first zone.
     * @param {string} panelId Panel id.
     * @param {string} targetLeafId Target zone id.
     * @param {string} region 'center', 'left', 'right', 'top' or 'bottom'.
     * @returns {void}
     */
    dockPanel(panelId, targetLeafId, region) {
      if (this.#isDropOntoOwnZone(panelId, targetLeafId, region)) {
        this.activateTab(targetLeafId, panelId);
        return;
      }
      this.removePanel(panelId);
      const targetLeaf = this.findLeaf(targetLeafId);
      if (targetLeaf && region !== 'center') this.#splitLeaf(targetLeaf, panelId, region);
      else DockTree.#addTab(targetLeaf || this.firstLeaf(), panelId);
    }

    /**
     * Docks a panel along an outer edge of the whole workspace. Ignored when the panel is the only one.
     * @param {string} panelId Panel id.
     * @param {string} edge 'left', 'right', 'top' or 'bottom'.
     * @returns {void}
     */
    dockPanelAtEdge(panelId, edge) {
      if (this.#isOnlyPanel(panelId)) return;
      this.removePanel(panelId);
      const edgeShare = LAYOUT.edgeDockFraction;
      this.root = {
        type: 'split',
        direction: DockTree.#directionForSide(edge),
        sizes: DockTree.#isLeadingSide(edge) ? [edgeShare, 1 - edgeShare] : [1 - edgeShare, edgeShare],
        children: DockTree.#orderForSide(edge, this.root, DockTree.#createLeafWithNewId([panelId])),
      };
    }

    /**
     * Moves the boundary after a split child, keeping both neighbours at least LAYOUT.minimumSplitFraction.
     * @param {SplitNode} split The split.
     * @param {number} index Index of the child before the boundary.
     * @param {number[]} startSizes Sizes when the drag started.
     * @param {number} movedFraction Movement as a fraction of the split's extent.
     * @returns {void}
     */
    resizeSplit(split, index, startSizes, movedFraction) {
      const pairSize = startSizes[index] + startSizes[index + 1];
      const firstSize = clamp(startSizes[index] + movedFraction, LAYOUT.minimumSplitFraction, pairSize - LAYOUT.minimumSplitFraction);
      split.sizes[index] = firstSize;
      split.sizes[index + 1] = pairSize - firstSize;
    }

    /**
     * Computes every zone's area and every divider's position.
     * @param {Rect} bounds Area of the whole workspace.
     * @returns {DockLayout} The placements.
     */
    computeLayout(bounds) {
      const layout = { leaves: [], dividers: [] };
      DockTree.#placeNode(this.root, bounds, layout);
      return layout;
    }

    /**
     * Places a node and its descendants.
     * @param {DockNode} node The node.
     * @param {Rect} rect Its area.
     * @param {DockLayout} layout Collected placements; modified in place.
     * @returns {void}
     */
    static #placeNode(node, rect, layout) {
      if (node.type === 'leaf') layout.leaves.push({ leaf: node, rect });
      else DockTree.#placeSplitChildren(node, rect, layout);
    }

    /**
     * Places a split's children one after another along its axis, with a divider between neighbours.
     * @param {SplitNode} split The split.
     * @param {Rect} rect Its area.
     * @param {DockLayout} layout Collected placements; modified in place.
     * @returns {void}
     */
    static #placeSplitChildren(split, rect, layout) {
      const isSideBySide = split.direction === 'row';
      const extent = isSideBySide ? rect.width : rect.height;
      let offset = isSideBySide ? rect.left : rect.top;
      split.children.forEach((child, index) => {
        const childExtent = extent * split.sizes[index];
        DockTree.#placeNode(child, DockTree.#sliceAlongAxis(rect, isSideBySide, offset, childExtent), layout);
        offset += childExtent;
        if (index < split.children.length - 1) layout.dividers.push({ split, index, rect, position: offset });
      });
    }

    /**
     * A slice of a rectangle along one axis.
     * @param {Rect} rect The rectangle.
     * @param {boolean} isSideBySide True to slice horizontally (along x), false vertically (along y).
     * @param {number} offset Start of the slice on that axis.
     * @param {number} extent Length of the slice.
     * @returns {Rect} The slice.
     */
    static #sliceAlongAxis(rect, isSideBySide, offset, extent) {
      return isSideBySide
        ? { left: offset, top: rect.top, width: extent, height: rect.height }
        : { left: rect.left, top: offset, width: rect.width, height: extent };
    }

    /**
     * Whether a drop would leave the layout unchanged: onto the panel's own zone, either as a tab or
     * as a split of a zone holding only that panel.
     * @param {string} panelId Panel id.
     * @param {string} targetLeafId Target zone id.
     * @param {string} region Drop region.
     * @returns {boolean} True for a no-op drop.
     */
    #isDropOntoOwnZone(panelId, targetLeafId, region) {
      const sourceLeaf = this.findLeafContaining(panelId);
      return Boolean(sourceLeaf) && sourceLeaf.id === targetLeafId && (region === 'center' || sourceLeaf.tabs.length === 1);
    }

    /**
     * Whether a panel is the single panel of the whole layout.
     * @param {string} panelId Panel id.
     * @returns {boolean} True when the root is a zone holding only that panel.
     */
    #isOnlyPanel(panelId) {
      return this.root.type === 'leaf' && this.root.tabs.length === 1 && this.root.tabs[0] === panelId;
    }

    /**
     * Replaces a zone with a split of the zone and a new zone holding a panel.
     * @param {LeafNode} targetLeaf Zone to split.
     * @param {string} panelId Panel for the new zone.
     * @param {string} side Side of the new zone: 'left', 'right', 'top' or 'bottom'.
     * @returns {void}
     */
    #splitLeaf(targetLeaf, panelId, side) {
      this.#replaceNode(targetLeaf, {
        type: 'split',
        direction: DockTree.#directionForSide(side),
        sizes: [0.5, 0.5],
        children: DockTree.#orderForSide(side, targetLeaf, DockTree.#createLeafWithNewId([panelId])),
      });
    }

    /**
     * Every node with its parent, depth first.
     * @param {DockNode} node Starting node.
     * @param {?SplitNode} parent Its parent, or null for the root.
     * @yields {{node: DockNode, parent: ?SplitNode}} Each node and its parent.
     * @returns {Generator<{node: DockNode, parent: ?SplitNode}, void, void>} The nodes in tree order.
     */
    static *#walkWithParents(node, parent) {
      yield { node, parent };
      for (const child of node.children ?? []) yield* DockTree.#walkWithParents(child, node);
    }

    /**
     * The first node matching a predicate, with its parent.
     * @param {function(DockNode): boolean} predicate Test for each node.
     * @returns {?{node: DockNode, parent: ?SplitNode}} The match, or null.
     */
    #findWithParent(predicate) {
      for (const entry of DockTree.#walkWithParents(this.root, null)) {
        if (predicate(entry.node)) return entry;
      }
      return null;
    }

    /**
     * The first node matching a predicate.
     * @param {function(DockNode): boolean} predicate Test for each node.
     * @returns {?DockNode} The node, or null.
     */
    #findNode(predicate) {
      const entry = this.#findWithParent(predicate);
      return entry ? entry.node : null;
    }

    /**
     * Puts a replacement where a node is in the tree.
     * @param {DockNode} node Node to replace.
     * @param {DockNode} replacement Its replacement.
     * @returns {void}
     */
    #replaceNode(node, replacement) {
      const { parent } = this.#findWithParent(candidate => candidate === node);
      if (parent) parent.children[parent.children.indexOf(node)] = replacement;
      else this.root = replacement;
    }

    /**
     * Removes a node from its split and rescales the siblings; a split left with one child is
     * replaced by that child.
     * @param {DockNode} node Node to remove; must not be the root.
     * @returns {void}
     */
    #removeNode(node) {
      const { parent } = this.#findWithParent(candidate => candidate === node);
      const index = parent.children.indexOf(node);
      parent.children.splice(index, 1);
      parent.sizes.splice(index, 1);
      parent.sizes = DockTree.#normalizeSizes(parent.sizes);
      if (parent.children.length === 1) this.#replaceNode(parent, parent.children[0]);
    }

    /**
     * Removes a tab from a zone, activating the first remaining tab if it was active.
     * @param {LeafNode} leaf The zone.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    static #removeTab(leaf, panelId) {
      leaf.tabs = leaf.tabs.filter(tab => tab !== panelId);
      if (leaf.activeTab === panelId) leaf.activeTab = leaf.tabs.length ? leaf.tabs[0] : null;
    }

    /**
     * Adds a panel as the active tab of a zone.
     * @param {LeafNode} leaf The zone.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    static #addTab(leaf, panelId) {
      leaf.tabs.push(panelId);
      leaf.activeTab = panelId;
    }

    /**
     * Creates a zone with a given id; the first tab is active.
     * @param {string[]} tabs Panel ids, at least one.
     * @param {string} leafId Zone id.
     * @returns {LeafNode} The zone.
     */
    static #createLeaf(tabs, leafId) {
      return { type: 'leaf', id: leafId, tabs: [...tabs], activeTab: tabs[0] };
    }

    /**
     * Creates a zone with a new unique id.
     * @param {string[]} tabs Panel ids, at least one.
     * @returns {LeafNode} The zone.
     */
    static #createLeafWithNewId(tabs) {
      return DockTree.#createLeaf(tabs, `leaf-${crypto.randomUUID()}`);
    }

    /**
     * Whether a side comes first in its split.
     * @param {string} side 'left', 'right', 'top' or 'bottom'.
     * @returns {boolean} True for left and top.
     */
    static #isLeadingSide(side) {
      return side === 'left' || side === 'top';
    }

    /**
     * Split direction for a side.
     * @param {string} side 'left', 'right', 'top' or 'bottom'.
     * @returns {'row'|'column'} 'row' for left and right, 'column' for top and bottom.
     */
    static #directionForSide(side) {
      return side === 'left' || side === 'right' ? 'row' : 'column';
    }

    /**
     * Orders an existing node and an added one for a split.
     * @param {string} side Side the added node goes on.
     * @param {DockNode} existingNode Node already there.
     * @param {DockNode} addedNode Node being added.
     * @returns {DockNode[]} Both nodes in split order.
     */
    static #orderForSide(side, existingNode, addedNode) {
      return DockTree.#isLeadingSide(side) ? [addedNode, existingNode] : [existingNode, addedNode];
    }

    /**
     * Scales sizes to sum to 1.
     * @param {number[]} sizes Positive sizes.
     * @returns {number[]} The scaled sizes; equal shares if the sum is 0.
     */
    static #normalizeSizes(sizes) {
      const total = sizes.reduce((sum, size) => sum + size, 0);
      return total > 0 ? sizes.map(size => size / total) : sizes.map(() => 1 / sizes.length);
    }

    /**
     * Validates a stored node.
     * @param {*} node Stored node.
     * @param {Set<string>} knownPanelIds Ids of the existing panels.
     * @param {Set<string>} placedPanelIds Panel ids already placed; modified in place.
     * @returns {?DockNode} The cleaned node, or null when nothing valid remains.
     */
    static #sanitizeNode(node, knownPanelIds, placedPanelIds) {
      if (DockTree.#isStoredLeaf(node)) return DockTree.#sanitizeLeaf(node, knownPanelIds, placedPanelIds);
      if (DockTree.#isStoredSplit(node)) return DockTree.#sanitizeSplit(node, knownPanelIds, placedPanelIds);
      return null;
    }

    /**
     * Whether a stored value looks like a zone.
     * @param {*} node Stored value.
     * @returns {boolean} True for an object with type 'leaf' and a tabs array.
     */
    static #isStoredLeaf(node) {
      return Boolean(node) && node.type === 'leaf' && Array.isArray(node.tabs);
    }

    /**
     * Whether a stored value looks like a split.
     * @param {*} node Stored value.
     * @returns {boolean} True for an object with type 'split' and a children array.
     */
    static #isStoredSplit(node) {
      return Boolean(node) && node.type === 'split' && Array.isArray(node.children);
    }

    /**
     * Keeps a stored zone's known, not yet placed tabs.
     * @param {{id: *, tabs: Array<*>, activeTab: *}} node Stored zone.
     * @param {Set<string>} knownPanelIds Ids of the existing panels.
     * @param {Set<string>} placedPanelIds Panel ids already placed; modified in place.
     * @returns {?LeafNode} The zone, or null when no tab remains.
     */
    static #sanitizeLeaf(node, knownPanelIds, placedPanelIds) {
      const tabs = node.tabs.filter(panelId => knownPanelIds.has(panelId) && !placedPanelIds.has(panelId));
      if (tabs.length === 0) return null;
      tabs.forEach(panelId => placedPanelIds.add(panelId));
      const leaf = typeof node.id === 'string' ? DockTree.#createLeaf(tabs, node.id) : DockTree.#createLeafWithNewId(tabs);
      if (tabs.includes(node.activeTab)) leaf.activeTab = node.activeTab;
      return leaf;
    }

    /**
     * Keeps a stored split's valid children and rescales their sizes; a split with one child is
     * replaced by the child.
     * @param {{direction: *, sizes: *, children: Array<*>}} node Stored split.
     * @param {Set<string>} knownPanelIds Ids of the existing panels.
     * @param {Set<string>} placedPanelIds Panel ids already placed; modified in place.
     * @returns {?DockNode} The cleaned node, or null when no child remains.
     */
    static #sanitizeSplit(node, knownPanelIds, placedPanelIds) {
      const keptChildren = node.children
        .map((child, index) => ({ node: DockTree.#sanitizeNode(child, knownPanelIds, placedPanelIds), size: DockTree.#storedSize(node.sizes, index) }))
        .filter(entry => entry.node);
      if (keptChildren.length < 2) return keptChildren.length ? keptChildren[0].node : null;
      return {
        type: 'split',
        direction: node.direction === 'column' ? 'column' : 'row',
        sizes: DockTree.#normalizeSizes(keptChildren.map(entry => entry.size)),
        children: keptChildren.map(entry => entry.node),
      };
    }

    /**
     * A stored child size, if valid.
     * @param {*} sizes Stored sizes.
     * @param {number} index Child index.
     * @returns {number} The size if it is a positive finite number, otherwise 1.
     */
    static #storedSize(sizes, index) {
      const size = Array.isArray(sizes) ? sizes[index] : NaN;
      return Number.isFinite(size) && size > 0 ? size : 1;
    }
  }

  /**
   * A small menu at the pointer that closes on selection or on a press outside it.
   */
  class PopupMenu {
    /**
     * The open menu, or null.
     * @type {?HTMLElement}
     */
    #menuElement = null;

    /**
     * Called with the selected entry's id.
     * @type {?function(string): void}
     */
    #onSelect = null;

    /**
     * Opens the menu, replacing one already open.
     * @param {object} options Menu contents.
     * @param {number} options.left Left edge in viewport pixels.
     * @param {number} options.top Top edge in viewport pixels.
     * @param {ChoiceOption[]} options.entries Entries.
     * @param {function(string): void} options.onSelect Called with the id of the chosen entry.
     * @returns {void}
     */
    open({ left, top, entries, onSelect }) {
      this.close();
      this.#onSelect = onSelect;
      this.#menuElement = createElement('div', {
        className: 'claude-plus-themed claude-plus-popup-menu',
        innerHTML: entries.map(entry => `<div class="claude-plus-popup-menu__entry" data-entry-id="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</div>`).join(''),
      });
      Object.assign(this.#menuElement.style, { left: `${left}px`, top: `${top}px` });
      this.#menuElement.addEventListener('click', this.#handleEntryClick);
      document.body.append(this.#menuElement);
      document.addEventListener('mousedown', this.#handleOutsidePress, true);
    }

    /**
     * Closes the menu if open.
     * @returns {void}
     */
    close() {
      if (!this.#menuElement) return;
      this.#menuElement.remove();
      this.#menuElement = null;
      document.removeEventListener('mousedown', this.#handleOutsidePress, true);
    }

    /**
     * Selects the clicked entry and closes the menu.
     * @param {MouseEvent} event Click inside the menu.
     * @returns {void}
     */
    #handleEntryClick = (event) => {
      const entry = event.target.closest('.claude-plus-popup-menu__entry');
      if (!entry) return;
      const onSelect = this.#onSelect;
      this.close();
      onSelect(entry.dataset.entryId);
    };

    /**
     * Closes the menu when the pointer is pressed outside it.
     * @param {MouseEvent} event Mouse press anywhere.
     * @returns {void}
     */
    #handleOutsidePress = (event) => {
      if (!this.#menuElement.contains(event.target)) this.close();
    };
  }

  /**
   * Renders the dock tree, positions the panels and handles tab dragging, divider resizing and the
   * add-panel menu.
   */
  class DockWorkspace {
    /**
     * Highlight area for each outer edge drop, given the workspace bounds and the capped width and height.
     * @type {Readonly<Record<string, function(Rect, number, number): Rect>>}
     */
    static #EDGE_HIGHLIGHTS = Object.freeze({
      left: (bounds, width) => ({ ...bounds, width }),
      right: (bounds, width) => ({ ...bounds, left: bounds.left + bounds.width - width, width }),
      top: (bounds, width, height) => ({ ...bounds, height }),
      bottom: (bounds, width, height) => ({ ...bounds, top: bounds.top + bounds.height - height, height }),
    });

    /**
     * Highlight area for each zone drop region, given the zone's area.
     * @type {Readonly<Record<string, function(Rect): Rect>>}
     */
    static #REGION_HIGHLIGHTS = Object.freeze({
      center: rect => rect,
      top: rect => ({ ...rect, height: rect.height / 2 }),
      bottom: rect => ({ ...rect, top: rect.top + rect.height / 2, height: rect.height / 2 }),
      left: rect => ({ ...rect, width: rect.width / 2 }),
      right: rect => ({ ...rect, left: rect.left + rect.width / 2, width: rect.width / 2 }),
    });

    /**
     * Panels by id.
     * @type {Map<string, Panel>}
     */
    #panels;

    /**
     * Layout storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Current layout.
     * @type {DockTree}
     */
    #tree;

    /**
     * Zone frames and tab strips, below the panels.
     * @type {HTMLElement}
     */
    #zoneChromeLayer;

    /**
     * Dividers, above the panels so they can be grabbed along their full length.
     * @type {HTMLElement}
     */
    #dividerLayer;

    /**
     * Zone areas from the last layout, used to find drop targets.
     * @type {LeafPlacement[]}
     */
    #leafPlacements = [];

    /**
     * Batches layouts per frame during resizing.
     * @type {FrameScheduler}
     */
    #layoutScheduler = new FrameScheduler(() => this.layout());

    /**
     * The add-panel menu.
     * @type {PopupMenu}
     */
    #addPanelMenu = new PopupMenu();

    /**
     * Creates the default layout.
     * @type {function(): DockTree}
     */
    #createDefaultTree;

    /**
     * Ids of the panels that must always be docked.
     * @type {function(): string[]}
     */
    #requiredPanelIds;

    /**
     * Creates the workspace from the stored layout, or the default one, and docks any required
     * panel the layout lacks.
     * @param {object} options Workspace options.
     * @param {Map<string, Panel>} options.panels Panels by id; panels can be added and removed later.
     * @param {Preferences} options.preferences Layout storage.
     * @param {function(): DockTree} options.createDefaultTree Creates the default layout.
     * @param {function(): string[]} options.requiredPanelIds Ids of the panels that must always be docked.
     */
    constructor({ panels, preferences, createDefaultTree, requiredPanelIds }) {
      this.#panels = panels;
      this.#preferences = preferences;
      this.#createDefaultTree = createDefaultTree;
      this.#requiredPanelIds = requiredPanelIds;
      this.#tree = DockTree.fromStored(preferences.readJson(STORAGE_KEYS.dockLayout), panels.keys()) ?? createDefaultTree();
      this.#dockMissingRequiredPanels();
    }

    /**
     * Adds the layers to the page, lays out and follows window resizes.
     * @returns {void}
     */
    mount() {
      this.#zoneChromeLayer = createElement('div', { className: 'claude-plus-themed claude-plus-zone-chrome-layer' });
      this.#dividerLayer = createElement('div', { className: 'claude-plus-divider-layer' });
      document.body.append(this.#zoneChromeLayer, this.#dividerLayer);
      window.addEventListener('resize', () => this.#layoutScheduler.schedule());
      this.layout();
    }

    /**
     * Restores the default layout and forgets the stored one.
     * @returns {void}
     */
    resetLayout() {
      this.#preferences.remove(STORAGE_KEYS.dockLayout);
      this.#tree = this.#createDefaultTree();
      this.layout();
    }

    /**
     * Adds a panel and docks it to the right of another one, or into the first zone.
     * @param {string} panelId Id of the new panel.
     * @param {Panel} panel The panel.
     * @param {string} besidePanelId Panel to dock it next to.
     * @returns {void}
     */
    addPanel(panelId, panel, besidePanelId) {
      this.#panels.set(panelId, panel);
      const besideLeaf = this.#tree.findLeafContaining(besidePanelId) || this.#tree.firstLeaf();
      this.#tree.dockPanel(panelId, besideLeaf.id, 'right');
      this.#layoutAndSave();
    }

    /**
     * Adds a panel and docks it at a specific drop target, as chosen during a drag started with
     * beginExternalDrag.
     * @param {string} panelId Id of the new panel.
     * @param {Panel} panel The panel.
     * @param {DropTarget} dropTarget Where to dock it: an outer edge, or a region of a zone.
     * @returns {void}
     */
    addPanelAt(panelId, panel, dropTarget) {
      this.#panels.set(panelId, panel);
      if (dropTarget.edge) this.#tree.dockPanelAtEdge(panelId, dropTarget.edge);
      else this.#tree.dockPanel(panelId, dropTarget.leafId, dropTarget.region);
      this.#layoutAndSave();
    }

    /**
     * Drags a floating label for something that doesn't exist as a panel yet, highlighting the same
     * drop targets a tab drag would, and invokes a callback with the chosen target on release. Lets
     * other panels (e.g. the conversation list) offer "drag this to open it as a new pane docked
     * here" without this class needing to know anything about what's being dragged.
     * @param {MouseEvent} startEvent The mousedown that starts the drag.
     * @param {string} label Text shown in the floating drag label.
     * @param {function(DropTarget): void} onDrop Called with the chosen drop target when dropped on one.
     * @returns {void}
     */
    beginExternalDrag(startEvent, label, onDrop) {
      startEvent.preventDefault();
      const dragLabel = createElement('div', { className: 'claude-plus-themed claude-plus-drag-label', textContent: label, hidden: true });
      const dropHighlight = createElement('div', { className: 'claude-plus-drop-highlight', hidden: true });
      document.body.append(dragLabel, dropHighlight);
      let dropTarget = null;
      new DragGesture(startEvent, {
        threshold: LAYOUT.dragThreshold,
        onMove: (event) => {
          dropTarget = this.#dropTargetAt(event.clientX, event.clientY);
          DockWorkspace.#showDragFeedback(dragLabel, dropHighlight, event, dropTarget);
        },
        onEnd: (event, wasDragged) => {
          dragLabel.remove();
          dropHighlight.remove();
          if (wasDragged && dropTarget) onDrop(dropTarget);
        },
      });
    }

    /**
     * Undocks a panel, disposes it and forgets it.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    removePanel(panelId) {
      const panel = this.#panels.get(panelId);
      if (!panel) return;
      this.#tree.removePanel(panelId);
      this.#panels.delete(panelId);
      panel.dispose();
      this.#layoutAndSave();
    }

    /**
     * Adds every required panel missing from the layout as a tab of the first zone.
     * @returns {void}
     */
    #dockMissingRequiredPanels() {
      const missing = this.#requiredPanelIds().filter(panelId => !this.#tree.findLeafContaining(panelId));
      missing.forEach(panelId => this.#tree.dockPanel(panelId, this.#tree.firstLeaf().id, 'center'));
    }

    /**
     * Makes a docked panel the visible tab of its zone.
     * @param {string} panelId Panel id.
     * @returns {boolean} True if the panel is docked and now visible; false if it isn't docked.
     */
    revealPanel(panelId) {
      const leaf = this.#tree.findLeafContaining(panelId);
      if (leaf) this.#activateTab(leaf.id, panelId);
      return Boolean(leaf);
    }

    /**
     * Redraws zone frames, tab strips and dividers and positions the visible panels; other panels are hidden.
     * @returns {void}
     */
    layout() {
      const { leaves, dividers } = this.#tree.computeLayout(this.#workspaceBounds());
      this.#leafPlacements = leaves;
      this.#zoneChromeLayer.replaceChildren();
      this.#dividerLayer.replaceChildren();
      leaves.forEach(placement => this.#renderZone(placement));
      this.#hidePanelsExcept(new Set(leaves.map(placement => placement.leaf.activeTab)));
      dividers.forEach(placement => this.#renderDivider(placement));
    }

    /**
     * Lays out and saves the layout.
     * @returns {void}
     */
    #layoutAndSave() {
      this.layout();
      this.#preferences.writeJson(STORAGE_KEYS.dockLayout, this.#tree);
    }

    /**
     * Area available to the dock, below the toolbar.
     * @returns {Rect} The area.
     */
    #workspaceBounds() {
      return { left: 0, top: LAYOUT.toolbarHeight, width: window.innerWidth, height: window.innerHeight - LAYOUT.toolbarHeight };
    }

    /**
     * Draws a zone and shows its active panel below the tab strip.
     * @param {LeafPlacement} placement The zone and its area.
     * @returns {void}
     */
    #renderZone({ leaf, rect }) {
      this.#renderZoneChrome(leaf, rect);
      if (leaf.activeTab) this.#showPanel(leaf.activeTab, { ...rect, top: rect.top + LAYOUT.tabStripHeight, height: rect.height - LAYOUT.tabStripHeight });
    }

    /**
     * Hides every built panel that isn't visible.
     * @param {Set<string>} visiblePanelIds Ids of the visible panels.
     * @returns {void}
     */
    #hidePanelsExcept(visiblePanelIds) {
      for (const [panelId, panel] of this.#panels) {
        if (!visiblePanelIds.has(panelId) && panel.isBuilt) panel.element.style.visibility = 'hidden';
      }
    }

    /**
     * Positions and shows a panel, adding it to the page on first use.
     * @param {string} panelId Panel id.
     * @param {Rect} contentRect Area below the tab strip.
     * @returns {void}
     */
    #showPanel(panelId, contentRect) {
      const panel = this.#panels.get(panelId);
      if (!panel) return;
      const { element } = panel;
      if (!element.isConnected) document.body.append(element);
      placeElement(element, contentRect);
      element.style.visibility = 'visible';
    }

    /**
     * Title of a panel.
     * @param {string} panelId Panel id.
     * @returns {string} Its title, or the id for an unknown panel.
     */
    #panelTitle(panelId) {
      const panel = this.#panels.get(panelId);
      return panel ? panel.title : panelId;
    }

    /**
     * Draws a zone's frame and tab strip.
     * @param {LeafNode} leaf The zone.
     * @param {Rect} rect Its area.
     * @returns {void}
     */
    #renderZoneChrome(leaf, rect) {
      const frame = createElement('div', { className: 'claude-plus-zone-frame' });
      const tabStrip = createElement('div', { className: 'claude-plus-tab-strip' });
      placeElement(frame, rect);
      placeElement(tabStrip, { ...rect, height: LAYOUT.tabStripHeight });
      tabStrip.append(...leaf.tabs.map(panelId => this.#createTab(leaf, panelId)), this.#createAddPanelButton(leaf.id));
      this.#zoneChromeLayer.append(frame, tabStrip);
    }

    /**
     * Creates a tab that activates its panel on click and starts a drag on press.
     * @param {LeafNode} leaf Zone of the tab.
     * @param {string} panelId Panel id.
     * @returns {HTMLElement} The tab.
     */
    #createTab(leaf, panelId) {
      const className = panelId === leaf.activeTab ? 'claude-plus-tab claude-plus-tab--active' : 'claude-plus-tab';
      const tab = createElement('div', { className, title: this.#panelTitle(panelId) });
      tab.append(createElement('span', { className: 'claude-plus-tab__label', textContent: this.#panelTitle(panelId) }));
      tab.addEventListener('mousedown', event => this.#onTabPress(event, panelId));
      tab.addEventListener('click', () => this.#activateTab(leaf.id, panelId));
      if (this.#canClosePanel(panelId)) tab.append(this.#createCloseButton(panelId));
      return tab;
    }

    /**
     * Whether a panel's tab offers a close button.
     * @param {string} panelId Panel id.
     * @returns {boolean} True when the panel exists and allows closing.
     */
    #canClosePanel(panelId) {
      const panel = this.#panels.get(panelId);
      return Boolean(panel) && panel.canClose();
    }

    /**
     * Creates a tab's close button; pressing it neither activates nor drags the tab.
     * @param {string} panelId Panel id.
     * @returns {HTMLElement} The button.
     */
    #createCloseButton(panelId) {
      const button = createElement('span', { className: 'claude-plus-tab__close-button', textContent: '×', title: 'Close' });
      button.addEventListener('mousedown', event => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.#panels.get(panelId).close();
      });
      return button;
    }

    /**
     * Shows a tab's panel and saves the layout.
     * @param {string} leafId Zone id.
     * @param {string} panelId Panel id.
     * @returns {void}
     */
    #activateTab(leafId, panelId) {
      this.#tree.activateTab(leafId, panelId);
      this.#layoutAndSave();
    }

    /**
     * Creates the "+" button that offers undocked panels for a zone.
     * @param {string} leafId Zone id.
     * @returns {HTMLElement} The button.
     */
    #createAddPanelButton(leafId) {
      const button = createElement('div', { className: 'claude-plus-tab-strip__add-button', textContent: '+', title: 'Add panel to this zone' });
      button.addEventListener('click', event => this.#showAddPanelMenu(event, leafId));
      return button;
    }

    /**
     * Starts a tab drag on a primary-button press.
     * @param {MouseEvent} event The mousedown on a tab.
     * @param {string} panelId Panel of the tab.
     * @returns {void}
     */
    #onTabPress(event, panelId) {
      if (event.button === 0) this.#startTabDrag(event, panelId);
    }

    /**
     * Draws a divider that resizes its split when dragged.
     * @param {DividerPlacement} placement The divider.
     * @returns {void}
     */
    #renderDivider(placement) {
      const isSideBySide = placement.split.direction === 'row';
      const className = isSideBySide ? 'claude-plus-divider claude-plus-divider--vertical' : 'claude-plus-divider claude-plus-divider--horizontal';
      const divider = createElement('div', { className });
      placeElement(divider, DockWorkspace.#dividerGrabArea(placement, isSideBySide));
      divider.addEventListener('mousedown', event => this.#startDividerDrag(event, placement, isSideBySide));
      this.#dividerLayer.append(divider);
    }

    /**
     * Grab area of a divider, centred on the boundary.
     * @param {DividerPlacement} placement The divider.
     * @param {boolean} isSideBySide Whether the split places children side by side.
     * @returns {Rect} The area.
     */
    static #dividerGrabArea({ rect, position }, isSideBySide) {
      const start = position - LAYOUT.dividerThickness / 2;
      return isSideBySide
        ? { left: start, top: rect.top, width: LAYOUT.dividerThickness, height: rect.height }
        : { left: rect.left, top: start, width: rect.width, height: LAYOUT.dividerThickness };
    }

    /**
     * Pointer coordinate along a split axis.
     * @param {MouseEvent} event Pointer event.
     * @param {boolean} isSideBySide True for the x coordinate, false for y.
     * @returns {number} The coordinate.
     */
    static #pointerPositionAlongAxis(event, isSideBySide) {
      return isSideBySide ? event.clientX : event.clientY;
    }

    /**
     * Resizes a split while its divider is dragged, laying out once per frame and saving on release.
     * @param {MouseEvent} startEvent The mousedown on the divider.
     * @param {DividerPlacement} placement The divider.
     * @param {boolean} isSideBySide Whether the split places children side by side.
     * @returns {void}
     */
    #startDividerDrag(startEvent, { split, index, rect }, isSideBySide) {
      startEvent.preventDefault();
      const startSizes = [...split.sizes];
      const startPosition = DockWorkspace.#pointerPositionAlongAxis(startEvent, isSideBySide);
      const extent = isSideBySide ? rect.width : rect.height;
      const resizingClass = isSideBySide ? 'claude-plus-resizing-horizontally' : 'claude-plus-resizing-vertically';
      document.documentElement.classList.add(resizingClass);
      new DragGesture(startEvent, {
        threshold: 0,
        onMove: (event) => {
          this.#tree.resizeSplit(split, index, startSizes, (DockWorkspace.#pointerPositionAlongAxis(event, isSideBySide) - startPosition) / extent);
          this.#layoutScheduler.schedule();
        },
        onEnd: () => {
          document.documentElement.classList.remove(resizingClass);
          this.#layoutScheduler.cancel();
          this.#layoutAndSave();
        },
      });
    }

    /**
     * Drags a tab with a floating label, highlights the drop target and docks the panel on release.
     * @param {MouseEvent} startEvent The mousedown on the tab.
     * @param {string} panelId Panel of the tab.
     * @returns {void}
     */
    #startTabDrag(startEvent, panelId) {
      startEvent.preventDefault();
      const dragLabel = createElement('div', { className: 'claude-plus-themed claude-plus-drag-label', textContent: this.#panelTitle(panelId), hidden: true });
      const dropHighlight = createElement('div', { className: 'claude-plus-drop-highlight', hidden: true });
      document.body.append(dragLabel, dropHighlight);
      let dropTarget = null;
      new DragGesture(startEvent, {
        threshold: LAYOUT.dragThreshold,
        onMove: (event) => {
          dropTarget = this.#dropTargetAt(event.clientX, event.clientY);
          DockWorkspace.#showDragFeedback(dragLabel, dropHighlight, event, dropTarget);
        },
        onEnd: (event, wasDragged) => {
          dragLabel.remove();
          dropHighlight.remove();
          if (wasDragged && dropTarget) this.#dropPanel(panelId, dropTarget);
        },
      });
    }

    /**
     * Moves the drag label to the pointer and highlights the drop target.
     * @param {HTMLElement} dragLabel The floating label.
     * @param {HTMLElement} dropHighlight The drop highlight.
     * @param {MouseEvent} event Current pointer event.
     * @param {?DropTarget} dropTarget Target under the pointer, or null.
     * @returns {void}
     */
    static #showDragFeedback(dragLabel, dropHighlight, event, dropTarget) {
      dragLabel.hidden = false;
      Object.assign(dragLabel.style, { left: `${event.clientX + LAYOUT.dragLabelOffset}px`, top: `${event.clientY + LAYOUT.dragLabelOffset}px` });
      dropHighlight.hidden = !dropTarget;
      if (dropTarget) placeElement(dropHighlight, dropTarget.rect);
    }

    /**
     * Docks a panel at a drop target and saves the layout.
     * @param {string} panelId Panel id.
     * @param {DropTarget} dropTarget Where it was dropped.
     * @returns {void}
     */
    #dropPanel(panelId, dropTarget) {
      if (dropTarget.edge) this.#tree.dockPanelAtEdge(panelId, dropTarget.edge);
      else this.#tree.dockPanel(panelId, dropTarget.leafId, dropTarget.region);
      this.#layoutAndSave();
    }

    /**
     * The drop target under the pointer: an outer workspace edge when near one, otherwise the centre
     * or a side of the zone under the pointer.
     * @param {number} pointerX Pointer x.
     * @param {number} pointerY Pointer y.
     * @returns {?DropTarget} The target, or null outside every zone.
     */
    #dropTargetAt(pointerX, pointerY) {
      const bounds = this.#workspaceBounds();
      const edge = DockWorkspace.#outerEdgeNear(pointerX, pointerY, bounds);
      if (edge) return { edge, leafId: null, region: null, rect: DockWorkspace.#edgeHighlight(edge, bounds) };
      const hoveredZone = this.#leafPlacements.find(({ rect }) => DockWorkspace.#containsPoint(rect, pointerX, pointerY));
      return hoveredZone ? DockWorkspace.#zoneDropTarget(hoveredZone, pointerX, pointerY) : null;
    }

    /**
     * Drop target within a zone.
     * @param {LeafPlacement} placement The zone under the pointer.
     * @param {number} pointerX Pointer x.
     * @param {number} pointerY Pointer y.
     * @returns {DropTarget} The target.
     */
    static #zoneDropTarget({ leaf, rect }, pointerX, pointerY) {
      const region = DockWorkspace.#regionAt((pointerX - rect.left) / rect.width, (pointerY - rect.top) / rect.height);
      return { edge: null, leafId: leaf.id, region, rect: DockWorkspace.#REGION_HIGHLIGHTS[region](rect) };
    }

    /**
     * Whether a point lies inside a rectangle, edges included.
     * @param {Rect} rect The rectangle.
     * @param {number} pointX Point x.
     * @param {number} pointY Point y.
     * @returns {boolean} True when inside.
     */
    static #containsPoint(rect, pointX, pointY) {
      return pointX >= rect.left && pointX <= rect.left + rect.width && pointY >= rect.top && pointY <= rect.top + rect.height;
    }

    /**
     * The outer workspace edge within LAYOUT.edgeDropMargin of a point, checked left, right, top, bottom.
     * @param {number} pointX Point x.
     * @param {number} pointY Point y.
     * @param {Rect} bounds Workspace area.
     * @returns {?string} 'left', 'right', 'top' or 'bottom', or null when no edge is near.
     */
    static #outerEdgeNear(pointX, pointY, bounds) {
      const distanceByEdge = {
        left: pointX - bounds.left,
        right: bounds.left + bounds.width - pointX,
        top: pointY - bounds.top,
        bottom: bounds.top + bounds.height - pointY,
      };
      return Object.keys(distanceByEdge).find(edge => distanceByEdge[edge] < LAYOUT.edgeDropMargin) ?? null;
    }

    /**
     * Highlight area for an outer edge drop, capped in size.
     * @param {string} edge 'left', 'right', 'top' or 'bottom'.
     * @param {Rect} bounds Workspace area.
     * @returns {Rect} The area.
     */
    static #edgeHighlight(edge, bounds) {
      const width = Math.min(bounds.width * LAYOUT.edgeDockFraction, LAYOUT.edgeHighlightMaxWidth);
      const height = Math.min(bounds.height * LAYOUT.edgeDockFraction, LAYOUT.edgeHighlightMaxHeight);
      return DockWorkspace.#EDGE_HIGHLIGHTS[edge](bounds, width, height);
    }

    /**
     * Drop region for a position within a zone: a side when within LAYOUT.sideDropFraction of it
     * (top and bottom first), otherwise the centre.
     * @param {number} fractionAcross Position across the zone, 0 to 1.
     * @param {number} fractionDown Position down the zone, 0 to 1.
     * @returns {string} 'top', 'bottom', 'left', 'right' or 'center'.
     */
    static #regionAt(fractionAcross, fractionDown) {
      const sideShare = LAYOUT.sideDropFraction;
      const candidates = [
        ['top', fractionDown < sideShare],
        ['bottom', fractionDown > 1 - sideShare],
        ['left', fractionAcross < sideShare],
        ['right', fractionAcross > 1 - sideShare],
      ];
      const match = candidates.find(([, isHit]) => isHit);
      return match ? match[0] : 'center';
    }

    /**
     * Opens a menu of the panels not currently docked; selecting one adds it as a tab of the zone.
     * @param {MouseEvent} event Click on the zone's "+" button.
     * @param {string} leafId Zone id.
     * @returns {void}
     */
    #showAddPanelMenu(event, leafId) {
      const entries = [...this.#panels.keys()]
        .filter(panelId => !this.#tree.findLeafContaining(panelId))
        .map(panelId => ({ id: panelId, label: this.#panelTitle(panelId) }));
      if (entries.length === 0) return;
      this.#addPanelMenu.open({
        left: event.clientX,
        top: event.clientY,
        entries,
        onSelect: panelId => this.#addPanelToZone(panelId, leafId),
      });
    }

    /**
     * Adds a panel as a tab of a zone and saves the layout.
     * @param {string} panelId Panel id.
     * @param {string} leafId Zone id.
     * @returns {void}
     */
    #addPanelToZone(panelId, leafId) {
      this.#tree.dockPanel(panelId, leafId, 'center');
      this.#layoutAndSave();
    }
  }

  /**
   * Global keyboard shortcuts. Cmd+K (Ctrl+K elsewhere) reveals the conversation list and focuses
   * its search. Shortcuts are handled in the capture phase and stopped there, so claude.ai's own
   * hidden app never reacts to them.
   */
  class KeyboardShortcuts {
    /**
     * Workspace used to reveal panels.
     * @type {DockWorkspace}
     */
    #workspace;

    /**
     * Panel whose search box the search shortcut focuses.
     * @type {ConversationListPanel}
     */
    #conversationListPanel;

    /**
     * Creates the shortcuts.
     * @param {DockWorkspace} workspace Workspace used to reveal panels.
     * @param {ConversationListPanel} conversationListPanel Panel whose search box the search shortcut focuses.
     */
    constructor(workspace, conversationListPanel) {
      this.#workspace = workspace;
      this.#conversationListPanel = conversationListPanel;
    }

    /**
     * Starts listening for the shortcuts.
     * @returns {void}
     */
    install() {
      window.addEventListener('keydown', this.#handleKeydown, true);
    }

    /**
     * Runs the shortcut matching a key press.
     * @param {KeyboardEvent} event The key press.
     * @returns {void}
     */
    #handleKeydown = (event) => {
      if (!KeyboardShortcuts.#isSearchShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      this.#focusConversationSearch();
    };

    /**
     * Whether a key press is the search shortcut.
     * @param {KeyboardEvent} event The key press.
     * @returns {boolean} True for Cmd+K or Ctrl+K without Shift or Alt.
     */
    static #isSearchShortcut(event) {
      return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k';
    }

    /**
     * Shows the conversation list and focuses its search box; does nothing when the list isn't docked.
     * @returns {void}
     */
    #focusConversationSearch() {
      if (this.#workspace.revealPanel('conversations')) this.#conversationListPanel.focusSearch();
    }
  }

  /**
   * Converts an API conversation into the format-neutral ExportedConversation.
   */
  class ConversationExportBuilder {
    /**
     * Converter per API content block type; other types are kept whole as 'other' blocks.
     * @type {Map<string, function(ContentBlock): ExportedBlock>}
     */
    static #BLOCK_CONVERTERS = new Map([
      ['text', block => ({ type: 'text', text: block.text || '' })],
      ['tool_use', block => ({ type: 'toolCall', name: block.name || null, input: block.input ?? null })],
      ['tool_result', block => ({ type: 'toolResult', name: block.name || null, content: block.content ?? null })],
    ]);

    /**
     * Converts the branch of a conversation that claude.ai shows.
     * @param {ApiConversation} conversation The conversation, with every message.
     * @returns {ExportedConversation} The exportable conversation.
     */
    static build(conversation) {
      return {
        id: conversation.uuid,
        title: conversation.name || UNTITLED,
        createdAt: conversation.created_at ?? null,
        updatedAt: conversation.updated_at,
        exportedAt: new Date().toISOString(),
        messages: ConversationTree.currentBranch(conversation).map(message => ConversationExportBuilder.#convertMessage(message)),
      };
    }

    /**
     * Converts one message.
     * @param {ApiMessage} message The message.
     * @returns {ExportedMessage} The exportable message.
     */
    static #convertMessage(message) {
      return {
        id: message.uuid,
        parentId: message.parent_message_uuid ?? null,
        sender: message.sender,
        createdAt: message.created_at ?? null,
        attachments: MessageContent.uploads(message).map(upload => MessageContent.uploadName(upload)),
        blocks: ConversationExportBuilder.#convertBlocks(message),
      };
    }

    /**
     * Converts a message's content blocks; a plain text field becomes a leading text block when the
     * content has no text of its own.
     * @param {ApiMessage} message The message.
     * @returns {ExportedBlock[]} The blocks, in order.
     */
    static #convertBlocks(message) {
      const blocks = (message.content ?? []).map(block => ConversationExportBuilder.#convertBlock(block));
      const hasTextBlock = blocks.some(block => block.type === 'text');
      return message.text && !hasTextBlock ? [{ type: 'text', text: message.text }, ...blocks] : blocks;
    }

    /**
     * Converts one content block.
     * @param {ContentBlock} block The block.
     * @returns {ExportedBlock} The exportable block.
     */
    static #convertBlock(block) {
      const convert = ConversationExportBuilder.#BLOCK_CONVERTERS.get(block.type);
      return convert ? convert(block) : { type: 'other', originalType: block.type, content: block };
    }
  }

  /**
   * Exports a conversation as a readable Markdown document. Message text is kept as written; tool
   * calls, tool results and unrecognised blocks become collapsible sections with their JSON.
   */
  class MarkdownConversationFormat {
    /**
     * Name shown in the export menu.
     * @type {string}
     */
    static label = 'Markdown';

    /**
     * File extension.
     * @type {string}
     */
    static extension = 'md';

    /**
     * MIME type.
     * @type {string}
     */
    static mimeType = 'text/markdown';

    /**
     * Heading name per sender.
     * @type {Readonly<Record<string, string>>}
     */
    static #SENDER_NAMES = Object.freeze({ human: 'You', assistant: 'Claude' });

    /**
     * Writer per exported block type.
     * @type {Map<string, function(ExportedBlock): string>}
     */
    static #BLOCK_WRITERS = new Map([
      ['text', block => block.text],
      ['toolCall', block => MarkdownConversationFormat.#collapsibleJson(`Tool call: ${block.name || 'tool'}`, block.input)],
      ['toolResult', block => MarkdownConversationFormat.#collapsibleJson(block.name ? `Tool result: ${block.name}` : 'Tool result', block.content)],
      ['other', block => MarkdownConversationFormat.#collapsibleJson(`Content block: ${block.originalType}`, block.content)],
    ]);

    /**
     * Converts a conversation to Markdown.
     * @param {ExportedConversation} conversation The conversation.
     * @returns {string} The document: a header with the conversation details, then one section per message.
     */
    static serialize(conversation) {
      const sections = [MarkdownConversationFormat.#headerMarkdown(conversation), ...conversation.messages.map(message => MarkdownConversationFormat.#messageMarkdown(message))];
      return `${sections.join('\n\n---\n\n')}\n`;
    }

    /**
     * Title and details of the conversation.
     * @param {ExportedConversation} conversation The conversation.
     * @returns {string} The header.
     */
    static #headerMarkdown(conversation) {
      return [
        `# ${conversation.title}`,
        '',
        `- Conversation: ${conversation.id}`,
        `- Created: ${conversation.createdAt ?? 'unknown'}`,
        `- Last updated: ${conversation.updatedAt}`,
        `- Exported: ${conversation.exportedAt}`,
      ].join('\n');
    }

    /**
     * One message: a heading with sender and time, its attachments and its blocks.
     * @param {ExportedMessage} message The message.
     * @returns {string} The section.
     */
    static #messageMarkdown(message) {
      const heading = `## ${MarkdownConversationFormat.#SENDER_NAMES[message.sender] ?? message.sender} · ${message.createdAt ?? 'unknown time'}`;
      const attachments = message.attachments.length ? `Attachments: ${message.attachments.join(', ')}` : '';
      const blocks = message.blocks.map(block => MarkdownConversationFormat.#BLOCK_WRITERS.get(block.type)(block));
      return [heading, attachments, ...blocks].filter(Boolean).join('\n\n');
    }

    /**
     * A collapsible section holding a value as pretty-printed JSON.
     * @param {string} summary Always-visible summary text.
     * @param {*} value Value to show.
     * @returns {string} The section as HTML details wrapping a JSON code block.
     */
    static #collapsibleJson(summary, value) {
      return `<details>\n<summary>${escapeHtml(summary)}</summary>\n\n${markdownCodeFence(JSON.stringify(value, null, 2), 'json')}\n\n</details>`;
    }
  }

  /**
   * Exports a conversation as JSON: the ExportedConversation, pretty-printed.
   */
  class JsonConversationFormat {
    /**
     * Name shown in the export menu.
     * @type {string}
     */
    static label = 'JSON';

    /**
     * File extension.
     * @type {string}
     */
    static extension = 'json';

    /**
     * MIME type.
     * @type {string}
     */
    static mimeType = 'application/json';

    /**
     * Converts a conversation to JSON.
     * @param {ExportedConversation} conversation The conversation.
     * @returns {string} The JSON document.
     */
    static serialize(conversation) {
      return `${JSON.stringify(conversation, null, 2)}\n`;
    }
  }

  /**
   * Exports a conversation as an XML document. Tool inputs, tool results and unrecognised blocks are
   * stored as escaped JSON text; text content is escaped, never wrapped in CDATA.
   */
  class XmlConversationFormat {
    /**
     * Name shown in the export menu.
     * @type {string}
     */
    static label = 'XML';

    /**
     * File extension.
     * @type {string}
     */
    static extension = 'xml';

    /**
     * MIME type.
     * @type {string}
     */
    static mimeType = 'application/xml';

    /**
     * Writer per exported block type.
     * @type {Map<string, function(ExportedBlock): string>}
     */
    static #BLOCK_WRITERS = new Map([
      ['text', block => XmlConversationFormat.#element('text', {}, block.text)],
      ['toolCall', block => XmlConversationFormat.#element('toolCall', { name: block.name }, JSON.stringify(block.input, null, 2))],
      ['toolResult', block => XmlConversationFormat.#element('toolResult', { name: block.name }, JSON.stringify(block.content, null, 2))],
      ['other', block => XmlConversationFormat.#element('contentBlock', { type: block.originalType }, JSON.stringify(block.content, null, 2))],
    ]);

    /**
     * Converts a conversation to XML.
     * @param {ExportedConversation} conversation The conversation.
     * @returns {string} The XML document with a conversation root element holding one message element per message.
     */
    static serialize(conversation) {
      const { id, title, createdAt, updatedAt, exportedAt } = conversation;
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<conversation${XmlConversationFormat.#attributes({ id, title, createdAt, updatedAt, exportedAt })}>`,
        ...conversation.messages.map(message => XmlConversationFormat.#messageXml(message)),
        '</conversation>',
        '',
      ].join('\n');
    }

    /**
     * One message element with its attachments and blocks.
     * @param {ExportedMessage} message The message.
     * @returns {string} The element.
     */
    static #messageXml(message) {
      const { id, parentId, sender, createdAt } = message;
      const children = [
        ...message.attachments.map(name => `<attachment${XmlConversationFormat.#attributes({ name })}/>`),
        ...message.blocks.map(block => XmlConversationFormat.#BLOCK_WRITERS.get(block.type)(block)),
      ];
      return [`  <message${XmlConversationFormat.#attributes({ id, parentId, sender, createdAt })}>`, ...children.map(child => `    ${child}`), '  </message>'].join('\n');
    }

    /**
     * An element with attributes and escaped text content.
     * @param {string} name Element name.
     * @param {Object<string, ?string>} attributes Attributes; null and undefined values are left out.
     * @param {?string} text Text content.
     * @returns {string} The element.
     */
    static #element(name, attributes, text) {
      return `<${name}${XmlConversationFormat.#attributes(attributes)}>${escapeXml(text)}</${name}>`;
    }

    /**
     * Attribute list of an element.
     * @param {Object<string, ?string>} attributes Attributes; null and undefined values are left out.
     * @returns {string} The attributes, each preceded by a space.
     */
    static #attributes(attributes) {
      return Object.entries(attributes)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
        .join('');
    }
  }

  /**
   * Exports the focused pane's conversation to a file, fetching it fresh so the export is complete.
   */
  class ConversationExporter {
    /**
     * Available formats by id, in menu order.
     * @type {Map<string, ExportFormat>}
     */
    static FORMATS = new Map([
      ['markdown', MarkdownConversationFormat],
      ['json', JsonConversationFormat],
      ['xml', XmlConversationFormat],
    ]);

    /**
     * API client.
     * @type {ClaudeApi}
     */
    #api;

    /**
     * Chat panes, for the focused pane's conversation.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Creates the exporter.
     * @param {ClaudeApi} api API client.
     * @param {ChatPaneManager} paneManager Chat panes, for the focused pane's conversation.
     */
    constructor(api, paneManager) {
      this.#api = api;
      this.#paneManager = paneManager;
    }

    /**
     * Downloads the focused pane's conversation in a format. Does nothing in an unsaved new chat; a
     * failure is logged and shown in an alert.
     * @param {string} formatId Key of ConversationExporter.FORMATS.
     * @returns {Promise<void>} Resolves once the download has started or failed.
     */
    async exportOpenConversation(formatId) {
      const conversationId = this.#paneManager.focusedSession.openConversationId;
      if (!conversationId) return;
      try {
        const conversation = ConversationExportBuilder.build(await this.#api.getConversation(conversationId));
        ConversationExporter.#download(conversation, ConversationExporter.FORMATS.get(formatId));
      } catch (error) {
        console.warn(LOG_PREFIX, 'export failed', error);
        await alertDialog(`Export failed: ${error.message}`);
      }
    }

    /**
     * Serializes a conversation and lets the browser save it as "<title> <date>.<extension>".
     * @param {ExportedConversation} conversation The conversation.
     * @param {ExportFormat} format Target format.
     * @returns {void}
     */
    static #download(conversation, format) {
      const fileName = `${fileNameFromTitle(conversation.title)} ${conversation.updatedAt.slice(0, 10)}.${format.extension}`;
      downloadTextFile(fileName, format.serialize(conversation), format.mimeType);
    }
  }

  /**
   * Top bar with the title, the message font size slider, new chat panes, chat export and layout reset.
   */
  class Toolbar {
    /**
     * Allowed and default font sizes in pixels.
     * @type {Readonly<{minimum: number, maximum: number, fallback: number}>}
     */
    static #FONT_SIZE = Object.freeze({ minimum: 11, maximum: 24, fallback: 14 });

    /**
     * Font size storage.
     * @type {Preferences}
     */
    #preferences;

    /**
     * Workspace to reset.
     * @type {DockWorkspace}
     */
    #workspace;

    /**
     * Message font size in pixels.
     * @type {number}
     */
    #messageFontSize;

    /**
     * Chat panes, for opening panes and enabling the export button.
     * @type {ChatPaneManager}
     */
    #paneManager;

    /**
     * Exports the focused pane's conversation.
     * @type {ConversationExporter}
     */
    #exporter;

    /**
     * Menu listing the export formats.
     * @type {PopupMenu}
     */
    #exportMenu = new PopupMenu();

    /**
     * Creates the toolbar with the stored font size, limited to the allowed range.
     * @param {object} services Toolbar dependencies.
     * @param {Preferences} services.preferences Font size storage.
     * @param {DockWorkspace} services.workspace Workspace to reset.
     * @param {ChatPaneManager} services.paneManager Chat panes, for opening panes and enabling the export button.
     * @param {ConversationExporter} services.exporter Exports the focused pane's conversation.
     */
    constructor({ preferences, workspace, paneManager, exporter }) {
      this.#preferences = preferences;
      this.#workspace = workspace;
      this.#paneManager = paneManager;
      this.#exporter = exporter;
      const storedSize = Number.parseFloat(preferences.read(STORAGE_KEYS.messageFontSize));
      const { minimum, maximum, fallback } = Toolbar.#FONT_SIZE;
      this.#messageFontSize = Number.isFinite(storedSize) ? clamp(storedSize, minimum, maximum) : fallback;
    }

    /**
     * Adds the toolbar to the page and applies the font size.
     * @returns {void}
     */
    mount() {
      const { minimum, maximum } = Toolbar.#FONT_SIZE;
      const toolbar = createElement('div', {
        className: 'claude-plus-themed claude-plus-toolbar',
        innerHTML: `
          <div class="claude-plus-toolbar__title">ClaudePlus</div>
          <label class="claude-plus-toolbar__font-size">
            <span>Aa</span>
            <input type="range" data-name="fontSizeSlider" min="${minimum}" max="${maximum}" step="1" value="${this.#messageFontSize}">
            <span data-name="fontSizeLabel"></span>
          </label>
          <div class="claude-plus-fill-remaining"></div>
          <button class="claude-plus-toolbar__button" data-name="newPaneButton" title="Open another chat next to the focused one">+ Chat pane</button>
          <button class="claude-plus-toolbar__button" data-name="exportButton">Export chat ▾</button>
          <button class="claude-plus-toolbar__button" data-name="resetLayoutButton">Reset layout</button>`,
      });
      const elements = collectNamedElements(toolbar);
      elements.fontSizeSlider.addEventListener('input', () => this.#changeFontSize(Number.parseFloat(elements.fontSizeSlider.value), elements.fontSizeLabel));
      elements.resetLayoutButton.addEventListener('click', () => this.#workspace.resetLayout());
      elements.newPaneButton.addEventListener('click', () => this.#paneManager.openPane(null));
      this.#bindExportButton(elements.exportButton);
      this.#applyFontSize(elements.fontSizeLabel);
      document.body.append(toolbar);
    }

    /**
     * Opens the format menu on click and keeps the button's enabled state current.
     * @param {HTMLButtonElement} exportButton The export button.
     * @returns {void}
     */
    #bindExportButton(exportButton) {
      exportButton.addEventListener('click', () => this.#showExportMenu(exportButton));
      this.#paneManager.subscribe('focus', () => this.#updateExportButton(exportButton));
      this.#paneManager.subscribe('paneConversations', () => this.#updateExportButton(exportButton));
      this.#updateExportButton(exportButton);
    }

    /**
     * Enables the export button only while the focused pane shows a saved conversation.
     * @param {HTMLButtonElement} exportButton The export button.
     * @returns {void}
     */
    #updateExportButton(exportButton) {
      exportButton.disabled = !this.#paneManager.focusedSession.openConversationId;
    }

    /**
     * Opens the format menu below the export button.
     * @param {HTMLButtonElement} exportButton The export button.
     * @returns {void}
     */
    #showExportMenu(exportButton) {
      const buttonBounds = exportButton.getBoundingClientRect();
      this.#exportMenu.open({
        left: buttonBounds.left,
        top: buttonBounds.bottom + 4,
        entries: [...ConversationExporter.FORMATS].map(([formatId, format]) => ({ id: formatId, label: format.label })),
        onSelect: formatId => this.#exporter.exportOpenConversation(formatId),
      });
    }

    /**
     * Changes and stores the font size.
     * @param {number} fontSize New size in pixels.
     * @param {HTMLElement} fontSizeLabel Element showing the size.
     * @returns {void}
     */
    #changeFontSize(fontSize, fontSizeLabel) {
      this.#messageFontSize = fontSize;
      this.#preferences.write(STORAGE_KEYS.messageFontSize, fontSize);
      this.#applyFontSize(fontSizeLabel);
    }

    /**
     * Applies the font size to the messages and shows it.
     * @param {HTMLElement} fontSizeLabel Element showing the size.
     * @returns {void}
     */
    #applyFontSize(fontSizeLabel) {
      document.documentElement.style.setProperty('--claude-plus-message-font-size', `${this.#messageFontSize}px`);
      fontSizeLabel.textContent = `${this.#messageFontSize}px`;
    }
  }

  /**
   * Hides claude.ai's two top-level mount points, the only change made to the native app; nothing
   * inside them is ever queried or touched. Applied only once the UI has mounted successfully.
   * @type {string}
   */
  const NATIVE_APP_HIDING_STYLES = '#root, #portal-root { display: none !important; }';

  /**
   * Stylesheet of the whole UI.
   * @type {string}
   */
  const STYLES = `
    :root {
      --claude-plus-color-background: #1a1918;
      --claude-plus-color-bar: #1c1b1a;
      --claude-plus-color-raised: #262523;
      --claude-plus-color-raised-hover: #3a3937;
      --claude-plus-color-human-message: #2a2927;
      --claude-plus-color-tool-details: #232221;
      --claude-plus-color-code-block: #101010;
      --claude-plus-color-button: #333;
      --claude-plus-color-button-hover: #444;
      --claude-plus-color-text: #ececec;
      --claude-plus-color-text-muted: #b8b6b3;
      --claude-plus-color-text-faint: #8a8886;
      --claude-plus-color-accent: #d97757;
      --claude-plus-color-accent-soft: rgba(217, 119, 87, 0.18);
      --claude-plus-color-accent-overlay: rgba(217, 119, 87, 0.35);
      --claude-plus-color-error: #e57373;
      --claude-plus-color-border-faint: rgba(255, 255, 255, 0.05);
      --claude-plus-color-border: rgba(255, 255, 255, 0.08);
      --claude-plus-color-border-strong: rgba(255, 255, 255, 0.12);
      --claude-plus-color-hover: rgba(255, 255, 255, 0.06);
      --claude-plus-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --claude-plus-layer-zone-chrome: 2147480000;
      --claude-plus-layer-panel: 2147480500;
      --claude-plus-layer-divider: 2147480600;
      --claude-plus-layer-toolbar: 2147483000;
      --claude-plus-layer-popup-menu: 2147483001;
      --claude-plus-layer-drop-highlight: 2147483646;
      --claude-plus-layer-drag-label: 2147483647;
    }
    .claude-plus-themed { font-family: var(--claude-plus-font-family); color: var(--claude-plus-color-text); }
    .claude-plus-themed [hidden], .claude-plus-themed[hidden], .claude-plus-drop-highlight[hidden] { display: none !important; }
    html.claude-plus-resizing-horizontally, html.claude-plus-resizing-horizontally * { cursor: col-resize !important; user-select: none; }
    html.claude-plus-resizing-vertically, html.claude-plus-resizing-vertically * { cursor: row-resize !important; user-select: none; }

    .claude-plus-toolbar { position: fixed; top: 0; left: 0; right: 0; height: ${LAYOUT.toolbarHeight}px; z-index: var(--claude-plus-layer-toolbar); background: var(--claude-plus-color-bar); border-bottom: 1px solid var(--claude-plus-color-border-strong); display: flex; align-items: center; gap: 14px; padding: 0 10px; font-size: 12px; box-sizing: border-box; }
    .claude-plus-toolbar__title { font-weight: 600; }
    .claude-plus-toolbar__button { background: var(--claude-plus-color-button); border: none; color: var(--claude-plus-color-text); padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .claude-plus-toolbar__button:hover { background: var(--claude-plus-color-button-hover); }
    .claude-plus-toolbar__button:disabled { opacity: 0.5; cursor: default; }
    .claude-plus-toolbar__font-size { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .claude-plus-toolbar__font-size input[type=range] { width: 100px; }

    .claude-plus-zone-chrome-layer { position: fixed; inset: 0; pointer-events: none; z-index: var(--claude-plus-layer-zone-chrome); }
    .claude-plus-zone-frame { position: fixed; background: var(--claude-plus-color-background); border: 1px solid var(--claude-plus-color-border); box-sizing: border-box; }
    .claude-plus-tab-strip { position: fixed; display: flex; align-items: center; background: var(--claude-plus-color-bar); border-bottom: 1px solid var(--claude-plus-color-border); overflow-x: auto; box-sizing: border-box; pointer-events: auto; }
    .claude-plus-tab { padding: 5px 12px; font-size: 12px; color: var(--claude-plus-color-text-muted); cursor: pointer; white-space: nowrap; border-right: 1px solid var(--claude-plus-color-border-faint); user-select: none; }
    .claude-plus-tab--active { color: var(--claude-plus-color-text); border-bottom: 2px solid var(--claude-plus-color-accent); }
    .claude-plus-tab { display: flex; align-items: center; min-width: 0; max-width: 220px; }
    .claude-plus-tab__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .claude-plus-tab__close-button { flex-shrink: 0; margin-left: 8px; padding: 0 3px; border-radius: 3px; color: var(--claude-plus-color-text-faint); }
    .claude-plus-tab__close-button:hover { background: var(--claude-plus-color-hover); color: var(--claude-plus-color-text); }
    .claude-plus-tab-strip__add-button { padding: 5px 10px; cursor: pointer; color: var(--claude-plus-color-text-faint); user-select: none; }
    .claude-plus-tab-strip__add-button:hover { color: var(--claude-plus-color-text); }
    .claude-plus-divider-layer { position: fixed; inset: 0; pointer-events: none; z-index: var(--claude-plus-layer-divider); }
    .claude-plus-divider { position: fixed; pointer-events: auto; background: transparent; }
    .claude-plus-divider--vertical { cursor: col-resize; }
    .claude-plus-divider--horizontal { cursor: row-resize; }
    .claude-plus-divider:hover { background: var(--claude-plus-color-accent); }
    .claude-plus-drag-label { position: fixed; z-index: var(--claude-plus-layer-drag-label); background: var(--claude-plus-color-accent); color: #fff; padding: 4px 10px; border-radius: 6px; font-size: 12px; pointer-events: none; }
    .claude-plus-drop-highlight { position: fixed; z-index: var(--claude-plus-layer-drop-highlight); background: var(--claude-plus-color-accent-overlay); border: 2px solid var(--claude-plus-color-accent); pointer-events: none; box-sizing: border-box; }
    .claude-plus-popup-menu { position: fixed; z-index: var(--claude-plus-layer-popup-menu); background: var(--claude-plus-color-raised); border: 1px solid var(--claude-plus-color-border-strong); border-radius: 6px; padding: 4px; min-width: 140px; font-size: 12px; }
    .claude-plus-popup-menu__entry { padding: 6px 10px; cursor: pointer; border-radius: 4px; }
    .claude-plus-popup-menu__entry:hover { background: var(--claude-plus-color-raised-hover); }

    .claude-plus-dialog-overlay { position: fixed; inset: 0; z-index: var(--claude-plus-layer-drag-label); background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; }
    .claude-plus-dialog { background: var(--claude-plus-color-raised); border: 1px solid var(--claude-plus-color-border-strong); border-radius: 8px; padding: 16px; max-width: 360px; font-size: 13px; }
    .claude-plus-dialog__message { margin: 0 0 14px; line-height: 1.4; }
    .claude-plus-dialog__actions { display: flex; justify-content: flex-end; gap: 8px; }

    .claude-plus-panel { position: fixed; z-index: var(--claude-plus-layer-panel); box-sizing: border-box; padding: 10px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; font-size: 13px; background: var(--claude-plus-color-background); }
    .claude-plus-panel summary { cursor: pointer; padding: 4px 0; }
    .claude-plus-panel--focused { box-shadow: inset 0 2px 0 var(--claude-plus-color-accent); }
    .claude-plus-panel select, .claude-plus-panel input[type=text], .claude-plus-panel textarea { background: var(--claude-plus-color-bar); border: 1px solid var(--claude-plus-color-border-strong); border-radius: 6px; color: var(--claude-plus-color-text); font-size: 12px; font-family: inherit; }
    .claude-plus-panel__section { padding: 8px 0; border-bottom: 1px solid var(--claude-plus-color-hover); flex-shrink: 0; }
    .claude-plus-panel__section:last-child { border-bottom: none; }
    .claude-plus-value-row { display: flex; justify-content: space-between; padding: 2px 0; gap: 8px; }
    .claude-plus-value-row span { color: var(--claude-plus-color-text-muted); }
    .claude-plus-spaced-above { margin-top: 6px; }
    .claude-plus-hint { color: var(--claude-plus-color-text-faint); font-size: 11px; margin-top: 4px; }
    .claude-plus-scrollable { overflow-y: auto; }
    .claude-plus-fill-remaining { flex: 1; min-height: 0; }
    .claude-plus-empty-state { color: var(--claude-plus-color-text-faint); font-style: italic; padding: 6px 0; }
    .claude-plus-empty-state--padded { padding: 24px; }
    .claude-plus-pending { opacity: 0.4; pointer-events: none; }
    .claude-plus-primary-button { padding: 8px; background: var(--claude-plus-color-accent); border: none; border-radius: 6px; color: #fff; font-size: 13px; cursor: pointer; font-weight: 600; flex-shrink: 0; }
    .claude-plus-primary-button:disabled { opacity: 0.6; cursor: default; }
    .claude-plus-full-width { width: 100%; }

    .claude-plus-search-input { flex-shrink: 0; padding: 6px 8px; }
    .claude-plus-conversation-list-toolbar { display: flex; gap: 6px; flex-shrink: 0; }
    .claude-plus-conversation-list-toolbar select { flex: 1; min-width: 0; padding: 4px 6px; }
    .claude-plus-conversation-list-toolbar .claude-plus-toolbar__button { flex-shrink: 0; padding: 4px 8px; }
    .claude-plus-column-toggles { display: flex; flex-wrap: wrap; gap: 2px 10px; flex-shrink: 0; font-size: 11px; color: var(--claude-plus-color-text-muted); }
    .claude-plus-column-toggle { display: flex; align-items: center; gap: 4px; cursor: pointer; }
    .claude-plus-conversation { padding: 8px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 4px; }
    .claude-plus-conversation:hover { background: var(--claude-plus-color-hover); }
    .claude-plus-conversation:hover .claude-plus-conversation__action-button { visibility: visible; }
    .claude-plus-conversation--active { background: var(--claude-plus-color-accent-soft); }
    .claude-plus-conversation--open-elsewhere { box-shadow: inset 2px 0 0 var(--claude-plus-color-accent); }
    .claude-plus-conversation__summary { flex: 1; min-width: 0; }
    .claude-plus-conversation__title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .claude-plus-conversation__badges { display: flex; flex-wrap: wrap; gap: 2px 8px; margin-top: 2px; }
    .claude-plus-conversation__badge { font-size: 11px; color: var(--claude-plus-color-text-faint); }
    .claude-plus-conversation__action-button { visibility: hidden; background: none; border: none; cursor: pointer; font-size: 12px; padding: 4px; border-radius: 4px; flex-shrink: 0; }
    .claude-plus-conversation__action-button:hover { background: rgba(255, 255, 255, 0.1); }

    .claude-plus-message-list { display: flex; flex-direction: column; gap: 14px; }
    .claude-plus-message { padding: 10px 12px; border-radius: 8px; max-width: 100%; }
    .claude-plus-message--human { background: var(--claude-plus-color-human-message); align-self: flex-end; }
    .claude-plus-message--assistant { background: transparent; }
    .claude-plus-message__sender { font-size: 11px; color: var(--claude-plus-color-text-faint); margin-bottom: 4px; font-weight: 600; }
    .claude-plus-message__body { font-size: var(--claude-plus-message-font-size, 14px); line-height: 1.5; overflow-wrap: break-word; }
    .claude-plus-message__actions { display: flex; gap: 8px; margin-top: 6px; }
    .claude-plus-message__action-button { background: none; border: none; color: var(--claude-plus-color-text-faint); cursor: pointer; font-size: 11px; padding: 2px 6px; border-radius: 4px; }
    .claude-plus-message__action-button:hover { background: var(--claude-plus-color-border); color: var(--claude-plus-color-text); }
    .claude-plus-message-text { white-space: normal; }
    .claude-plus-message-text a { color: var(--claude-plus-color-accent); }
    .claude-plus-message-attachment { color: var(--claude-plus-color-text-muted); font-size: 12px; margin-bottom: 4px; }
    .claude-plus-message-error { color: var(--claude-plus-color-error); margin-top: 6px; }
    .claude-plus-tool-details { margin: 6px 0; background: var(--claude-plus-color-tool-details); border-radius: 6px; padding: 4px 8px; font-size: 12px; }
    .claude-plus-tool-details pre { white-space: pre-wrap; overflow-wrap: break-word; font-size: 11px; color: var(--claude-plus-color-text-muted); }
    .claude-plus-code-block { background: var(--claude-plus-color-code-block); padding: 8px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
    .claude-plus-streaming-cursor { animation: claude-plus-blink 1s step-start infinite; }
    @keyframes claude-plus-blink { 50% { opacity: 0; } }

    .claude-plus-composer { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; padding-top: 8px; border-top: 1px solid var(--claude-plus-color-border); }
    .claude-plus-composer__options { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; flex-shrink: 0; }
    .claude-plus-composer__options select { padding: 4px 6px; }
    .claude-plus-composer__thinking-toggle { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--claude-plus-color-text-muted); cursor: pointer; }
    .claude-plus-panel .claude-plus-composer__input { resize: vertical; min-height: 60px; border-radius: 8px; padding: 8px; font-size: 14px; }
    .claude-plus-composer__send-button--stop { background: var(--claude-plus-color-button-hover); }

    .claude-plus-source-filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; flex-shrink: 0; }
    .claude-plus-source-filters select, .claude-plus-source-filters input[type=text] { flex: 1; min-width: 100px; padding: 5px 6px; }
    .claude-plus-source { padding: 6px 0; border-top: 1px solid var(--claude-plus-color-border-faint); }
    .claude-plus-source:first-child { border-top: none; }
    .claude-plus-source a { color: var(--claude-plus-color-accent); text-decoration: none; }
    .claude-plus-source a:hover { text-decoration: underline; }
    .claude-plus-source__details { color: var(--claude-plus-color-text-faint); font-size: 11px; margin-top: 2px; }

    .claude-plus-folder-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 10px; align-content: start; }
    .claude-plus-folder { display: flex; flex-direction: column; align-items: center; text-align: center; cursor: pointer; padding: 8px 4px; border-radius: 8px; }
    .claude-plus-folder:hover { background: var(--claude-plus-color-hover); }
    .claude-plus-folder__icon { font-size: 28px; }
    .claude-plus-folder__title { font-size: 11px; margin-top: 4px; overflow-wrap: anywhere; }
    .claude-plus-folder__file-count { font-size: 10px; color: var(--claude-plus-color-text-faint); }
    .claude-plus-breadcrumb { font-size: 12px; color: var(--claude-plus-color-text-muted); margin-bottom: 6px; flex-shrink: 0; }
    .claude-plus-breadcrumb__back-link { color: var(--claude-plus-color-accent); cursor: pointer; }
    .claude-plus-file-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .claude-plus-file-table th { text-align: left; cursor: pointer; padding: 4px 6px; color: var(--claude-plus-color-text-muted); border-bottom: 1px solid var(--claude-plus-color-border-strong); position: sticky; top: 0; background: var(--claude-plus-color-raised); }
    .claude-plus-file-table td { padding: 4px 6px; border-bottom: 1px solid var(--claude-plus-color-border-faint); }
  `;

  /**
   * Composes every part of the UI and starts it.
   */
  class ClaudePlusApp {
    /**
     * Creates the object stores that don't exist yet.
     * @param {IDBDatabase} database Database being upgraded.
     * @returns {void}
     */
    static #createMissingStores(database) {
      for (const [storeKey, storeName] of Object.entries(DATABASE.stores)) {
        if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: DATABASE.keyPaths[storeKey] });
      }
    }

    /**
     * Creates every panel, keyed by panel id: the conversation list, one panel per chat pane and
     * the stats, web sources and files panels.
     * @param {object} services Shared services.
     * @param {ConversationDirectory} services.directory Shared conversation list.
     * @param {Router} services.router Navigation.
     * @param {ChatPaneManager} services.paneManager Chat panes.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {ActivityTracker} services.activity Active-time tracking.
     * @param {RateLimitMonitor} services.rateLimits Usage windows.
     * @param {Preferences} services.preferences Column and sort preference storage.
     * @returns {Map<string, Panel>} The panels.
     */
    static #createPanels({ directory, router, paneManager, stats, activity, rateLimits, preferences }) {
      return new Map([
        ['conversations', new ConversationListPanel({ directory, router, paneManager, stats, preferences })],
        ...paneManager.panelEntries(),
        ['stats', new StatsPanel(stats, activity, rateLimits)],
        ['webSources', new WebSourcesPanel(stats)],
        ['files', new FilesPanel(stats)],
      ]);
    }

    /**
     * Mounts the UI, then hides claude.ai and loads the data. If mounting fails, everything this
     * script added is removed again, so claude.ai stays usable instead of turning into a blank page.
     * @returns {Promise<void>} Resolves once the first conversation is shown, or after a failed mount.
     */
    async start() {
      const services = ClaudePlusApp.#mountOrRestore();
      if (services) await ClaudePlusApp.#loadData(services);
    }

    /**
     * Mounts the UI and hides the native app, or undoes everything when mounting throws.
     * @returns {?object} The services needing data (directory, router, paneManager, stats, activity, rateLimits), or null after a failure.
     */
    static #mountOrRestore() {
      try {
        const services = ClaudePlusApp.#mountInterface();
        document.head.append(createElement('style', { className: 'claude-plus-styles', textContent: NATIVE_APP_HIDING_STYLES }));
        return services;
      } catch (error) {
        ClaudePlusApp.#removeInterface();
        console.error(LOG_PREFIX, 'failed to start; claude.ai was left unchanged', error);
        return null;
      }
    }

    /**
     * Injects the styles, builds every component and mounts the toolbar and the workspace.
     * @returns {object} The services needing data: directory, router, paneManager, stats, activity and rateLimits.
     * @throws {Error} When any part fails to build or mount.
     */
    static #mountInterface() {
      document.head.append(createElement('style', { className: 'claude-plus-styles', textContent: STYLES }));
      const preferences = new Preferences();
      const api = new ClaudeApi();
      const database = new IndexedDbStore({ name: DATABASE.name, version: DATABASE.version, upgrade: ClaudePlusApp.#createMissingStores });
      const settings = new ComposerSettings(preferences);
      const directory = new ConversationDirectory(api);
      const paneManager = new ChatPaneManager({ api, settings, directory, preferences });
      const router = new Router(paneManager);
      const stats = new StatsIndex(api, database);
      const activity = new ActivityTracker(database);
      const rateLimits = new RateLimitMonitor(api);
      ClaudePlusApp.#connectServices({ directory, paneManager, stats, rateLimits });
      paneManager.restorePanes(conversationIdFromPath(location.pathname));

      const panels = ClaudePlusApp.#createPanels({ directory, router, paneManager, stats, activity, rateLimits, preferences });
      const workspace = new DockWorkspace({
        panels,
        preferences,
        createDefaultTree: () => DockTree.createDefault(paneManager.paneIds),
        requiredPanelIds: () => paneManager.paneIds,
      });
      paneManager.attachWorkspace(workspace);
      new Toolbar({ preferences, workspace, paneManager, exporter: new ConversationExporter(api, paneManager) }).mount();
      workspace.mount();
      ClaudePlusApp.#refreshTabTitlesOnChange(workspace, directory, paneManager);
      new KeyboardShortcuts(workspace, panels.get('conversations')).install();
      return { directory, router, paneManager, stats, activity, rateLimits };
    }

    /**
     * Feeds loaded and deleted conversations to the stats and streamed usage windows to the monitor.
     * @param {object} services Services to connect.
     * @param {ConversationDirectory} services.directory Shared conversation list.
     * @param {ChatPaneManager} services.paneManager Chat panes.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {RateLimitMonitor} services.rateLimits Usage windows.
     * @returns {void}
     */
    static #connectServices({ directory, paneManager, stats, rateLimits }) {
      paneManager.subscribe('conversationLoaded', conversation => stats.indexConversation(conversation));
      paneManager.subscribe('rateLimits', limits => rateLimits.setLimits(limits));
      directory.subscribe('conversationDeleted', conversationId => stats.removeConversation(conversationId));
    }

    /**
     * Redraws the tab strips when a chat pane's title can have changed.
     * @param {DockWorkspace} workspace The workspace.
     * @param {ConversationDirectory} directory Shared conversation list, whose titles the chat tabs show.
     * @param {ChatPaneManager} paneManager Chat panes.
     * @returns {void}
     */
    static #refreshTabTitlesOnChange(workspace, directory, paneManager) {
      directory.subscribe('conversations', () => workspace.layout());
      paneManager.subscribe('paneConversations', () => workspace.layout());
    }

    /**
     * Removes every element and stylesheet this script added.
     * @returns {void}
     */
    static #removeInterface() {
      document.querySelectorAll('.claude-plus-styles, body > [class*="claude-plus-"]').forEach(element => element.remove());
    }

    /**
     * Starts polling, loads stats, activity and the conversation list, opens the URL's conversation
     * in the focused pane and reopens the other panes' conversations.
     * @param {object} services Services created by #mountInterface.
     * @param {ConversationDirectory} services.directory Shared conversation list.
     * @param {Router} services.router Navigation.
     * @param {ChatPaneManager} services.paneManager Chat panes.
     * @param {StatsIndex} services.stats Conversation statistics.
     * @param {ActivityTracker} services.activity Active-time tracking.
     * @param {RateLimitMonitor} services.rateLimits Usage windows.
     * @returns {Promise<void>} Resolves once the focused pane's conversation is shown.
     */
    static async #loadData({ directory, router, paneManager, stats, activity, rateLimits }) {
      rateLimits.start();
      await Promise.all([stats.refreshAggregate(), activity.start(), directory.refresh()]);
      paneManager.openRestoredConversations();
      await router.start();
    }
  }

  new ClaudePlusApp().start().catch(error => console.error(LOG_PREFIX, 'failed to start', error));
})();
