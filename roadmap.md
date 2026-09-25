# ClaudePlus Roadmap

This document translates the latest round of feedback into an ordered implementation plan. It is intentionally code-free — no line references, no snippets — so it can be reviewed and approved before any code changes are made.

Phases are ordered so that each one either protects existing user data or builds a foundation the later phases depend on. Within a phase, sub-items are grouped by the UI area they touch.

---

## Guiding principles

- **Never lose indexed data on a routine update.** A script update that doesn't change the data format must never force a reindex.
- **No migration machinery.** If stored data is ever found to be stale or malformed, the answer is a clean slate (user clears browser data and reindexes), not a library of versioned migration functions.
- **One composer, one active chat.** A human can only type into one conversation at a time — the UI should stop pretending otherwise.
- **Tables over dropdowns.** Anywhere the user sorts or filters a list, prefer a sortable/column-toggleable table over a select-dropdown-plus-button combo.
- **Everything reusable should be built once.** Sources, Files, and Chats lists all want the same "configurable columns + sortable headers" behavior — build it as one shared pattern, not three bespoke ones.
- **User state should survive the browser.** Anything that currently lives only in `localStorage`/IndexedDB should be exportable so it isn't lost to a wiped profile or a new machine.

---

## Phase 1 — Don't reindex on routine updates, don't crash on bad data

**Problem:** There's a standing worry that shipping a new script build could accidentally trigger a full reindex of every conversation, which is slow and unnecessary when only UI code changed. At the same time, this must stay simple — no migration system, no versioned data-format machinery.

**Target behavior:**
- The IndexedDB schema version stays fixed across ordinary script updates. Nothing about shipping new UI/feature code touches the DB version or its stores. The DB version only ever changes on the rare occasion the stored shape genuinely changes, and in that case the fix is manual: the user clears browser data and reindexes from scratch. No migration functions are written for this.
- Per-conversation indexing keeps using its existing "skip if already indexed and unchanged" comparison, so normal usage never re-indexes conversations that haven't changed on the server.
- The only new safeguard is a lightweight **consistency check** at startup/read time: if a stored record is missing an expected field or otherwise doesn't look like valid data, the app skips/ignores that record (and can surface a "some data looks stale — consider reindexing" hint) instead of throwing and breaking the whole panel. This is a defensive read guard, not a migration path.

---

## Phase 2 — Shared "column table" component

**Problem:** The Files panel already has the right pattern (sortable columns via clickable headers), but Chats and Web Sources don't use it, and the user specifically called out the Chats list's dropdown-plus-direction-button as the wrong approach.

**Target behavior:** One reusable table building block, used everywhere a list needs sorting/columns:
- A default minimal column (e.g. "Name") always shown.
- Additional columns toggleable on/off (chat name, date, outlet, turn count, file count, type, etc., depending on which panel uses it).
- Clicking a column header sorts by that column; clicking again reverses direction — standard file-explorer/table behavior, no separate dropdown or button needed.
- Column visibility and sort state persist per panel, the same way they do today.

This component is built once in this phase, then adopted by later phases instead of being reinvented per panel.

---

## Phase 3 — Decoupled composer & active-chat model

**Problem:** Every chat pane currently carries its own message input, model/effort selectors, and send button. With multiple panes open side by side, that's redundant chrome — a human can only compose into one conversation at a time anyway.

**Target behavior:**
- The message composer (text box, model selector, effort selector, thinking toggle) becomes a single, independent UI element, decoupled from any individual chat pane. It targets whichever chat pane currently has focus ("the active chat"), reusing the existing focused-pane concept.
- Individual chat panes no longer render their own composer — they become pure log/message views.
- The active chat pane gets a **faint green border**, but only when more than one chat pane is currently open/visible (with a single chat pane, the border is redundant and should stay hidden).
- Because the composer is now independent of any single pane, it can be docked/relocated in the workspace like any other panel, while chat panes stay where they are.
- The **Export chat** button moves out of the global toolbar and into this composer panel, and always acts on the currently active chat rather than requiring the user to focus a pane first via the old toolbar-driven flow.
- The composer's toolbar also gains the folder/globe buttons from Phase 5 (right-aligned, next to the model selector). Since the composer already always targets the active chat, these buttons act on that same active chat — no per-pane duplicate copies needed.
- The send button becomes invisible by default (no permanent button chrome). Enter sends, Shift+Enter inserts a line break — this keyboard behavior already exists in the current build and just needs the visible button removed/hidden accordingly.
- This phase makes the old top-toolbar's "+ Chat pane" button and each pane's own send button obsolete — both are superseded by Phase 4 and this phase respectively, and should be removed once the replacements land.

---

## Phase 4 — Unified "+" panel menu

**Problem:** Every tabbed panel already shows a "+" button in its tab strip, but today it does nothing.

**Target behavior:**
- Clicking a panel's "+" opens a dropdown with:
  - **Add chat** — opens a new, empty chat as a tab in that panel (replaces the now-obsolete dedicated "+ New chat" button once the composer is decoupled).
  - **Add Stats panel**, **Add Sources panel**, **Add Files panel**, **Add Chats-list panel** — adds a **new view instance** of that panel type as a tab in that zone. This never moves or removes an existing instance elsewhere — the underlying data (stats aggregate, sources index, files index, chats directory) stays centralized and is only ever read, never owned, by any one panel instance. Any number of instances of the same panel type can exist at once (e.g. nothing stops opening 50 Stats panels side by side); they're just independent renderers pointed at the same shared data, so they all stay in sync with each other automatically.
