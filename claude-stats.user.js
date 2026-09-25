// ==UserScript==
// @name         Claude.ai VS Code-style UX (full replacement, server API only)
// @namespace    skydotnet.claude.vsux
// @version      5.0.0
// @description  Replaces claude.ai's entire UI with a VS Code-style dockable/resizable/tabbable
//               workspace: custom sidebar (conversation list), custom message list, custom
//               composer, plus Stats/Web Sources/Files panels. The native app is hidden behind a
//               single display:none on its root container and is NEVER queried, read, moved, or
//               otherwise touched again — every panel here is rendered purely from claude.ai's
//               internal REST/completion API.
// @match        https://claude.ai/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TOOLBAR_H = 36;
  const TABSTRIP_H = 26;
  const DB_NAME = 'claude_stats_v1';
  const DB_VERSION = 1;
  const MAX_RESPONSE_GAP_MS = 30 * 60 * 1000;
  const RATE_LIMIT_POLL_MS = 30 * 1000;

  // ================= IndexedDB (stats cache only) =================
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'uuid' });
        if (!db.objectStoreNames.contains('activity')) db.createObjectStore('activity', { keyPath: 'day' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  function idbGet(store, key) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }
  function idbPut(store, value) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }
  function idbGetAll(store) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  // ================= Small helpers =================
  function uuidv4() { return crypto.randomUUID(); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }
  function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

  // ================= gzip (the completion endpoint requires a gzip-compressed JSON body) =================
  async function gzipJson(obj) {
    const enc = new TextEncoder().encode(JSON.stringify(obj));
    const stream = new Blob([enc]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ================= claude.ai internal API (the ONLY source of data/actions for this whole UI) =================
  let orgIdCache = null;
  async function getOrgId() {
    if (orgIdCache) return orgIdCache;
    const res = await fetch('/api/organizations');
    const orgs = await res.json();
    orgIdCache = orgs[0].uuid;
    return orgIdCache;
  }
  async function listConversations(offset, limit) {
    const orgId = await getOrgId();
    const p = new URLSearchParams();
    p.set('limit', String(limit || 50));
    p.set('offset', String(offset || 0));
    const res = await fetch(`/api/organizations/${orgId}/chat_conversations?${p.toString()}`);
    if (!res.ok) return [];
    return res.json();
  }
  async function getConversation(convId) {
    const orgId = await getOrgId();
    const p = new URLSearchParams();
    p.set('tree', 'True'); p.set('rendering_mode', 'messages'); p.set('render_all_tools', 'true');
    const res = await fetch(`/api/organizations/${orgId}/chat_conversations/${convId}?${p.toString()}`);
    if (!res.ok) return null;
    return res.json();
  }
  async function fetchRateLimits() {
    try {
      const orgId = await getOrgId();
      const res = await fetch(`/api/organizations/${orgId}/usage`);
      if (!res.ok) return null;
      const json = await res.json();
      return { five_hour: json.five_hour, seven_day: json.seven_day };
    } catch (e) { return null; }
  }

  // The completion endpoint only accepts a fixed whitelist of locale tags — navigator.language
  // (e.g. "en-GB", "de") is usually NOT one of them and the request is rejected with a 400.
  const ALLOWED_LOCALES = ['en-US', 'de-DE', 'fr-FR', 'ko-KR', 'ja-JP', 'es-419', 'es-ES', 'it-IT', 'hi-IN', 'pt-BR', 'id-ID'];
  function resolveLocale() {
    const lang = navigator.language || 'en-US';
    if (ALLOWED_LOCALES.includes(lang)) return lang;
    const base = lang.split('-')[0];
    const match = ALLOWED_LOCALES.find(l => l.startsWith(base + '-'));
    return match || 'en-US';
  }

  // Sends a prompt (new or continuing conversation) and yields parsed SSE events as they arrive.
  async function* sendCompletion({ convId, prompt, parentUuid, isNew, model, thinkingMode, effort, signal }) {
    const orgId = await getOrgId();
    const body = {
      prompt,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      locale: resolveLocale(),
      model: model || 'claude-sonnet-5',
      effort: effort || 'low',
      thinking_mode: thinkingMode || 'off',
      tools: [],
      turn_message_uuids: { human_message_uuid: uuidv4(), assistant_message_uuid: uuidv4() },
      attachments: [],
      files: [],
      sync_sources: [],
      completion_request_id: uuidv4(),
      rendering_mode: 'messages',
    };
    if (isNew) {
      body.create_conversation_params = {
        name: '', model: body.model, include_conversation_preferences: true,
        paprika_mode: null, compass_mode: null, tool_search_mode: 'auto',
        is_temporary: false, chat_memory_mode: 'enabled', enabled_imagine: false,
      };
    } else {
      body.parent_message_uuid = parentUuid;
    }
    const compressed = await gzipJson(body);
    const res = await fetch(`/api/organizations/${orgId}/chat_conversations/${convId}/completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'text/event-stream', 'Content-Encoding': 'gzip' },
      body: compressed,
      signal,
    });
    if (!res.ok || !res.body) {
      let detail = '';
      try { detail = await res.text(); } catch (e) {}
      throw new Error(`completion failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    yield { type: '__meta', human_message_uuid: body.turn_message_uuids.human_message_uuid, assistant_message_uuid: body.turn_message_uuids.assistant_message_uuid };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = chunk.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        try { yield JSON.parse(dataLine.slice(5).trim()); } catch (e) { /* skip malformed chunk */ }
      }
    }
  }

  // ================= Tiny markdown-ish renderer (no external deps) =================
  function renderInline(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }
  function renderMarkdown(text) {
    if (!text) return '';
    const parts = text.split(/```(\w*)\n([\s\S]*?)```/g);
    let html = '';
    for (let i = 0; i < parts.length; i += 3) {
      const plain = parts[i];
      if (plain) html += renderInline(plain).replace(/\n/g, '<br>');
      const lang = parts[i + 1], code = parts[i + 2];
      if (code !== undefined) html += `<pre class="cs-code"><code>${escapeHtml(code)}</code></pre>`;
    }
    return html;
  }

  function attachmentName(att) { return att.file_name || att.name || att.filename || att.title || '(uploaded file)'; }

  function renderMessageBlocks(msg) {
    let html = '';
    const uploads = [...(msg.attachments || []), ...(msg.files || [])];
    for (const att of uploads) {
      if (!att) continue;
      html += `<div class="cs-msg-file">📎 ${escapeHtml(attachmentName(att))}</div>`;
    }
    if (msg.text) html += `<div class="cs-msg-text">${renderMarkdown(msg.text)}</div>`;
    for (const block of msg.content || []) {
      if (block.type === 'text' && block.text) {
        html += `<div class="cs-msg-text">${renderMarkdown(block.text)}</div>`;
      } else if (block.type === 'tool_use') {
        html += `<details class="cs-msg-tool"><summary>🔧 ${escapeHtml(block.name || 'tool')}</summary><pre>${escapeHtml(JSON.stringify(block.input || {}, null, 2))}</pre></details>`;
      } else if (block.type === 'tool_result') {
        const items = Array.isArray(block.content) ? block.content : [];
        const summary = items.map(it => it && it.title ? it.title : (it && it.type) || '').filter(Boolean).join(', ');
        html += `<details class="cs-msg-tool"><summary>📄 result${summary ? ': ' + escapeHtml(summary) : ''}</summary><pre>${escapeHtml(JSON.stringify(items, null, 2).slice(0, 4000))}</pre></details>`;
      }
    }
    return html || '<div class="cs-msg-text cs-empty">(no content)</div>';
  }

  // ================= Conversation state (single source of truth for Messages + Composer panels) =================
  const MODELS = [
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ];
  const state = {
    convId: null,
    messages: [],       // [{uuid, sender, html, streaming}]
    streamingUuid: null,
    sending: false,
    conversations: [],  // sidebar list cache
    model: localStorage.getItem('cs_model') || MODELS[0].id,
    thinkingMode: localStorage.getItem('cs_thinking_mode') || 'off', // 'off' or 'extended' — the API rejects anything else
    effort: localStorage.getItem('cs_effort') || 'low',
    abortController: null,
  };
  const listeners = { messages: [], sidebar: [] };
  function onMessagesChange(fn) { listeners.messages.push(fn); }
  function onSidebarChange(fn) { listeners.sidebar.push(fn); }
  function emitMessages() { listeners.messages.forEach(fn => fn()); }
  function emitSidebar() { listeners.sidebar.forEach(fn => fn()); }

  async function loadConversation(convId) {
    state.convId = convId;
    state.messages = [];
    emitMessages();
    const conv = await getConversation(convId);
    if (!conv || state.convId !== convId) return;
    state.messages = (conv.chat_messages || []).map(m => ({ uuid: m.uuid, sender: m.sender, html: renderMessageBlocks(m), _raw: messageText(m) }));
    emitMessages();
    indexForStats(conv);
  }

  async function startNewConversation() {
    state.convId = null;
    state.messages = [];
    emitMessages();
  }

  // parentOverride lets Retry re-ask using an earlier point in the tree without duplicating the
  // human bubble that's already on screen.
  async function sendPrompt(prompt, { parentOverride, skipHumanBubble } = {}) {
    if (!prompt || !prompt.trim() || state.sending) return;
    state.sending = true;
    const isNew = !state.convId;
    const convId = state.convId || uuidv4();
    const parentUuid = parentOverride !== undefined ? parentOverride
      : (!isNew && state.messages.length ? state.messages[state.messages.length - 1].uuid : null);

    let humanMsg = null;
    if (!skipHumanBubble) {
      humanMsg = { uuid: 'pending-human', sender: 'human', html: renderMessageBlocks({ text: prompt }), _raw: prompt };
      state.messages.push(humanMsg);
      emitMessages();
    }

    const controller = new AbortController();
    state.abortController = controller;

    try {
      for await (const evt of sendCompletion({ convId, prompt, parentUuid, isNew, model: state.model, thinkingMode: state.thinkingMode, effort: state.effort, signal: controller.signal })) {
        if (evt.type === '__meta') {
          if (humanMsg) humanMsg.uuid = evt.human_message_uuid;
          const assistantMsg = { uuid: evt.assistant_message_uuid, sender: 'assistant', html: '', streaming: true };
          state.messages.push(assistantMsg);
          state.streamingUuid = assistantMsg.uuid;
          if (isNew) {
            state.convId = convId;
            history.replaceState(null, '', `/chat/${convId}`);
            state.conversations.unshift({ uuid: convId, name: prompt.slice(0, 60), updated_at: new Date().toISOString() });
            emitSidebar();
          }
          emitMessages();
        } else if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
          const m = state.messages.find(x => x.uuid === state.streamingUuid);
          if (m) { m._raw = (m._raw || '') + evt.delta.text; m.html = renderMessageBlocks({ text: m._raw }); emitMessages(); }
        } else if (evt.type === 'message_limit' && evt.message_limit) {
          rateLimitCache = { five_hour: evt.message_limit.windows && evt.message_limit.windows['5h'], seven_day: evt.message_limit.windows && evt.message_limit.windows['7d'] };
          renderStatsOnly();
        } else if (evt.type === 'message_stop') {
          const m = state.messages.find(x => x.uuid === state.streamingUuid);
          if (m) m.streaming = false;
          state.streamingUuid = null;
          emitMessages();
        }
      }
    } catch (e) {
      const m = state.messages.find(x => x.uuid === state.streamingUuid);
      if (e.name === 'AbortError') {
        // User hit Stop — leave whatever text streamed in so far, just end the "streaming" state.
        if (m) m.streaming = false;
      } else {
        console.warn('[claude-vsux] send failed', e);
        // If the request failed before the __meta event (e.g. a 400 from the API), no assistant
        // bubble exists yet to attach the error to — fall back to appending one so it's never silent.
        if (m) { m.html += `<div class="cs-msg-error">Error: ${escapeHtml(e.message)}</div>`; m.streaming = false; }
        else { state.messages.push({ uuid: 'error-' + Date.now(), sender: 'assistant', html: `<div class="cs-msg-error">Error: ${escapeHtml(e.message)}</div>` }); }
      }
      emitMessages();
    } finally {
      state.sending = false;
      state.streamingUuid = null;
      state.abortController = null;
      emitMessages();
      if (state.convId) getConversation(state.convId).then(conv => conv && indexForStats(conv));
    }
  }
  function stopSending() { if (state.abortController) state.abortController.abort(); }
  function retryLast() {
    if (state.sending) return;
    // Find the last human message and resend it, parented on whatever came before it — this asks
    // again rather than truly replacing the branch, which needs no extra parent bookkeeping.
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].sender === 'human') {
        sendPrompt(state.messages[i]._raw || '', { skipHumanBubble: false });
        return;
      }
    }
  }

  async function refreshSidebar() {
    state.conversations = await listConversations(0, 100);
    emitSidebar();
  }
  async function deleteConversation(convId) {
    const orgId = await getOrgId();
    const res = await fetch(`/api/organizations/${orgId}/chat_conversations/${convId}`, { method: 'DELETE' });
    if (!res.ok) { console.warn('[claude-vsux] delete failed', res.status); return false; }
    state.conversations = state.conversations.filter(c => c.uuid !== convId);
    if (state.convId === convId) { state.convId = null; state.messages = []; history.pushState(null, '', '/new'); emitMessages(); }
    emitSidebar();
    return true;
  }

  // ================= Stats aggregation (unchanged approach: derived from the same read API) =================
  function estimateTokens(text) { return text ? Math.ceil(text.length / 4) : 0; }
  function messageText(msg) {
    if (msg.text) return msg.text;
    return (msg.content || []).filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n');
  }
  function urlParts(url) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      const parts = hostname.split('.');
      const tld = parts.length > 1 ? parts[parts.length - 1] : '';
      return { outlet: hostname, tld };
    } catch (e) { return { outlet: null, tld: null }; }
  }
  function fileExt(name) {
    if (!name) return 'file';
    const base = name.split('/').pop().split('?')[0];
    const m = base.match(/\.([a-zA-Z0-9]+)$/);
    return m ? m[1].toLowerCase() : 'file';
  }
  function summarizeConversation(json) {
    const summary = { uuid: json.uuid, name: json.name || '(untitled)', updated_at: json.updated_at, turnCount: 0, toolCounts: {}, sources: [], files: [], estTokensIn: 0, estTokensOut: 0, responseTimesMs: [] };
    let lastHumanTs = null;
    for (const msg of json.chat_messages || []) {
      if (msg.sender === 'human') {
        summary.turnCount++;
        summary.estTokensIn += estimateTokens(messageText(msg));
        lastHumanTs = msg.created_at;
        const uploads = [...(msg.attachments || []), ...(msg.files || [])];
        for (const att of uploads) { if (!att) continue; const name = attachmentName(att); summary.files.push({ path: name, title: name, ts: att.created_at || msg.created_at, source: 'user' }); }
      } else if (msg.sender === 'assistant') {
        summary.estTokensOut += estimateTokens(messageText(msg));
        if (lastHumanTs) { const dt = new Date(msg.created_at) - new Date(lastHumanTs); if (dt > 0 && dt < MAX_RESPONSE_GAP_MS) summary.responseTimesMs.push(dt); lastHumanTs = null; }
        const filesByPath = new Map();
        for (const block of msg.content || []) {
          if (block.type === 'tool_use') {
            const name = block.name || 'unknown_tool';
            summary.toolCounts[name] = (summary.toolCounts[name] || 0) + 1;
            if (name === 'create_file' && block.input) { const path = block.input.path || block.input.file_path || ''; filesByPath.set(path, { path, title: block.input.description || path.split('/').pop(), ts: block.stop_timestamp || msg.created_at, source: 'claude' }); }
            else if (name === 'Artifact' && block.input) { const path = block.input.file_path || ''; filesByPath.set(path, { path, title: block.input.title || path.split('/').pop(), ts: block.stop_timestamp || msg.created_at, source: 'claude' }); }
          }
          if (block.type === 'tool_result' && Array.isArray(block.content)) {
            for (const item of block.content) { if (item && item.url && item.title) { const { outlet, tld } = urlParts(item.url); summary.sources.push({ title: item.title, url: item.url, outlet, tld, ts: block.stop_timestamp || msg.created_at }); } }
          }
        }
        summary.files.push(...filesByPath.values());
      }
    }
    return summary;
  }
  let aggCache = null;
  async function computeAggregate() {
    const convs = await idbGetAll('conversations');
    const agg = { convCount: convs.length, toolCounts: {}, domainCounts: {}, sources: [], files: [], responseTimesMs: [], estTokensIn: 0, estTokensOut: 0, turnCount: 0, tlds: new Set(), outlets: new Set(), filesByConv: new Map() };
    for (const c of convs) {
      agg.turnCount += c.turnCount || 0;
      agg.estTokensIn += c.estTokensIn || 0;
      agg.estTokensOut += c.estTokensOut || 0;
      agg.responseTimesMs.push(...(c.responseTimesMs || []));
      for (const [k, v] of Object.entries(c.toolCounts || {})) agg.toolCounts[k] = (agg.toolCounts[k] || 0) + v;
      for (const s of c.sources || []) { agg.sources.push({ ...s, conv: c.name, convUuid: c.uuid }); if (s.outlet) { agg.domainCounts[s.outlet] = (agg.domainCounts[s.outlet] || 0) + 1; agg.outlets.add(s.outlet); } if (s.tld) agg.tlds.add(s.tld); }
      for (const f of c.files || []) { const entry = { ...f, conv: c.name, convUuid: c.uuid }; agg.files.push(entry); if (!agg.filesByConv.has(c.uuid)) agg.filesByConv.set(c.uuid, { conv: c.name, convUuid: c.uuid, files: [] }); agg.filesByConv.get(c.uuid).files.push(entry); }
    }
    return agg;
  }
  async function refreshAggregate() { aggCache = await computeAggregate(); renderStatsOnly(); renderSourcesWindow(); renderFilesWindow(); }
  async function indexForStats(conv) {
    try {
      const existing = await idbGet('conversations', conv.uuid);
      if (existing && existing.updated_at === conv.updated_at) return;
      const summary = summarizeConversation(conv);
      await idbPut('conversations', summary);
      await refreshAggregate();
    } catch (e) { console.warn('[claude-vsux] stats index failed', e); }
  }
  let backfillRunning = false;
  let backfillProgress = { done: 0, total: 0 };
  async function backfillAll() {
    if (backfillRunning) return;
    backfillRunning = true;
    renderStatsOnly();
    try {
      const all = await listConversations(0, 500);
      backfillProgress = { done: 0, total: all.length };
      for (const conv of all) {
        if (!backfillRunning) break;
        const existing = await idbGet('conversations', conv.uuid);
        if (!existing || existing.updated_at !== conv.updated_at) {
          const full = await getConversation(conv.uuid);
          if (full) await indexForStats(full);
        }
        backfillProgress.done++;
        if (backfillProgress.done % 3 === 0) renderStatsOnly();
        await wait(300);
      }
    } finally { backfillRunning = false; renderStatsOnly(); }
  }

  // Session/activity timer
  const activityState = { lastActivity: Date.now() };
  ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'].forEach(evt => document.addEventListener(evt, () => { activityState.lastActivity = Date.now(); }, { passive: true }));
  function todayKey() { return new Date().toISOString().slice(0, 10); }
  let currentDay = todayKey(), todayActiveMs = 0, allTimeActiveMs = 0;
  async function initActivity() {
    const rec = await idbGet('activity', currentDay);
    todayActiveMs = rec ? rec.activeMs : 0;
    const all = await idbGetAll('activity');
    allTimeActiveMs = all.reduce((s, r) => s + r.activeMs, 0);
  }
  const IDLE_MS = 60000, TICK_MS = 1000;
  async function tick() {
    const day = todayKey();
    if (day !== currentDay) { currentDay = day; todayActiveMs = 0; }
    const idle = Date.now() - activityState.lastActivity > IDLE_MS;
    if (!idle) { todayActiveMs += TICK_MS; allTimeActiveMs += TICK_MS; await idbPut('activity', { day: currentDay, activeMs: todayActiveMs }); }
    set('cs-active-today', formatDuration(todayActiveMs));
    set('cs-active-total', formatDuration(allTimeActiveMs));
    set('cs-idle-status', idle ? 'idle' : 'active');
  }

  let rateLimitCache = null;
  function renderStatsOnly() {
    const agg = aggCache || { toolCounts: {}, estTokensIn: 0, estTokensOut: 0, turnCount: 0, convCount: 0, responseTimesMs: [] };
    set('cs-turns-total', agg.turnCount);
    set('cs-avg-total', agg.responseTimesMs.length ? formatDuration(avg(agg.responseTimesMs)) : '–');
    if (rateLimitCache) {
      const fh = rateLimitCache.five_hour, sd = rateLimitCache.seven_day;
      set('cs-rl-session', fh ? `${Math.round((fh.utilization || 0) * 100) / 100}%` : '–');
      set('cs-rl-weekly', sd ? `${Math.round((sd.utilization || 0) * 100) / 100}%` : '–');
    }
    set('cs-tokens', `~${agg.estTokensIn.toLocaleString()} in / ~${agg.estTokensOut.toLocaleString()} out`);
    set('cs-conv-count', agg.convCount);
    const entries = Object.entries(agg.toolCounts).sort((a, b) => b[1] - a[1]);
    set('cs-tools-count', entries.reduce((s, [, v]) => s + v, 0));
    const toolsEl = document.getElementById('cs-tools');
    if (toolsEl) toolsEl.innerHTML = entries.map(([name, count]) => `<div class="cs-row"><span>${escapeHtml(name)}</span><b>${count}</b></div>`).join('') || '<div class="cs-empty">No tool calls indexed yet.</div>';
    const btn = document.getElementById('cs-backfill');
    const status = document.getElementById('cs-backfill-status');
    if (btn && status) {
      if (backfillRunning) { btn.textContent = 'Cancel indexing'; status.textContent = `Indexing… ${backfillProgress.done} / ${backfillProgress.total}`; }
      else { btn.textContent = 'Index full history'; status.textContent = backfillProgress.total ? `Last run: ${backfillProgress.done} / ${backfillProgress.total} indexed` : 'Not run yet — pulls every past conversation once.'; }
    }
  }
  function applySourceFilter() {
    const container = document.getElementById('cs-src-list');
    if (!container || !aggCache) return;
    const tldEl = document.getElementById('cs-src-tld');
    const outletEl = document.getElementById('cs-src-outlet');
    const tld = tldEl ? tldEl.value : '';
    const outletQ = (outletEl ? outletEl.value : '').toLowerCase();
    const list = aggCache.sources.filter(s => (!tld || s.tld === tld) && (!outletQ || (s.outlet || '').toLowerCase().includes(outletQ)))
      .sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 500);
    container.innerHTML = list.map(s => `<div class="cs-source-row"><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a><div class="cs-file-meta">${escapeHtml(s.outlet || '')}${s.tld ? ' · .' + escapeHtml(s.tld) : ''} · ${new Date(s.ts).toLocaleString()} · ${escapeHtml(s.conv || '')}</div></div>`).join('') || '<div class="cs-empty">No web sources match these filters.</div>';
  }
  function renderSourcesWindow() {
    if (!aggCache) return;
    const tldSelect = document.getElementById('cs-src-tld');
    if (tldSelect) { const current = tldSelect.value; const tlds = Array.from(aggCache.tlds).sort(); tldSelect.innerHTML = '<option value="">All TLDs</option>' + tlds.map(t => `<option value="${escapeHtml(t)}">.${escapeHtml(t)}</option>`).join(''); tldSelect.value = tlds.includes(current) ? current : ''; }
    applySourceFilter();
    const entries = Object.entries(aggCache.domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 30);
    set('cs-domains-count', Object.keys(aggCache.domainCounts).length);
    const domEl = document.getElementById('cs-domains');
    if (domEl) domEl.innerHTML = entries.map(([d, c]) => `<div class="cs-row"><span>${escapeHtml(d)}</span><b>${c}</b></div>`).join('') || '<div class="cs-empty">No sources yet.</div>';
  }
  const filesNav = { folder: null };
  const filesSort = { key: 'date', dir: -1 };
  function renderFilesFolders() {
    const breadcrumb = document.getElementById('cs-files-breadcrumb'), folderEl = document.getElementById('cs-files-folders'), tableWrap = document.getElementById('cs-files-table-wrap');
    if (!breadcrumb || !folderEl || !tableWrap || !aggCache) return;
    breadcrumb.innerHTML = '<span>All folders</span>';
    folderEl.style.display = ''; tableWrap.style.display = 'none';
    const folders = Array.from(aggCache.filesByConv.values()).sort((a, b) => Math.max(...b.files.map(f => new Date(f.ts).getTime())) - Math.max(...a.files.map(f => new Date(f.ts).getTime())));
    folderEl.innerHTML = folders.map(f => `<div class="cs-folder" data-conv="${f.convUuid}" title="${escapeHtml(f.conv)}"><div class="cs-folder-icon">📁</div><div class="cs-folder-name">${escapeHtml(f.conv)}</div><div class="cs-folder-count">${f.files.length} file${f.files.length === 1 ? '' : 's'}</div></div>`).join('') || '<div class="cs-empty">No files or attachments indexed yet.</div>';
    folderEl.querySelectorAll('.cs-folder').forEach(el => { el.addEventListener('dblclick', () => { filesNav.folder = el.dataset.conv; renderFilesWindow(); }); });
  }
  function renderFilesTable() {
    const breadcrumb = document.getElementById('cs-files-breadcrumb'), folderEl = document.getElementById('cs-files-folders'), tableWrap = document.getElementById('cs-files-table-wrap'), tbody = document.getElementById('cs-files-tbody');
    if (!breadcrumb || !folderEl || !tableWrap || !tbody || !aggCache) return;
    const folderData = aggCache.filesByConv.get(filesNav.folder);
    folderEl.style.display = 'none'; tableWrap.style.display = '';
    breadcrumb.innerHTML = `<span class="cs-breadcrumb-link" id="cs-files-back">← All folders</span> / ${escapeHtml(folderData ? folderData.conv : '')}`;
    const backLink = document.getElementById('cs-files-back');
    if (backLink) backLink.addEventListener('click', () => { filesNav.folder = null; renderFilesWindow(); });
    const files = folderData ? folderData.files.map(f => ({ ...f, _ext: fileExt(f.title || f.path) })) : [];
    files.sort((a, b) => { let av, bv; if (filesSort.key === 'name') { av = (a.title || '').toLowerCase(); bv = (b.title || '').toLowerCase(); } else if (filesSort.key === 'type') { av = a._ext; bv = b._ext; } else if (filesSort.key === 'source') { av = a.source || ''; bv = b.source || ''; } else { av = new Date(a.ts).getTime(); bv = new Date(b.ts).getTime(); } if (av < bv) return -1 * filesSort.dir; if (av > bv) return 1 * filesSort.dir; return 0; });
    tbody.innerHTML = files.map(f => `<tr><td>${escapeHtml(f.title || '(file)')}</td><td>${escapeHtml(f._ext)}</td><td>${new Date(f.ts).toLocaleString()}</td><td>${f.source === 'user' ? 'User' : 'Claude'}</td></tr>`).join('') || '<tr><td colspan="4" class="cs-empty">No files here.</td></tr>';
  }
  function renderFilesWindow() { if (!aggCache) return; if (filesNav.folder && aggCache.filesByConv.has(filesNav.folder)) renderFilesTable(); else { filesNav.folder = null; renderFilesFolders(); } }

  // ================= Panel bodies =================
  function buildEl(bodyHtml) { const el = document.createElement('div'); el.className = 'cs-panel-body'; el.innerHTML = bodyHtml; return el; }

  function buildSidebarPanel() {
    const el = buildEl(`
      <button id="cs-new-chat" class="cs-primary-btn">+ New chat</button>
      <input id="cs-conv-search" type="text" placeholder="Search chats…" class="cs-search-input" />
      <div id="cs-conv-list" class="cs-scroll cs-grow"></div>
    `);
    let query = '';
    el.querySelector('#cs-new-chat').addEventListener('click', () => {
      history.pushState(null, '', '/new');
      startNewConversation();
    });
    el.querySelector('#cs-conv-search').addEventListener('input', (e) => { query = e.target.value.toLowerCase(); render(); });
    function render() {
      const list = el.querySelector('#cs-conv-list');
      const filtered = query ? state.conversations.filter(c => (c.name || '').toLowerCase().includes(query)) : state.conversations;
      list.innerHTML = filtered.map(c => `
        <div class="cs-conv-row ${c.uuid === state.convId ? 'active' : ''}" data-id="${c.uuid}">
          <div class="cs-conv-main">
            <div class="cs-conv-name">${escapeHtml(c.name || '(untitled)')}</div>
            <div class="cs-conv-date">${c.updated_at ? new Date(c.updated_at).toLocaleDateString() : ''}</div>
          </div>
          <button class="cs-conv-delete" title="Delete chat" data-id="${c.uuid}">🗑</button>
        </div>`).join('') || `<div class="cs-empty">${query ? 'No chats match your search.' : 'No conversations yet.'}</div>`;
      list.querySelectorAll('.cs-conv-row .cs-conv-main').forEach(row => {
        row.addEventListener('click', () => {
          const id = row.closest('.cs-conv-row').dataset.id;
          history.pushState(null, '', `/chat/${id}`);
          loadConversation(id);
        });
      });
      list.querySelectorAll('.cs-conv-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          const row = btn.closest('.cs-conv-row');
          if (row) row.style.opacity = '0.4';
          await deleteConversation(id);
        });
      });
    }
    onSidebarChange(render);
    onMessagesChange(render); // active-row highlight follows state.convId
    render();
    return el;
  }

  function buildMessagesPanel() {
    const el = buildEl(`<div id="cs-msg-list" class="cs-scroll cs-grow cs-messages"></div>`);
    function render() {
      const list = el.querySelector('#cs-msg-list');
      const wasAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      const lastAssistantIdx = state.messages.map(m => m.sender).lastIndexOf('assistant');
      list.innerHTML = state.messages.map((m, i) => `
        <div class="cs-bubble cs-bubble-${m.sender}">
          <div class="cs-bubble-role">${m.sender === 'human' ? 'You' : 'Claude'}</div>
          <div class="cs-bubble-body">${m.html}${m.streaming ? '<span class="cs-cursor">▍</span>' : ''}</div>
          ${!m.streaming ? `<div class="cs-bubble-actions">
            <button class="cs-bubble-action cs-copy-btn" data-idx="${i}" title="Copy">📋</button>
            ${m.sender === 'assistant' && i === lastAssistantIdx && !state.sending ? `<button class="cs-bubble-action cs-retry-btn" title="Retry">🔁 Retry</button>` : ''}
          </div>` : ''}
        </div>`).join('') || '<div class="cs-empty" style="padding:24px;">Start a conversation using the composer.</div>';
      if (wasAtBottom) list.scrollTop = list.scrollHeight;
      list.querySelectorAll('.cs-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const m = state.messages[Number(btn.dataset.idx)];
          const text = m._raw || m.html.replace(/<[^>]+>/g, '');
          navigator.clipboard.writeText(text).catch(() => {});
          btn.textContent = '✓'; setTimeout(() => { btn.textContent = '📋'; }, 1000);
        });
      });
      list.querySelectorAll('.cs-retry-btn').forEach(btn => { btn.addEventListener('click', () => retryLast()); });
    }
    onMessagesChange(render);
    render();
    return el;
  }

  function buildComposerPanel() {
    const el = buildEl(`
      <div class="cs-composer-opts">
        <select id="cs-model-select">${MODELS.map(m => `<option value="${m.id}" ${m.id === state.model ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}</select>
        <select id="cs-effort-select">
          <option value="low" ${state.effort === 'low' ? 'selected' : ''}>Low effort</option>
          <option value="medium" ${state.effort === 'medium' ? 'selected' : ''}>Medium effort</option>
          <option value="high" ${state.effort === 'high' ? 'selected' : ''}>High effort</option>
        </select>
        <label class="cs-thinking-toggle"><input type="checkbox" id="cs-thinking-toggle" ${state.thinkingMode === 'extended' ? 'checked' : ''}/> Extended thinking</label>
      </div>
      <textarea id="cs-composer-input" placeholder="Message Claude…" rows="3"></textarea>
      <button id="cs-composer-send" class="cs-primary-btn">Send</button>
    `);
    const input = el.querySelector('#cs-composer-input');
    const btn = el.querySelector('#cs-composer-send');
    el.querySelector('#cs-model-select').addEventListener('change', (e) => { state.model = e.target.value; localStorage.setItem('cs_model', state.model); });
    el.querySelector('#cs-effort-select').addEventListener('change', (e) => { state.effort = e.target.value; localStorage.setItem('cs_effort', state.effort); });
    el.querySelector('#cs-thinking-toggle').addEventListener('change', (e) => { state.thinkingMode = e.target.checked ? 'extended' : 'off'; localStorage.setItem('cs_thinking_mode', state.thinkingMode); });
    function doSend() {
      const text = input.value;
      if (!text.trim() || state.sending) return;
      input.value = '';
      sendPrompt(text);
    }
    btn.addEventListener('click', () => { if (state.sending) stopSending(); else doSend(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    function render() { btn.textContent = state.sending ? 'Stop' : 'Send'; btn.classList.toggle('cs-stop-btn', state.sending); }
    onMessagesChange(render);
    render();
    return el;
  }

  const statsBodyHtml = `
    <div class="cs-section"><div class="cs-row"><span>Active today</span><b id="cs-active-today">0s</b></div><div class="cs-row"><span>Active all-time</span><b id="cs-active-total">0s</b></div><div class="cs-row"><span>Status</span><b id="cs-idle-status">active</b></div></div>
    <div class="cs-section"><div class="cs-row"><span>Turns (all chats)</span><b id="cs-turns-total">0</b></div><div class="cs-row"><span>Avg response time</span><b id="cs-avg-total">–</b></div></div>
    <div class="cs-section"><div class="cs-row"><span>Session limit (5h)</span><b id="cs-rl-session">–</b></div><div class="cs-row"><span>Weekly limit</span><b id="cs-rl-weekly">–</b></div></div>
    <div class="cs-section"><div class="cs-row"><span>Est. tokens in / out</span><b id="cs-tokens">–</b></div><div class="cs-hint">Estimated from text length — claude.ai doesn't expose real token counts.</div></div>
    <details class="cs-section" open><summary>Tool calls (<span id="cs-tools-count">0</span>)</summary><div id="cs-tools" class="cs-scroll"></div></details>
    <div class="cs-section"><button id="cs-backfill">Index full history</button><div id="cs-backfill-status" class="cs-hint"></div><div class="cs-row" style="margin-top:6px;"><span>Conversations indexed</span><b id="cs-conv-count">0</b></div></div>
  `;
  const sourcesBodyHtml = `
    <div class="cs-filters"><select id="cs-src-tld"><option value="">All TLDs</option></select><input id="cs-src-outlet" type="text" placeholder="Outlet contains…" /></div>
    <div id="cs-src-list" class="cs-scroll cs-grow"></div>
    <details class="cs-section"><summary>Top outlets (<span id="cs-domains-count">0</span>)</summary><div id="cs-domains" class="cs-scroll"></div></details>
  `;
  const filesBodyHtml = `
    <div id="cs-files-breadcrumb" class="cs-breadcrumb"></div>
    <div id="cs-files-folders" class="cs-scroll cs-grow cs-folder-grid"></div>
    <div id="cs-files-table-wrap" class="cs-scroll cs-grow" style="display:none;"><table id="cs-files-table"><thead><tr><th data-sort="name">Name</th><th data-sort="type">Type</th><th data-sort="date">Date</th><th data-sort="source">Source</th></tr></thead><tbody id="cs-files-tbody"></tbody></table></div>
  `;
  function buildStatsPanel() {
    const el = buildEl(statsBodyHtml);
    el.querySelector('#cs-backfill').addEventListener('click', () => { if (backfillRunning) { backfillRunning = false; return; } backfillAll(); });
    return el;
  }
  function buildSourcesPanel() {
    const el = buildEl(sourcesBodyHtml);
    ['cs-src-tld', 'cs-src-outlet'].forEach(id => { const e = el.querySelector('#' + id); if (e) { e.addEventListener('input', applySourceFilter); e.addEventListener('change', applySourceFilter); } });
    return el;
  }
  function buildFilesPanel() {
    const el = buildEl(filesBodyHtml);
    el.querySelectorAll('#cs-files-table thead th').forEach(th => {
      th.addEventListener('click', () => { const key = th.dataset.sort; if (filesSort.key === key) filesSort.dir *= -1; else { filesSort.key = key; filesSort.dir = 1; } renderFilesTable(); });
    });
    return el;
  }

  // ================= Panel registry (ALL custom — nothing here ever touches native DOM) =================
  const panels = {
    sidebar: { title: 'Chats', el: null, build: buildSidebarPanel },
    messages: { title: 'Chat', el: null, build: buildMessagesPanel },
    composer: { title: 'Message', el: null, build: buildComposerPanel },
    stats: { title: 'Stats', el: null, build: buildStatsPanel },
    sources: { title: 'Web Sources', el: null, build: buildSourcesPanel },
    files: { title: 'Files', el: null, build: buildFilesPanel },
  };

  // ================= Dock tree (pure data model driving our own panels' pixel rects) =================
  let leafIdCounter = 0;
  function newLeafId() { return 'leaf-' + (++leafIdCounter) + '-' + Date.now().toString(36); }
  // All six panels visible by default — stats/sources/files were never removed from the code,
  // but hiding them behind the tiny "+" tab menu made them look deleted. They're tabbed together
  // on the right so nothing is buried; drag any tab out to give it its own zone.
  function defaultDockTree() {
    return {
      type: 'split', dir: 'row', sizes: [0.18, 0.62, 0.2],
      children: [
        { type: 'leaf', id: 'leaf-sidebar', tabs: ['sidebar'], active: 'sidebar' },
        {
          type: 'split', dir: 'column', sizes: [0.78, 0.22],
          children: [
            { type: 'leaf', id: 'leaf-messages', tabs: ['messages'], active: 'messages' },
            { type: 'leaf', id: 'leaf-composer', tabs: ['composer'], active: 'composer' },
          ],
        },
        { type: 'leaf', id: 'leaf-extras', tabs: ['stats', 'sources', 'files'], active: 'stats' },
      ],
    };
  }
  let dockTree = null;
  function loadDockTree() { try { const raw = localStorage.getItem('cs_dock_tree_v2'); if (raw) return JSON.parse(raw); } catch (e) {} return defaultDockTree(); }
  function saveDockTree() { try { localStorage.setItem('cs_dock_tree_v2', JSON.stringify(dockTree)); } catch (e) {} }
  function findLeafById(node, id) { if (node.type === 'leaf') return node.id === id ? node : null; for (const c of node.children) { const r = findLeafById(c, id); if (r) return r; } return null; }
  function findLeafParent(node, id, parent) { if (node.type === 'leaf') return node.id === id ? parent : null; for (const c of node.children) { const r = findLeafParent(c, id, node); if (r) return r; } return null; }
  function findPanelLeaf(node, panelId) { if (node.type === 'leaf') return node.tabs.includes(panelId) ? node : null; for (const c of node.children) { const r = findPanelLeaf(c, panelId); if (r) return r; } return null; }
  function findFirstLeaf(node) { if (node.type === 'leaf') return node; return findFirstLeaf(node.children[0]); }
  function collapseSingleChildSplits(node) { if (node.type !== 'split') return node; node.children = node.children.map(collapseSingleChildSplits); if (node.children.length === 1) return node.children[0]; return node; }
  function removePanelFromTree(root, panelId) {
    const leaf = findPanelLeaf(root, panelId);
    if (!leaf) return root;
    leaf.tabs = leaf.tabs.filter(t => t !== panelId);
    if (leaf.active === panelId) leaf.active = leaf.tabs[0] || null;
    if (leaf.tabs.length === 0 && root.type === 'split') {
      function recurse(node) {
        if (node.type !== 'split') return node;
        const newChildren = [], newSizes = [];
        for (let i = 0; i < node.children.length; i++) { const c = node.children[i]; if (c.type === 'leaf' && c.id === leaf.id) continue; newChildren.push(recurse(c)); newSizes.push(node.sizes[i]); }
        node.children = newChildren;
        const sum = newSizes.reduce((a, b) => a + b, 0) || 1;
        node.sizes = newSizes.map(s => s / sum);
        return node;
      }
      root = recurse(root);
      root = collapseSingleChildSplits(root);
    }
    return root;
  }
  function dockPanel(root, panelId, targetLeafId, region) {
    root = removePanelFromTree(root, panelId);
    let targetLeaf = findLeafById(root, targetLeafId);
    if (!targetLeaf) { targetLeaf = findFirstLeaf(root); region = 'center'; }
    if (region === 'center') { if (!targetLeaf.tabs.includes(panelId)) targetLeaf.tabs.push(panelId); targetLeaf.active = panelId; return root; }
    const newLeaf = { type: 'leaf', id: newLeafId(), tabs: [panelId], active: panelId };
    const dir = (region === 'left' || region === 'right') ? 'row' : 'column';
    const newSplit = { type: 'split', dir, sizes: [0.5, 0.5], children: (region === 'left' || region === 'top') ? [newLeaf, targetLeaf] : [targetLeaf, newLeaf] };
    if (targetLeaf === root) return newSplit;
    const parent = findLeafParent(root, targetLeaf.id, null);
    const idx = parent.children.indexOf(targetLeaf);
    parent.children[idx] = newSplit;
    return root;
  }
  function dockPanelAtRoot(root, panelId, edge) {
    root = removePanelFromTree(root, panelId);
    const newLeaf = { type: 'leaf', id: newLeafId(), tabs: [panelId], active: panelId };
    const dir = (edge === 'left' || edge === 'right') ? 'row' : 'column';
    const isFirst = (edge === 'left' || edge === 'top');
    return { type: 'split', dir, sizes: isFirst ? [0.25, 0.75] : [0.75, 0.25], children: isFirst ? [newLeaf, root] : [root, newLeaf] };
  }

  function computeRects(node, rect, out) {
    if (node.type === 'leaf') { out.set(node.id, rect); return; }
    if (node.dir === 'row') { let x = rect.x; node.children.forEach((child, i) => { const w = rect.w * node.sizes[i]; computeRects(child, { x, y: rect.y, w, h: rect.h }, out); x += w; }); }
    else { let y = rect.y; node.children.forEach((child, i) => { const h = rect.h * node.sizes[i]; computeRects(child, { x: rect.x, y, w: rect.w, h }, out); y += h; }); }
  }
  let chromeEl = null;
  const leafRects = new Map();
  function layoutDock() {
    const viewportW = window.innerWidth, viewportH = window.innerHeight - TOOLBAR_H;
    const rootRect = { x: 0, y: TOOLBAR_H, w: viewportW, h: viewportH };
    leafRects.clear();
    computeRects(dockTree, rootRect, leafRects);
    const shown = new Set();
    chromeEl.innerHTML = '';
    for (const [leafId, rect] of leafRects) {
      const leaf = findLeafById(dockTree, leafId);
      if (!leaf) continue;
      renderLeafChrome(leaf, rect);
      const contentRect = { x: rect.x, y: rect.y + TABSTRIP_H, w: rect.w, h: rect.h - TABSTRIP_H };
      if (leaf.active) { applyPanelRect(leaf.active, contentRect); shown.add(leaf.active); }
    }
    for (const id of Object.keys(panels)) { if (!shown.has(id) && panels[id].el) panels[id].el.style.visibility = 'hidden'; }
    renderSplitResizers();
    saveDockTree();
  }
  function applyPanelRect(panelId, rect) {
    const p = panels[panelId];
    if (!p) return;
    if (!p.el) { p.el = p.build(); p.el.style.position = 'fixed'; document.body.appendChild(p.el); }
    const el = p.el;
    el.style.top = rect.y + 'px'; el.style.left = rect.x + 'px'; el.style.width = rect.w + 'px'; el.style.height = rect.h + 'px';
    el.style.zIndex = '2147480500'; el.style.visibility = 'visible';
  }
  function renderLeafChrome(leaf, rect) {
    const frame = document.createElement('div');
    frame.className = 'cs-frame';
    frame.style.left = rect.x + 'px'; frame.style.top = rect.y + 'px'; frame.style.width = rect.w + 'px'; frame.style.height = rect.h + 'px';
    chromeEl.appendChild(frame);
    const strip = document.createElement('div');
    strip.className = 'cs-tabstrip';
    strip.style.left = rect.x + 'px'; strip.style.top = rect.y + 'px'; strip.style.width = rect.w + 'px'; strip.style.height = TABSTRIP_H + 'px';
    leaf.tabs.forEach(panelId => {
      const tabEl = document.createElement('div');
      tabEl.className = 'cs-tab' + (panelId === leaf.active ? ' cs-tab-active' : '');
      tabEl.textContent = panels[panelId] ? panels[panelId].title : panelId;
      tabEl.addEventListener('mousedown', (e) => { if (e.button === 0) startTabDrag(e, panelId, leaf.id); });
      tabEl.addEventListener('click', () => { leaf.active = panelId; layoutDock(); });
      strip.appendChild(tabEl);
    });
    const addBtn = document.createElement('div');
    addBtn.className = 'cs-tab-add'; addBtn.textContent = '+'; addBtn.title = 'Add panel to this zone';
    addBtn.addEventListener('click', (e) => showAddPanelMenu(e, leaf.id));
    strip.appendChild(addBtn);
    chromeEl.appendChild(strip);
  }
  function renderSplitResizers() {
    (function walk(node, rect) {
      if (node.type === 'leaf') return;
      if (node.dir === 'row') {
        let x = rect.x;
        node.children.forEach((child, i) => {
          const w = rect.w * node.sizes[i];
          if (i < node.children.length - 1) { const r = document.createElement('div'); r.className = 'cs-resizer cs-resizer-row'; r.style.left = (x + w - 3) + 'px'; r.style.top = rect.y + 'px'; r.style.width = '6px'; r.style.height = rect.h + 'px'; wireResizer(r, node, i, rect, 'row'); chromeEl.appendChild(r); }
          walk(child, { x, y: rect.y, w, h: rect.h }); x += w;
        });
      } else {
        let y = rect.y;
        node.children.forEach((child, i) => {
          const h = rect.h * node.sizes[i];
          if (i < node.children.length - 1) { const r = document.createElement('div'); r.className = 'cs-resizer cs-resizer-column'; r.style.left = rect.x + 'px'; r.style.top = (y + h - 3) + 'px'; r.style.width = rect.w + 'px'; r.style.height = '6px'; wireResizer(r, node, i, rect, 'column'); chromeEl.appendChild(r); }
          walk(child, { x: rect.x, y, w: rect.w, h }); y += h;
        });
      }
    })(dockTree, { x: 0, y: TOOLBAR_H, w: window.innerWidth, h: window.innerHeight - TOOLBAR_H });
  }
  function wireResizer(resizer, splitNode, i, containerRect, dir) {
    let dragging = false, startPos = 0, startSizes = null;
    const containerSize = dir === 'row' ? containerRect.w : containerRect.h;
    resizer.addEventListener('mousedown', (e) => { dragging = true; startPos = dir === 'row' ? e.clientX : e.clientY; startSizes = [...splitNode.sizes]; e.preventDefault(); });
    function onMove(e) {
      if (!dragging) return;
      const pos = dir === 'row' ? e.clientX : e.clientY;
      const delta = (pos - startPos) / containerSize;
      const pairSum = startSizes[i] + startSizes[i + 1];
      let a = Math.max(0.08, startSizes[i] + delta);
      a = Math.min(a, pairSum - 0.08);
      splitNode.sizes[i] = a; splitNode.sizes[i + 1] = pairSum - a;
      layoutDock();
    }
    function onUp() { if (dragging) { dragging = false; saveDockTree(); } }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  function showAddPanelMenu(e, leafId) {
    document.querySelectorAll('.cs-add-menu').forEach(m => m.remove());
    const available = Object.keys(panels).filter(id => !findPanelLeaf(dockTree, id));
    if (available.length === 0) return;
    const menu = document.createElement('div');
    menu.className = 'cs-add-menu';
    menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px';
    menu.innerHTML = available.map(id => `<div class="cs-add-menu-item" data-id="${id}">${escapeHtml(panels[id].title)}</div>`).join('');
    document.body.appendChild(menu);
    menu.querySelectorAll('.cs-add-menu-item').forEach(item => { item.addEventListener('click', () => { dockTree = dockPanel(dockTree, item.dataset.id, leafId, 'center'); layoutDock(); menu.remove(); }); });
    setTimeout(() => { document.addEventListener('mousedown', function onDoc(ev) { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', onDoc); } }); }, 0);
  }
  function startTabDrag(e, panelId, sourceLeafId) {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    const ghost = document.createElement('div');
    ghost.className = 'cs-drag-ghost'; ghost.textContent = panels[panelId] ? panels[panelId].title : panelId; ghost.style.display = 'none';
    document.body.appendChild(ghost);
    const overlay = document.createElement('div');
    overlay.className = 'cs-drop-overlay'; overlay.style.display = 'none';
    document.body.appendChild(overlay);
    let targetLeafId = null, region = null, targetOuterEdge = null;
    const OUTER_EDGE_MARGIN = 32;
    function onMove(ev) {
      if (!dragging) { if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return; dragging = true; ghost.style.display = 'block'; }
      ghost.style.left = (ev.clientX + 12) + 'px'; ghost.style.top = (ev.clientY + 12) + 'px';
      const dockX = 0, dockY = TOOLBAR_H, dockW = window.innerWidth, dockH = window.innerHeight - TOOLBAR_H;
      let outerEdge = null;
      if (ev.clientX - dockX < OUTER_EDGE_MARGIN) outerEdge = 'left';
      else if (dockX + dockW - ev.clientX < OUTER_EDGE_MARGIN) outerEdge = 'right';
      else if (ev.clientY - dockY < OUTER_EDGE_MARGIN) outerEdge = 'top';
      else if (dockY + dockH - ev.clientY < OUTER_EDGE_MARGIN) outerEdge = 'bottom';
      if (outerEdge) {
        targetOuterEdge = outerEdge; targetLeafId = null; region = null;
        overlay.style.display = 'block';
        let ox = dockX, oy = dockY, ow = dockW, oh = dockH;
        if (outerEdge === 'left') ow = Math.min(dockW * 0.25, 280);
        else if (outerEdge === 'right') { ow = Math.min(dockW * 0.25, 280); ox = dockX + dockW - ow; }
        else if (outerEdge === 'top') oh = Math.min(dockH * 0.25, 220);
        else if (outerEdge === 'bottom') { oh = Math.min(dockH * 0.25, 220); oy = dockY + dockH - oh; }
        overlay.style.left = ox + 'px'; overlay.style.top = oy + 'px'; overlay.style.width = ow + 'px'; overlay.style.height = oh + 'px';
        return;
      }
      targetOuterEdge = null;
      let found = null;
      for (const [leafId, r] of leafRects) { if (ev.clientX >= r.x && ev.clientX <= r.x + r.w && ev.clientY >= r.y && ev.clientY <= r.y + r.h) { found = { leafId, r }; break; } }
      if (!found) { overlay.style.display = 'none'; targetLeafId = null; return; }
      const { leafId, r } = found;
      const relX = (ev.clientX - r.x) / r.w, relY = (ev.clientY - r.y) / r.h, edge = 0.25;
      let reg = 'center';
      if (relY < edge) reg = 'top'; else if (relY > 1 - edge) reg = 'bottom'; else if (relX < edge) reg = 'left'; else if (relX > 1 - edge) reg = 'right';
      targetLeafId = leafId; region = reg;
      overlay.style.display = 'block';
      let ox = r.x, oy = r.y, ow = r.w, oh = r.h;
      if (reg === 'top') oh = r.h * 0.5; else if (reg === 'bottom') { oy = r.y + r.h * 0.5; oh = r.h * 0.5; } else if (reg === 'left') ow = r.w * 0.5; else if (reg === 'right') { ox = r.x + r.w * 0.5; ow = r.w * 0.5; }
      overlay.style.left = ox + 'px'; overlay.style.top = oy + 'px'; overlay.style.width = ow + 'px'; overlay.style.height = oh + 'px';
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      ghost.remove(); overlay.remove();
      if (dragging && targetOuterEdge) { dockTree = dockPanelAtRoot(dockTree, panelId, targetOuterEdge); layoutDock(); }
      else if (dragging && targetLeafId) { dockTree = dockPanel(dockTree, panelId, targetLeafId, region); layoutDock(); }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  window.addEventListener('resize', () => { if (dockTree) layoutDock(); });
  window.addEventListener('popstate', () => {
    const m = location.pathname.match(/\/chat\/([a-f0-9-]{36})/i);
    if (m) loadConversation(m[1]); else startNewConversation();
  });

  // ================= Styles =================
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* The ONLY thing this script does to claude.ai's own UI: hide its two top-level mount
         points in a single rule. Nothing inside them is ever queried, read, or touched again. */
      #root, #portal-root { display: none !important; }

      #cs-toolbar { position: fixed; top: 0; left: 0; right: 0; height: ${TOOLBAR_H}px; z-index: 2147483000; background: #1c1b1a; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; align-items: center; gap: 14px; padding: 0 10px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 12px; color: #ececec; }
      button.cs-tb-btn { background: #333; border: none; color: #ececec; padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; }
      button.cs-tb-btn:hover { background: #444; }
      .cs-slider-wrap { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .cs-slider-wrap input[type=range] { width: 100px; }
      #cs-chrome { position: fixed; inset: 0; pointer-events: none; z-index: 2147480000; }
      .cs-frame { position: fixed; background: #1a1918; border: 1px solid rgba(255,255,255,0.08); box-sizing: border-box; pointer-events: none; }
      .cs-tabstrip { position: fixed; display: flex; align-items: center; background: #1c1b1a; border-bottom: 1px solid rgba(255,255,255,0.08); overflow-x: auto; box-sizing: border-box; pointer-events: auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .cs-tab { padding: 5px 12px; font-size: 12px; color: #b8b6b3; cursor: pointer; white-space: nowrap; border-right: 1px solid rgba(255,255,255,0.05); user-select: none; }
      .cs-tab-active { color: #ececec; border-bottom: 2px solid #d97757; }
      .cs-tab-add { padding: 5px 10px; cursor: pointer; color: #8a8886; user-select: none; }
      .cs-tab-add:hover { color: #ececec; }
      .cs-resizer { position: fixed; background: transparent; pointer-events: auto; }
      .cs-resizer-row { cursor: col-resize; } .cs-resizer-column { cursor: row-resize; }
      .cs-resizer:hover { background: #d97757; }
      .cs-drag-ghost { position: fixed; z-index: 2147483647; background: #d97757; color: #fff; padding: 4px 10px; border-radius: 6px; font-size: 12px; pointer-events: none; }
      .cs-drop-overlay { position: fixed; z-index: 2147483646; background: rgba(217,119,87,0.35); border: 2px solid #d97757; pointer-events: none; box-sizing: border-box; }
      .cs-add-menu { position: fixed; z-index: 2147483001; background: #262523; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px; min-width: 140px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 12px; }
      .cs-add-menu-item { padding: 6px 10px; cursor: pointer; color: #ececec; border-radius: 4px; }
      .cs-add-menu-item:hover { background: #3a3937; }
      .cs-panel-body { position: fixed; box-sizing: border-box; padding: 10px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; color: #ececec; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; background: #1a1918; }
      .cs-section { padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
      .cs-section:last-child { border-bottom: none; }
      .cs-row { display: flex; justify-content: space-between; padding: 2px 0; gap: 8px; }
      .cs-row span { color: #b8b6b3; }
      .cs-hint { color: #8a8886; font-size: 11px; margin-top: 4px; }
      summary { cursor: pointer; padding: 4px 0; color: #ececec; }
      .cs-scroll { overflow-y: auto; } .cs-grow { flex: 1; min-height: 0; }
      .cs-empty { color: #8a8886; font-style: italic; padding: 6px 0; }
      .cs-source-row { padding: 6px 0; border-top: 1px solid rgba(255,255,255,0.05); }
      .cs-source-row:first-child { border-top: none; }
      .cs-source-row a { color: #d97757; text-decoration: none; }
      .cs-source-row a:hover { text-decoration: underline; }
      .cs-file-meta { color: #8a8886; font-size: 11px; margin-top: 2px; }
      #cs-backfill { width: 100%; padding: 7px; background: #d97757; border: none; border-radius: 6px; color: #fff; font-size: 13px; cursor: pointer; font-weight: 600; }
      .cs-filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; flex-shrink: 0; }
      .cs-filters select, .cs-filters input[type=text] { flex: 1; min-width: 100px; background: #1c1b1a; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; color: #ececec; padding: 5px 6px; font-size: 12px; }
      .cs-folder-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 10px; align-content: start; }
      .cs-folder { display: flex; flex-direction: column; align-items: center; text-align: center; cursor: pointer; padding: 8px 4px; border-radius: 8px; }
      .cs-folder:hover { background: rgba(255,255,255,0.06); }
      .cs-folder-icon { font-size: 28px; } .cs-folder-name { font-size: 11px; margin-top: 4px; word-break: break-word; } .cs-folder-count { font-size: 10px; color: #8a8886; }
      .cs-breadcrumb { font-size: 12px; color: #b8b6b3; margin-bottom: 6px; flex-shrink: 0; }
      .cs-breadcrumb-link { color: #d97757; cursor: pointer; }
      #cs-files-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      #cs-files-table th { text-align: left; cursor: pointer; padding: 4px 6px; color: #b8b6b3; border-bottom: 1px solid rgba(255,255,255,0.1); position: sticky; top: 0; background: #262523; }
      #cs-files-table td { padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.05); }

      /* Sidebar (custom conversation list) */
      .cs-primary-btn { padding: 8px; background: #d97757; border: none; border-radius: 6px; color: #fff; font-size: 13px; cursor: pointer; font-weight: 600; flex-shrink: 0; }
      .cs-primary-btn:disabled { opacity: 0.6; cursor: default; }
      .cs-search-input { flex-shrink: 0; background: #1c1b1a; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; color: #ececec; padding: 6px 8px; font-size: 12px; }
      .cs-conv-row { padding: 8px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 4px; }
      .cs-conv-row:hover { background: rgba(255,255,255,0.06); }
      .cs-conv-row:hover .cs-conv-delete { visibility: visible; }
      .cs-conv-row.active { background: rgba(217,119,87,0.18); }
      .cs-conv-main { flex: 1; min-width: 0; }
      .cs-conv-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .cs-conv-date { font-size: 11px; color: #8a8886; }
      .cs-conv-delete { visibility: hidden; background: none; border: none; cursor: pointer; font-size: 12px; padding: 4px; border-radius: 4px; flex-shrink: 0; }
      .cs-conv-delete:hover { background: rgba(255,255,255,0.1); }

      /* Messages (custom chat renderer) */
      .cs-messages { gap: 14px; }
      .cs-bubble { padding: 10px 12px; border-radius: 8px; max-width: 100%; }
      .cs-bubble-human { background: #2a2927; align-self: flex-end; }
      .cs-bubble-assistant { background: transparent; }
      .cs-bubble-role { font-size: 11px; color: #8a8886; margin-bottom: 4px; font-weight: 600; }
      .cs-bubble-body { font-size: var(--cs-msg-font-size, 14px); line-height: 1.5; word-wrap: break-word; }
      .cs-msg-text { white-space: normal; }
      .cs-msg-file { color: #b8b6b3; font-size: 12px; margin-bottom: 4px; }
      .cs-msg-tool { margin: 6px 0; background: #232221; border-radius: 6px; padding: 4px 8px; font-size: 12px; }
      .cs-msg-tool pre { white-space: pre-wrap; word-break: break-word; font-size: 11px; color: #b8b6b3; }
      .cs-msg-error { color: #e57373; margin-top: 6px; }
      .cs-code { background: #101010; padding: 8px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
      .cs-cursor { animation: cs-blink 1s step-start infinite; }
      @keyframes cs-blink { 50% { opacity: 0; } }
      .cs-bubble-actions { display: flex; gap: 8px; margin-top: 6px; }
      .cs-bubble-action { background: none; border: none; color: #8a8886; cursor: pointer; font-size: 11px; padding: 2px 6px; border-radius: 4px; }
      .cs-bubble-action:hover { background: rgba(255,255,255,0.08); color: #ececec; }

      /* Composer (custom input) */
      .cs-composer-opts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; flex-shrink: 0; }
      .cs-composer-opts select { background: #1c1b1a; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; color: #ececec; padding: 4px 6px; font-size: 12px; }
      .cs-thinking-toggle { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #b8b6b3; cursor: pointer; }
      #cs-composer-input { flex: 1; resize: none; background: #1c1b1a; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; color: #ececec; padding: 8px; font-size: 14px; font-family: inherit; }
      #cs-composer-send { flex-shrink: 0; }
      #cs-composer-send.cs-stop-btn { background: #444; }
    `;
    document.head.appendChild(style);
  }

  // ================= Toolbar =================
  // Font size for our own message bubbles. Since we render the text ourselves (no native element,
  // no zoom/position hacks needed) this is just a CSS custom property read by .cs-bubble-body.
  let msgFontSize = parseFloat(localStorage.getItem('cs_msg_font_size')) || 14;
  function applyMsgFontSize() { document.documentElement.style.setProperty('--cs-msg-font-size', msgFontSize + 'px'); }

  function buildToolbar() {
    const bar = document.createElement('div');
    bar.id = 'cs-toolbar';
    bar.innerHTML = `
      <div style="font-weight:600;">Claude (custom UX)</div>
      <div class="cs-slider-wrap">
        <span>Aa</span>
        <input type="range" id="cs-font-slider" min="11" max="24" step="1" value="${msgFontSize}">
        <span id="cs-font-pct">${msgFontSize}px</span>
      </div>
      <div style="flex:1"></div>
      <button class="cs-tb-btn" id="cs-reset-layout">Reset layout</button>`;
    document.body.appendChild(bar);
    bar.querySelector('#cs-font-slider').addEventListener('input', (e) => {
      msgFontSize = parseFloat(e.target.value);
      localStorage.setItem('cs_msg_font_size', msgFontSize);
      set('cs-font-pct', msgFontSize + 'px');
      applyMsgFontSize();
    });
    applyMsgFontSize();
    bar.querySelector('#cs-reset-layout').addEventListener('click', () => {
      localStorage.removeItem('cs_dock_tree_v2');
      dockTree = defaultDockTree();
      layoutDock();
    });
  }

  // ================= Init =================
  async function init() {
    injectStyles();
    chromeEl = document.createElement('div');
    chromeEl.id = 'cs-chrome';
    document.body.appendChild(chromeEl);
    dockTree = loadDockTree();
    buildToolbar();
    layoutDock();

    await initActivity();
    aggCache = await computeAggregate();
    renderStatsOnly(); renderSourcesWindow(); renderFilesWindow();
    setInterval(tick, TICK_MS);
    fetchRateLimits().then(rl => { if (rl) { rateLimitCache = rl; renderStatsOnly(); } });
    setInterval(() => fetchRateLimits().then(rl => { if (rl) { rateLimitCache = rl; renderStatsOnly(); } }), RATE_LIMIT_POLL_MS);

    await refreshSidebar();
    const m = location.pathname.match(/\/chat\/([a-f0-9-]{36})/i);
    if (m) await loadConversation(m[1]); else await startNewConversation();
  }
  init();
})();
