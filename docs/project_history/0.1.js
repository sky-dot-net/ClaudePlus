// ==UserScript==
// @name         Claude.ai Stats Dashboard
// @namespace    skydotnet.claude.stats
// @version      2.0.0
// @description  Draggable, resizable, minimizable windows for claude.ai: session/turn/tool stats, a filterable web-sources log, and a folder-style file browser — all sourced from claude.ai's own internal API, aggregated across every session in IndexedDB.
// @match        https://claude.ai/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const IDLE_MS = 60 * 1000;
  const TICK_MS = 1000;
  const POLL_MS = 15 * 1000;
  const RATE_LIMIT_POLL_MS = 30 * 1000;
  const MAX_RESPONSE_GAP_MS = 30 * 60 * 1000;
  const BACKFILL_DELAY_MS = 350;
  const DB_NAME = 'claude_stats_v1';
  const DB_VERSION = 1;

  // ---------- IndexedDB ----------
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

  // ---------- API helpers ----------
  let orgIdCache = null;
  async function getOrgId() {
    if (orgIdCache) return orgIdCache;
    const res = await fetch('/api/organizations');
    const orgs = await res.json();
    orgIdCache = orgs[0].uuid;
    return orgIdCache;
  }
  function getConvId() {
    const m = location.pathname.match(/\/chat\/([a-f0-9-]{36})/i);
    return m ? m[1] : null;
  }
  async function fetchConversation(orgId, convId) {
    const p = new URLSearchParams();
    p.set('tree', 'True');
    p.set('rendering_mode', 'messages');
    p.set('render_all_tools', 'true');
    const res = await fetch(`/api/organizations/${orgId}/chat_conversations/${convId}?${p.toString()}`);
    if (!res.ok) return null;
    return res.json();
  }
  let rateLimitCache = null;
  async function fetchRateLimits() {
    try {
      const orgId = await getOrgId();
      const res = await fetch(`/api/organizations/${orgId}/usage`);
      if (!res.ok) return;
      const json = await res.json();
      rateLimitCache = { five_hour: json.five_hour, seven_day: json.seven_day };
      renderStatsOnly();
    } catch (e) { /* rate limit endpoint unavailable, leave cache as-is */ }
  }

  // ---------- Conversation summarizing ----------
  function estimateTokens(text) {
    return text ? Math.ceil(text.length / 4) : 0;
  }
  function messageText(msg) {
    if (msg.text) return msg.text;
    return (msg.content || [])
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n');
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
  function attachmentName(att) {
    return att.file_name || att.name || att.filename || att.title || '(uploaded file)';
  }
  function summarizeConversation(json) {
    const summary = {
      uuid: json.uuid,
      name: json.name || '(untitled)',
      updated_at: json.updated_at,
      turnCount: 0,
      toolCounts: {},
      sources: [],
      files: [],
      estTokensIn: 0,
      estTokensOut: 0,
      responseTimesMs: [],
    };
    let lastHumanTs = null;
    for (const msg of json.chat_messages || []) {
      if (msg.sender === 'human') {
        summary.turnCount++;
        summary.estTokensIn += estimateTokens(messageText(msg));
        lastHumanTs = msg.created_at;
        const uploads = [...(msg.attachments || []), ...(msg.files || [])];
        for (const att of uploads) {
          if (!att) continue;
          const name = attachmentName(att);
          summary.files.push({
            path: name,
            title: name,
            ts: att.created_at || msg.created_at,
            source: 'user',
          });
        }
      } else if (msg.sender === 'assistant') {
        summary.estTokensOut += estimateTokens(messageText(msg));
        if (lastHumanTs) {
          const dt = new Date(msg.created_at) - new Date(lastHumanTs);
          if (dt > 0 && dt < MAX_RESPONSE_GAP_MS) summary.responseTimesMs.push(dt);
          lastHumanTs = null;
        }
        const filesByPath = new Map();
        for (const block of msg.content || []) {
          if (block.type === 'tool_use') {
            const name = block.name || 'unknown_tool';
            summary.toolCounts[name] = (summary.toolCounts[name] || 0) + 1;
            if (name === 'create_file' && block.input) {
              const path = block.input.path || block.input.file_path || '';
              filesByPath.set(path, {
                path,
                title: block.input.description || path.split('/').pop(),
                ts: block.stop_timestamp || msg.created_at,
                source: 'claude',
              });
            } else if (name === 'Artifact' && block.input) {
              const path = block.input.file_path || '';
              filesByPath.set(path, {
                path,
                title: block.input.title || path.split('/').pop(),
                ts: block.stop_timestamp || msg.created_at,
                source: 'claude',
              });
            }
          }
          if (block.type === 'tool_result' && Array.isArray(block.content)) {
            for (const item of block.content) {
              if (item && item.url && item.title) {
                const { outlet, tld } = urlParts(item.url);
                summary.sources.push({ title: item.title, url: item.url, outlet, tld, ts: block.stop_timestamp || msg.created_at });
              }
            }
          }
        }
        summary.files.push(...filesByPath.values());
      }
    }
    return summary;
  }

  // ---------- Indexing ----------
  let currentConvId = null;
  let currentConvSummary = null;
  let aggCache = null;

  async function indexConversation(convId) {
    if (!convId) return null;
    try {
      const orgId = await getOrgId();
      const existing = await idbGet('conversations', convId);
      const json = await fetchConversation(orgId, convId);
      if (!json) return existing || null;
      if (existing && existing.updated_at === json.updated_at) {
        if (convId === currentConvId) currentConvSummary = existing;
        return existing;
      }
      const summary = summarizeConversation(json);
      await idbPut('conversations', summary);
      if (convId === currentConvId) currentConvSummary = summary;
      await refreshAggregate();
      return summary;
    } catch (e) {
      console.warn('[claude-stats] index failed', e);
      return null;
    }
  }

  async function computeAggregate() {
    const convs = await idbGetAll('conversations');
    const agg = {
      convCount: convs.length, toolCounts: {}, domainCounts: {},
      sources: [], files: [], responseTimesMs: [],
      estTokensIn: 0, estTokensOut: 0, turnCount: 0,
      tlds: new Set(), outlets: new Set(), filesByConv: new Map(),
    };
    for (const c of convs) {
      agg.turnCount += c.turnCount || 0;
      agg.estTokensIn += c.estTokensIn || 0;
      agg.estTokensOut += c.estTokensOut || 0;
      agg.responseTimesMs.push(...(c.responseTimesMs || []));
      for (const [k, v] of Object.entries(c.toolCounts || {})) agg.toolCounts[k] = (agg.toolCounts[k] || 0) + v;
      for (const s of c.sources || []) {
        agg.sources.push({ ...s, conv: c.name, convUuid: c.uuid });
        if (s.outlet) { agg.domainCounts[s.outlet] = (agg.domainCounts[s.outlet] || 0) + 1; agg.outlets.add(s.outlet); }
        if (s.tld) agg.tlds.add(s.tld);
      }
      for (const f of c.files || []) {
        const entry = { ...f, conv: c.name, convUuid: c.uuid };
        agg.files.push(entry);
        if (!agg.filesByConv.has(c.uuid)) agg.filesByConv.set(c.uuid, { conv: c.name, convUuid: c.uuid, files: [] });
        agg.filesByConv.get(c.uuid).files.push(entry);
      }
    }
    return agg;
  }
  async function refreshAggregate() {
    aggCache = await computeAggregate();
    renderAll();
  }

  // ---------- Backfill across all sessions ----------
  let backfillRunning = false;
  let backfillProgress = { done: 0, total: 0 };
  async function backfillAll() {
    if (backfillRunning) return;
    backfillRunning = true;
    renderStatsOnly();
    try {
      const orgId = await getOrgId();
      let offset = 0;
      const limit = 50;
      let all = [];
      while (true) {
        const p = new URLSearchParams();
        p.set('limit', String(limit));
        p.set('offset', String(offset));
        const res = await fetch(`/api/organizations/${orgId}/chat_conversations?${p.toString()}`);
        if (!res.ok) break;
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        all = all.concat(batch);
        offset += limit;
        if (batch.length < limit) break;
      }
      backfillProgress = { done: 0, total: all.length };
      for (const conv of all) {
        if (!backfillRunning) break;
        const existing = await idbGet('conversations', conv.uuid);
        if (!existing || existing.updated_at !== conv.updated_at) await indexConversation(conv.uuid);
        backfillProgress.done++;
        if (backfillProgress.done % 3 === 0) renderStatsOnly();
        await new Promise(r => setTimeout(r, BACKFILL_DELAY_MS));
      }
    } finally {
      backfillRunning = false;
      renderStatsOnly();
    }
  }

  // ---------- Activity / session timer ----------
  const activityState = { lastActivity: Date.now() };
  ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'].forEach(evt =>
    document.addEventListener(evt, () => { activityState.lastActivity = Date.now(); }, { passive: true })
  );
  function todayKey() { return new Date().toISOString().slice(0, 10); }
  let currentDay = todayKey();
  let todayActiveMs = 0;
  let allTimeActiveMs = 0;
  async function initActivity() {
    const rec = await idbGet('activity', currentDay);
    todayActiveMs = rec ? rec.activeMs : 0;
    const all = await idbGetAll('activity');
    allTimeActiveMs = all.reduce((s, r) => s + r.activeMs, 0);
  }
  async function tick() {
    const day = todayKey();
    if (day !== currentDay) { currentDay = day; todayActiveMs = 0; }
    const idle = Date.now() - activityState.lastActivity > IDLE_MS;
    if (!idle) {
      todayActiveMs += TICK_MS;
      allTimeActiveMs += TICK_MS;
      await idbPut('activity', { day: currentDay, activeMs: todayActiveMs });
    }
    renderSessionOnly();
  }

  // ---------- Navigation watcher (SPA) ----------
  function onNavigate() {
    const id = getConvId();
    if (id !== currentConvId) {
      currentConvId = id;
      currentConvSummary = null;
      if (id) {
        idbGet('conversations', id).then(existing => {
          if (existing && id === currentConvId) { currentConvSummary = existing; renderStatsOnly(); }
        });
        indexConversation(id);
      }
    }
    renderStatsOnly();
  }
  const origPushState = history.pushState;
  history.pushState = function (...args) { origPushState.apply(this, args); onNavigate(); };
  const origReplaceState = history.replaceState;
  history.replaceState = function (...args) { origReplaceState.apply(this, args); onNavigate(); };
  window.addEventListener('popstate', onNavigate);

  // ---------- Formatting ----------
  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }
  function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

  // ================= Window manager =================
  const windowStates = {};
  function loadWinState(id, defaults) {
    try {
      const raw = localStorage.getItem('cs_win_' + id);
      if (raw) return Object.assign({}, defaults, JSON.parse(raw));
    } catch (e) { /* ignore corrupt/inaccessible storage */ }
    return Object.assign({}, defaults);
  }
  function saveWinState(id) {
    try { localStorage.setItem('cs_win_' + id, JSON.stringify(windowStates[id])); } catch (e) { /* storage unavailable */ }
  }
  let zTop = 1000000;
  function bringToFront(el) { zTop++; el.style.zIndex = zTop; }

  function createWindow(id, title, defaults, bodyHtml) {
    const state = loadWinState(id, defaults);
    windowStates[id] = state;

    const win = document.createElement('div');
    win.id = 'cs-win-' + id;
    win.className = 'cs-window';
    win.style.left = state.x + 'px';
    win.style.top = state.y + 'px';
    win.style.width = state.w + 'px';
    win.style.height = state.h + 'px';
    win.style.display = state.closed ? 'none' : 'flex';
    win.innerHTML = `
      <div class="cs-win-header">
        <span class="cs-win-title">${title}</span>
        <span class="cs-win-btns">
          <button class="cs-win-min" title="Minimize">–</button>
          <button class="cs-win-close" title="Close">×</button>
        </span>
      </div>
      <div class="cs-win-body">${bodyHtml}</div>
      <div class="cs-win-resize"></div>
    `;
    document.body.appendChild(win);

    const body = win.querySelector('.cs-win-body');
    const header = win.querySelector('.cs-win-header');
    const resizeHandle = win.querySelector('.cs-win-resize');
    const minBtn = win.querySelector('.cs-win-min');
    const closeBtn = win.querySelector('.cs-win-close');

    function applyMinimized() {
      body.style.display = state.minimized ? 'none' : '';
      resizeHandle.style.display = state.minimized ? 'none' : '';
      win.style.height = state.minimized ? 'auto' : state.h + 'px';
      minBtn.textContent = state.minimized ? '▢' : '–';
    }
    applyMinimized();

    let dragging = false, dragStartX = 0, dragStartY = 0, startLeft = 0, startTop = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target === minBtn || e.target === closeBtn) return;
      dragging = true;
      dragStartX = e.clientX; dragStartY = e.clientY;
      startLeft = win.offsetLeft; startTop = win.offsetTop;
      bringToFront(win);
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      state.x = Math.max(0, startLeft + (e.clientX - dragStartX));
      state.y = Math.max(0, startTop + (e.clientY - dragStartY));
      win.style.left = state.x + 'px';
      win.style.top = state.y + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; saveWinState(id); }
      if (resizing) { resizing = false; saveWinState(id); }
    });

    let resizing = false, rStartX = 0, rStartY = 0, rStartW = 0, rStartH = 0;
    resizeHandle.addEventListener('mousedown', (e) => {
      resizing = true;
      rStartX = e.clientX; rStartY = e.clientY;
      rStartW = win.offsetWidth; rStartH = win.offsetHeight;
      bringToFront(win);
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      state.w = Math.max(280, rStartW + (e.clientX - rStartX));
      state.h = Math.max(160, rStartH + (e.clientY - rStartY));
      win.style.width = state.w + 'px';
      win.style.height = state.h + 'px';
    });

    minBtn.addEventListener('click', () => {
      state.minimized = !state.minimized;
      applyMinimized();
      saveWinState(id);
    });
    closeBtn.addEventListener('click', () => {
      state.closed = true;
      win.style.display = 'none';
      saveWinState(id);
    });
    win.addEventListener('mousedown', () => bringToFront(win));

    return {
      el: win, body, state,
      toggle: () => {
        state.closed = !state.closed;
        win.style.display = state.closed ? 'none' : 'flex';
        if (!state.closed) bringToFront(win);
        saveWinState(id);
      },
      setMinimized: (m) => { state.minimized = m; applyMinimized(); saveWinState(id); },
    };
  }

  function buildToggleBar(windows) {
    const bar = document.createElement('div');
    bar.id = 'cs-toggle-bar';
    bar.innerHTML = `
      <button class="cs-toggle" id="cs-toggle-stats" title="Stats">📊</button>
      <button class="cs-toggle" id="cs-toggle-sources" title="Web Sources">🌐</button>
      <button class="cs-toggle" id="cs-toggle-files" title="Files">📁</button>
      <button class="cs-toggle" id="cs-toggle-collapse" title="Collapse / restore all">⤢</button>
    `;
    document.body.appendChild(bar);

    document.getElementById('cs-toggle-stats').addEventListener('click', () => windows.stats.toggle());
    document.getElementById('cs-toggle-sources').addEventListener('click', () => windows.sources.toggle());
    document.getElementById('cs-toggle-files').addEventListener('click', () => windows.files.toggle());

    let collapsedAll = false;
    const prevMinState = {};
    document.getElementById('cs-toggle-collapse').addEventListener('click', () => {
      collapsedAll = !collapsedAll;
      for (const key of Object.keys(windows)) {
        const w = windows[key];
        if (w.state.closed) continue;
        if (collapsedAll) {
          prevMinState[key] = w.state.minimized;
          w.setMinimized(true);
        } else {
          w.setMinimized(prevMinState[key] || false);
        }
      }
    });
  }

  // ---------- Rendering: Stats window ----------
  function renderSessionOnly() {
    set('cs-active-today', formatDuration(todayActiveMs));
    set('cs-active-total', formatDuration(allTimeActiveMs));
    set('cs-idle-status', (Date.now() - activityState.lastActivity > IDLE_MS) ? 'idle' : 'active');
  }
  function renderTools(agg) {
    const entries = Object.entries(agg.toolCounts).sort((a, b) => b[1] - a[1]);
    set('cs-tools-count', entries.reduce((s, [, v]) => s + v, 0));
    const el = document.getElementById('cs-tools');
    if (el) el.innerHTML = entries.map(([name, count]) =>
      `<div class="cs-row"><span>${escapeHtml(name)}</span><b>${count}</b></div>`
    ).join('') || '<div class="cs-empty">No tool calls indexed yet.</div>';
  }
  function renderStatsOnly() {
    const agg = aggCache || { toolCounts: {}, estTokensIn: 0, estTokensOut: 0, turnCount: 0, convCount: 0, responseTimesMs: [] };

    set('cs-turns-current', currentConvSummary ? currentConvSummary.turnCount : '–');
    set('cs-turns-total', agg.turnCount);
    set('cs-avg-current', currentConvSummary && currentConvSummary.responseTimesMs.length ? formatDuration(avg(currentConvSummary.responseTimesMs)) : '–');
    set('cs-avg-total', agg.responseTimesMs.length ? formatDuration(avg(agg.responseTimesMs)) : '–');

    if (rateLimitCache) {
      const fh = rateLimitCache.five_hour, sd = rateLimitCache.seven_day;
      set('cs-rl-session', fh ? `${fh.utilization}% · resets in ${formatDuration(new Date(fh.resets_at) - new Date())}` : '–');
      set('cs-rl-weekly', sd ? `${sd.utilization}% · resets in ${formatDuration(new Date(sd.resets_at) - new Date())}` : '–');
    }

    set('cs-tokens', `~${agg.estTokensIn.toLocaleString()} in / ~${agg.estTokensOut.toLocaleString()} out`);
    set('cs-conv-count', agg.convCount);
    renderTools(agg);

    const btn = document.getElementById('cs-backfill');
    const status = document.getElementById('cs-backfill-status');
    if (btn && status) {
      if (backfillRunning) {
        btn.textContent = 'Cancel indexing';
        status.textContent = `Indexing… ${backfillProgress.done} / ${backfillProgress.total}`;
      } else {
        btn.textContent = 'Index full history';
        status.textContent = backfillProgress.total ? `Last run: ${backfillProgress.done} / ${backfillProgress.total} indexed` : 'Not run yet — pulls every past conversation once.';
      }
    }
  }

  // ---------- Rendering: Sources window ----------
  function applySourceFilter() {
    const container = document.getElementById('cs-src-list');
    if (!container || !aggCache) return;
    const tldEl = document.getElementById('cs-src-tld');
    const outletEl = document.getElementById('cs-src-outlet');
    const fromEl = document.getElementById('cs-src-from');
    const toEl = document.getElementById('cs-src-to');
    const tld = tldEl ? tldEl.value : '';
    const outletQ = (outletEl ? outletEl.value : '').toLowerCase();
    const fromT = fromEl && fromEl.value ? new Date(fromEl.value + 'T00:00:00').getTime() : null;
    const toT = toEl && toEl.value ? new Date(toEl.value + 'T23:59:59').getTime() : null;

    const list = aggCache.sources.filter(s => {
      if (tld && s.tld !== tld) return false;
      if (outletQ && !(s.outlet || '').toLowerCase().includes(outletQ)) return false;
      const t = new Date(s.ts).getTime();
      if (fromT && t < fromT) return false;
      if (toT && t > toT) return false;
      return true;
    }).sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 500);

    container.innerHTML = list.map(s => `
      <div class="cs-source-row">
        <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a>
        <div class="cs-file-meta">${escapeHtml(s.outlet || '')}${s.tld ? ' · .' + escapeHtml(s.tld) : ''} · ${new Date(s.ts).toLocaleString()} · ${escapeHtml(s.conv || '')}</div>
      </div>`).join('') || '<div class="cs-empty">No web sources match these filters.</div>';
  }
  function renderDomains(agg) {
    const entries = Object.entries(agg.domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 30);
    set('cs-domains-count', Object.keys(agg.domainCounts).length);
    const el = document.getElementById('cs-domains');
    if (el) el.innerHTML = entries.map(([d, c]) =>
      `<div class="cs-row"><span>${escapeHtml(d)}</span><b>${c}</b></div>`
    ).join('') || '<div class="cs-empty">No sources yet.</div>';
  }
  function renderSourcesWindow() {
    if (!aggCache) return;
    const tldSelect = document.getElementById('cs-src-tld');
    if (tldSelect) {
      const current = tldSelect.value;
      const tlds = Array.from(aggCache.tlds).sort();
      tldSelect.innerHTML = '<option value="">All TLDs</option>' + tlds.map(t => `<option value="${escapeHtml(t)}">.${escapeHtml(t)}</option>`).join('');
      tldSelect.value = tlds.includes(current) ? current : '';
    }
    const outletList = document.getElementById('cs-src-outlet-list');
    if (outletList) {
      outletList.innerHTML = Array.from(aggCache.outlets).sort().map(o => `<option value="${escapeHtml(o)}"></option>`).join('');
    }
    applySourceFilter();
    renderDomains(aggCache);
  }

  // ---------- Rendering: Files window (folder browser) ----------
  const filesNav = { folder: null };
  const filesSort = { key: 'date', dir: -1 };

  function renderFilesFolders() {
    const breadcrumb = document.getElementById('cs-files-breadcrumb');
    const folderEl = document.getElementById('cs-files-folders');
    const tableWrap = document.getElementById('cs-files-table-wrap');
    if (!breadcrumb || !folderEl || !tableWrap || !aggCache) return;
    breadcrumb.innerHTML = '<span>All folders</span>';
    folderEl.style.display = '';
    tableWrap.style.display = 'none';

    const folders = Array.from(aggCache.filesByConv.values()).sort((a, b) => {
      const at = Math.max(...a.files.map(f => new Date(f.ts).getTime()));
      const bt = Math.max(...b.files.map(f => new Date(f.ts).getTime()));
      return bt - at;
    });
    folderEl.innerHTML = folders.map(f => `
      <div class="cs-folder" data-conv="${f.convUuid}" title="${escapeHtml(f.conv)}">
        <div class="cs-folder-icon">📁</div>
        <div class="cs-folder-name">${escapeHtml(f.conv)}</div>
        <div class="cs-folder-count">${f.files.length} file${f.files.length === 1 ? '' : 's'}</div>
      </div>`).join('') || '<div class="cs-empty">No files or attachments indexed yet.</div>';
    folderEl.querySelectorAll('.cs-folder').forEach(el => {
      el.addEventListener('dblclick', () => { filesNav.folder = el.dataset.conv; renderFilesWindow(); });
    });
  }
  function renderFilesTable() {
    const breadcrumb = document.getElementById('cs-files-breadcrumb');
    const folderEl = document.getElementById('cs-files-folders');
    const tableWrap = document.getElementById('cs-files-table-wrap');
    const tbody = document.getElementById('cs-files-tbody');
    if (!breadcrumb || !folderEl || !tableWrap || !tbody || !aggCache) return;
    const folderData = aggCache.filesByConv.get(filesNav.folder);
    folderEl.style.display = 'none';
    tableWrap.style.display = '';
    breadcrumb.innerHTML = `<span class="cs-breadcrumb-link" id="cs-files-back">← All folders</span> / ${escapeHtml(folderData ? folderData.conv : '')}`;
    const backLink = document.getElementById('cs-files-back');
    if (backLink) backLink.addEventListener('click', () => { filesNav.folder = null; renderFilesWindow(); });

    const files = folderData ? folderData.files.map(f => ({ ...f, _ext: fileExt(f.title || f.path) })) : [];
    files.sort((a, b) => {
      let av, bv;
      if (filesSort.key === 'name') { av = (a.title || '').toLowerCase(); bv = (b.title || '').toLowerCase(); }
      else if (filesSort.key === 'type') { av = a._ext; bv = b._ext; }
      else if (filesSort.key === 'source') { av = a.source || ''; bv = b.source || ''; }
      else { av = new Date(a.ts).getTime(); bv = new Date(b.ts).getTime(); }
      if (av < bv) return -1 * filesSort.dir;
      if (av > bv) return 1 * filesSort.dir;
      return 0;
    });
    tbody.innerHTML = files.map(f => `
      <tr>
        <td>${escapeHtml(f.title || '(file)')}</td>
        <td>${escapeHtml(f._ext)}</td>
        <td>${new Date(f.ts).toLocaleString()}</td>
        <td>${f.source === 'user' ? 'User' : 'Claude'}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="cs-empty">No files here.</td></tr>';
  }
  function renderFilesWindow() {
    if (!aggCache) return;
    if (filesNav.folder && aggCache.filesByConv.has(filesNav.folder)) renderFilesTable();
    else { filesNav.folder = null; renderFilesFolders(); }
  }

  function renderAll() {
    renderSessionOnly();
    renderStatsOnly();
    renderSourcesWindow();
    renderFilesWindow();
  }

  // ---------- Styles ----------
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #cs-toggle-bar { position: fixed; bottom: 20px; right: 20px; z-index: 999999; display: flex; flex-direction: column; gap: 10px; }
      .cs-toggle {
        width: 44px; height: 44px; border-radius: 50%; border: none;
        background: #d97757; color: #fff; font-size: 18px; cursor: pointer;
        box-shadow: 0 2px 10px rgba(0,0,0,0.4);
      }
      .cs-window {
        position: fixed; z-index: 999999;
        background: #262523; color: #ececec; border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.5);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px; display: flex; flex-direction: column; overflow: hidden;
        min-width: 280px; min-height: 120px;
      }
      .cs-win-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 10px; font-weight: 600; background: #1f1e1c; cursor: move; user-select: none;
        flex-shrink: 0;
      }
      .cs-win-btns button { background: none; border: none; color: #ececec; font-size: 15px; cursor: pointer; line-height: 1; margin-left: 8px; }
      .cs-win-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; }
      .cs-win-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
      .cs-win-resize::after { content: ''; position: absolute; right: 4px; bottom: 4px; width: 6px; height: 6px; border-right: 2px solid rgba(255,255,255,0.3); border-bottom: 2px solid rgba(255,255,255,0.3); }

      .cs-section { padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
      .cs-section:last-child { border-bottom: none; }
      .cs-row { display: flex; justify-content: space-between; padding: 2px 0; gap: 8px; }
      .cs-row span { color: #b8b6b3; }
      .cs-hint { color: #8a8886; font-size: 11px; margin-top: 4px; }
      summary { cursor: pointer; padding: 4px 0; color: #ececec; }
      .cs-scroll { overflow-y: auto; }
      .cs-grow { flex: 1; min-height: 0; }
      .cs-empty { color: #8a8886; font-style: italic; padding: 6px 0; }
      .cs-source-row, .cs-file-row { padding: 6px 0; border-top: 1px solid rgba(255,255,255,0.05); }
      .cs-source-row:first-child, .cs-file-row:first-child { border-top: none; }
      .cs-source-row a { color: #d97757; text-decoration: none; }
      .cs-source-row a:hover { text-decoration: underline; }
      .cs-file-meta { color: #8a8886; font-size: 11px; margin-top: 2px; }
      #cs-backfill {
        width: 100%; padding: 7px; background: #d97757; border: none; border-radius: 6px;
        color: #fff; font-size: 13px; cursor: pointer; font-weight: 600;
      }

      .cs-filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; flex-shrink: 0; }
      .cs-filters select, .cs-filters input[type=text] {
        flex: 1; min-width: 100px; background: #1c1b1a; border: 1px solid rgba(255,255,255,0.12);
        border-radius: 6px; color: #ececec; padding: 5px 6px; font-size: 12px;
      }
      .cs-daterow { display: flex; align-items: center; gap: 6px; width: 100%; }
      .cs-daterow input[type=date] { flex: 1; background: #1c1b1a; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; color: #ececec; padding: 4px 6px; font-size: 12px; }

      .cs-folder-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 10px; align-content: start; }
      .cs-folder { display: flex; flex-direction: column; align-items: center; text-align: center; cursor: pointer; padding: 8px 4px; border-radius: 8px; }
      .cs-folder:hover { background: rgba(255,255,255,0.06); }
      .cs-folder-icon { font-size: 28px; }
      .cs-folder-name { font-size: 11px; margin-top: 4px; word-break: break-word; }
      .cs-folder-count { font-size: 10px; color: #8a8886; }

      .cs-breadcrumb { font-size: 12px; color: #b8b6b3; margin-bottom: 6px; flex-shrink: 0; }
      .cs-breadcrumb-link { color: #d97757; cursor: pointer; }
      #cs-files-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      #cs-files-table th { text-align: left; cursor: pointer; padding: 4px 6px; color: #b8b6b3; border-bottom: 1px solid rgba(255,255,255,0.1); position: sticky; top: 0; background: #262523; }
      #cs-files-table td { padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    `;
    document.head.appendChild(style);
  }

  // ---------- Panel bodies ----------
  const statsBodyHtml = `
    <div class="cs-section">
      <div class="cs-row"><span>Active today</span><b id="cs-active-today">0s</b></div>
      <div class="cs-row"><span>Active all-time</span><b id="cs-active-total">0s</b></div>
      <div class="cs-row"><span>Status</span><b id="cs-idle-status">active</b></div>
    </div>
    <div class="cs-section">
      <div class="cs-row"><span>Turns (this chat)</span><b id="cs-turns-current">–</b></div>
      <div class="cs-row"><span>Turns (all chats)</span><b id="cs-turns-total">0</b></div>
      <div class="cs-row"><span>Avg response (this chat)</span><b id="cs-avg-current">–</b></div>
      <div class="cs-row"><span>Avg response (all-time)</span><b id="cs-avg-total">–</b></div>
    </div>
    <div class="cs-section">
      <div class="cs-row"><span>Session limit (5h)</span><b id="cs-rl-session">–</b></div>
      <div class="cs-row"><span>Weekly limit</span><b id="cs-rl-weekly">–</b></div>
    </div>
    <div class="cs-section">
      <div class="cs-row"><span>Est. tokens in / out</span><b id="cs-tokens">–</b></div>
      <div class="cs-hint">Estimated from text length — claude.ai doesn't expose real token counts to the browser.</div>
    </div>
    <details class="cs-section" open>
      <summary>Tool calls (<span id="cs-tools-count">0</span>)</summary>
      <div id="cs-tools" class="cs-scroll"></div>
    </details>
    <div class="cs-section">
      <button id="cs-backfill">Index full history</button>
      <div id="cs-backfill-status" class="cs-hint"></div>
      <div class="cs-row" style="margin-top:6px;"><span>Conversations indexed</span><b id="cs-conv-count">0</b></div>
    </div>
  `;
  const sourcesBodyHtml = `
    <div class="cs-filters">
      <select id="cs-src-tld"><option value="">All TLDs</option></select>
      <input id="cs-src-outlet" type="text" placeholder="Outlet contains…" list="cs-src-outlet-list" />
      <datalist id="cs-src-outlet-list"></datalist>
      <div class="cs-daterow">
        <input id="cs-src-from" type="date" />
        <span>to</span>
        <input id="cs-src-to" type="date" />
      </div>
    </div>
    <div id="cs-src-list" class="cs-scroll cs-grow"></div>
    <details class="cs-section">
      <summary>Top outlets (<span id="cs-domains-count">0</span>)</summary>
      <div id="cs-domains" class="cs-scroll"></div>
    </details>
  `;
  const filesBodyHtml = `
    <div id="cs-files-breadcrumb" class="cs-breadcrumb"></div>
    <div id="cs-files-folders" class="cs-scroll cs-grow cs-folder-grid"></div>
    <div id="cs-files-table-wrap" class="cs-scroll cs-grow" style="display:none;">
      <table id="cs-files-table">
        <thead><tr>
          <th data-sort="name">Name</th>
          <th data-sort="type">Type</th>
          <th data-sort="date">Date</th>
          <th data-sort="source">Source</th>
        </tr></thead>
        <tbody id="cs-files-tbody"></tbody>
      </table>
    </div>
  `;

  function wireStatsWindow(win) {
    win.body.querySelector('#cs-backfill').addEventListener('click', () => {
      if (backfillRunning) { backfillRunning = false; return; }
      backfillAll();
    });
  }
  function wireSourcesWindow(win) {
    ['cs-src-tld', 'cs-src-outlet', 'cs-src-from', 'cs-src-to'].forEach(id => {
      const el = win.body.querySelector('#' + id);
      if (el) { el.addEventListener('input', applySourceFilter); el.addEventListener('change', applySourceFilter); }
    });
  }
  function wireFilesWindow(win) {
    win.body.querySelectorAll('#cs-files-table thead th').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (filesSort.key === key) filesSort.dir *= -1; else { filesSort.key = key; filesSort.dir = 1; }
        renderFilesTable();
      });
    });
  }

  // ---------- Init ----------
  async function init() {
    injectStyles();

    const windows = {};
    const colX = Math.max(20, window.innerWidth - 380);
    windows.stats = createWindow('stats', 'Claude Stats',
      { x: colX, y: 20, w: 340, h: 380, minimized: false, closed: true }, statsBodyHtml);
    windows.sources = createWindow('sources', 'Web Sources',
      { x: colX, y: 416, w: 340, h: 380, minimized: false, closed: true }, sourcesBodyHtml);
    windows.files = createWindow('files', 'Files',
      { x: colX, y: 812, w: 340, h: 340, minimized: false, closed: true }, filesBodyHtml);

    buildToggleBar(windows);
    wireStatsWindow(windows.stats);
    wireSourcesWindow(windows.sources);
    wireFilesWindow(windows.files);

    await initActivity();
    aggCache = await computeAggregate();
    renderAll();

    setInterval(tick, TICK_MS);
    fetchRateLimits();
    setInterval(fetchRateLimits, RATE_LIMIT_POLL_MS);
    onNavigate();
    setInterval(() => { if (currentConvId) indexConversation(currentConvId); }, POLL_MS);
  }
  init();
})();