- Once this exists, the standalone "+ Chat pane" and "+ New chat" toolbar buttons can be retired — any panel can spawn a new chat tab directly.

---

## Phase 5 — Per-conversation inline Sources/Files panes

**Problem:** The Stats/Sources/Files panels are currently global-only. The user also wants to see, per individual conversation, which websites were searched and which files exist — without leaving that chat's pane.

**Target behavior:**
- The composer's toolbar (Phase 3) carries two buttons, right-aligned next to the model selector: a folder emoji (files for the active conversation) and a globe emoji (external sources for the active conversation). These live only in the composer — not duplicated on every pane — since the composer already always points at the active chat.
- Clicking either button adds a new **inner sub-pane** inside the currently active chat pane, showing that conversation's sources or files (reusing the Phase 2 table component, scoped to just this conversation instead of the global aggregate).
- The sub-pane can be docked to the **top, right, or left** edge of its parent chat pane; it defaults to the right.
- Both the files sub-pane and the sources sub-pane can be open at the same time within one chat pane.
- Each sub-pane has a close ("×") control and arrow controls to redock it to a different edge of the parent pane.

---

## Phase 6 — Retrofit Chats/Sources/Files to the shared table

**Problem:** With the Phase 2 component in hand, the three existing list-style panels should actually use it instead of their current bespoke UIs.

**Target behavior:**
- **Chats list:** replace the sort dropdown + direction-toggle button with sortable column headers (Name default, with Date/Turns/Files toggleable as columns, matching what already exists conceptually today but presented as a table).
- **Global Web Sources:** gains the same explorer-style table — default "Name"/title column, with Outlet, Date, Chat name, etc. toggleable.
- **Global Files:** already closest to this pattern (it has a sortable table for files within a single conversation's folder); extend it to the same configurable-column table used everywhere else, including at the top (cross-conversation) level.

---

## Phase 7 — Wildcard/typeahead filter dropdowns

**Problem:** The global Web Sources panel shows timestamps but offers no way to filter by date/date range, and outlet filtering today is a plain text box with no discoverability of what outlets even exist.

**Target behavior:**
- Filter inputs (outlet for Sources, equivalent fields for Files) become combined text-input + dropdown controls: clicking shows a scrollable list of every distinct value currently present in the data; typing narrows that list live.
- Matching supports `*` as a wildcard, case-insensitively (e.g. `*nbc*` matches both "NBC" and "MSNBC").
- Date/date-range filtering is added as its own filter control on the Sources panel (and anywhere else a timestamp column exists), since date columns currently can't be filtered at all.

---

## Phase 8 — Dedicated Search panel

**Problem:** The only search today is the plain substring filter on the Chats list. There's no way to search with structure or see richer metadata about what matched.

**Target behavior:**
- A new panel type focused purely on search, separate from the Chats list's quick filter.
- Supports qualifier syntax similar to Discord's (`file:`, `outlet:`, etc.) to scope a search to a specific kind of indexed data (a file name, a source outlet, etc.) rather than only matching conversation titles.
- Results show more metadata than the Chats list does today (e.g. which conversation, when, what matched and why), giving the user enough context to jump straight to the right place instead of opening conversations to check.

---

## Phase 9 — Layout save/load

**Problem:** "Reset layout" exists, but there's no way to preserve a deliberate multi-pane setup for later — a research session's exact arrangement is currently disposable.

**Target behavior:**
- **Save layout**: stores the current dock tree under a user-chosen name.
- **Load layout**: lists saved layouts and restores the chosen one, replacing the current arrangement.
- Multiple named layouts can coexist (not just one saved slot), so a user can build up a small library of setups (e.g. "research mode," "review mode") and switch between them on demand.

---

## Phase 10 — Settings export/import (JSON)

**Problem:** All app-specific settings currently live only in this browser's `localStorage`/IndexedDB, which doesn't survive a wiped profile or move to a new device.

**Target behavior:**
- An export action bundles all app-specific settings (preferences, saved layouts from Phase 9, column/sort configuration, etc.) into a single downloadable JSON file.
- An import action reads that JSON back in and restores it, effectively letting a user carry their whole ClaudePlus configuration between browsers/machines.
- Scope note: this covers *settings*, not the indexed conversation-history cache itself (which can always be rebuilt from claude.ai via the existing indexing flow) — worth confirming that split is what you intend, versus also wanting the indexed data portable.

---

## Suggested build order

1. Reindex-safety + consistency check (Phase 1) — protects everything that follows.
2. Shared table component (Phase 2) — foundation for Phases 5, 6, 8.
3. Composer decoupling + active-chat indicator (Phase 3) — structural change, do before the "+" menu.
4. Unified "+" panel menu (Phase 4) — depends on Phase 3's composer-less panes.
5. Per-conversation inline Sources/Files panes (Phase 5) — uses Phase 2's table.
6. Retrofit Chats/Sources/Files to shared table (Phase 6).
7. Wildcard/typeahead filters (Phase 7) — builds on Phase 6's tables.
8. Dedicated Search panel (Phase 8).
9. Layout save/load (Phase 9).
10. Settings export/import (Phase 10) — naturally last, since it should bundle whatever Phase 9 adds too.

---

## Open questions before implementation starts

1. Phase 10 scope: settings only, or should the export also optionally include the indexed conversation-history cache?
