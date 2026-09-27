# Import claude.ai data export — implementation plan

This document is code-free — no line references, no snippets — so it can be reviewed and approved before any code changes are made. Where it names a new file or module, that's a naming *proposal* to make the plan concrete, not a commitment to exact code structure.

**Goal:** let the user upload the files they get from claude.ai's "Export my data" feature, and have those conversations appear in ClaudePlus's own Chats list as ordinary, searchable, openable chats — with the composer disabled and replaced by an explanatory note, since there's no live model behind an imported chat. Re-running an import later, with a newer export that has renamed, continued, or *branched* old chats and added new ones, must never create duplicates, must never discard anything from an earlier import, and must only touch what actually changed.

---

## What the export actually contains

- claude.ai's "Export my data" produces a **manifest JSON** listing one or more per-category ZIP downloads — `light_metadata`, `memories`, `conversations`, `frames`, `projects`, `feedback` — each a separate download URL, not one combined archive. Only the categories an account actually has data for are included (e.g. no `projects` zip if the account never created a Project).
- `conversations-000.zip` contains one `conversations.json`: a flat array of conversations, each with `uuid`, `name`, `summary`, `created_at`, `updated_at`, an `account.uuid`, and `chat_messages`.
- Every message has its own `uuid` and a `parent_message_uuid` (a fixed all-zero uuid marks the root, i.e. "no parent"). A single export holds the complete known tree for each conversation at export time — every branch that ever existed by that point, not just whichever one was active. Re-exporting after branching on claude.ai adds the new branch's messages alongside the old ones, unchanged; nothing is ever removed from `chat_messages` between exports.
- There's no "which leaf was showing" marker (no `current_leaf_message_uuid` in the export) — Phase 3 covers picking a sensible default.
- Content blocks use a `type` field: `text`, `tool_use`, `tool_result`, and `thinking`, lining up with ClaudePlus's own live content-block vocabulary — the existing renderer can be reused largely as-is.
- **`injected_prompt_block` is a distinct block type present in every conversation**, carrying backend-injected `<system-reminder>`/memory-snapshot text verbatim. It needs to be included in the lightbulb list workflow to be readable, it should not be shown in the chatlog itself.
- Widget-producing tool calls (`chart_display_v0`, `recipe_display_v0`, and ordinary tools like `web_search_fast`, `image_search`) come through as `tool_use`/`tool_result` pairs carrying the full input and, for the widget ones, the exact JSON payload the widget would render from. ClaudePlus runs inside the live claude.ai page itself, and its existing widget extractor already works by opening a hidden iframe against a live conversation's own claude.ai URL — an imported conversation's `uuid` is the same `uuid` it had live, so as long as that conversation still exists on the currently signed-in account, the exact same extractor can be reused directly, with genuine fidelity, not a JSON-based reconstruction. The "extraction unavailable" fallback (Phase 3) is only needed when that live lookup actually fails — the source conversation was deleted on claude.ai since export, or the export belongs to a different account than the one currently signed in.
- **Attachment `extracted_content` is the complete original file for text-based attachments** (html, code, markdown, plain text) — byte-for-byte, not a summary or an OCR pass. For anything that isn't text, see the next point.
- **A binary attachment (e.g. a shared screenshot) carries nothing beyond its filename.** Its message has `files: [{file_uuid, file_name}]` but an *empty* `attachments` array — no `extracted_content`, no `file_type`, no `file_size`. The two arrays correlate only by `file_name` (`attachments` entries carry no `uuid` of their own, so `files[].file_uuid` has nothing to match against). A `files[]` entry with no matching `attachments[]` entry by filename is exactly this case, and the import placeholder shows the filename alone — there's nothing else to show.
- **The `frames` category holds real, complete Artifact content.** `frames-000.zip` contains `artifacts/<artifact_id>/artifact.json` (title, version list, active version) plus the actual rendered HTML for each version, in full. The link back to a conversation: an assistant `tool_use` block named `"Artifact"` pairs with a `tool_result` whose `structured_content.artifact_id` matches that `frames` folder name exactly. This means an imported chat's Artifacts can render with **full fidelity** through the existing widget Shadow-DOM mount, fed the real HTML directly — no extraction step needed at all.
- `memories-000.zip` contains one JSON per account: `{account_uuid, memory_files: [{path, content, updated_at}, ...]}` — a virtual file tree of markdown notes (e.g. `/profile.md`, `/people/beans.md`, `/topics/home.md`), each with YAML frontmatter and its own `updated_at`. Project-scoped memory notes live in the same flat list, under `/projects/<project_uuid>/...` paths.
- `projects-000.zip` contains one JSON per project — `{uuid, name, description, is_private, prompt_template, created_at, updated_at, creator, docs: [{uuid, filename, content, created_at}]}`. `prompt_template` is the project's custom system-instruction text; `docs[].content` is the complete original file content, same as message attachments. **There is no link in either direction between a project and the conversations created inside it** — an exported conversation carries no `project_uuid` or other trace of having happened inside a Project, and a project's own JSON lists only its docs, never conversation ids. That's a gap in the source data itself, not something this plan can close.
- `feedback-000.zip` contains one JSON per account under `reflections/` — `{account_uuid, reflections: [{period, content: {...a monthly usage recap with stats, topics, and skill-based commentary...}}], feedback: []}`. This is Anthropic's own generated commentary about the account's usage patterns, not content the user wrote or asked Claude to remember — but it's real, human-readable, account-specific data, so this plan captures and stores it (Phase 2/4) the same way it does memories and Projects, rather than discarding it. See Open Question #6 for the two things still undecided about it.
- `light_metadata-000.zip` contains `users.json` (bare account profile) and `login_history.json` (IP/browser/location login events). Not chat content, but it's real data the export provides, so this plan captures and stores both — the account profile as a per-account snapshot, login history as an append-only log of events — the same "store now, no UI yet" treatment as memories, Projects, and Feedback/reflections. See Phase 2/4.
- claude.ai's agentic file-editing tools (`bash_tool`, `str_replace`, and the `Artifact` publish call itself) show up as ordinary `tool_use`/`tool_result` blocks. No special handling is required for these to render — the app's existing generic tool-call fallback already displays an unrecognized tool's input/result; a nicer view (e.g. terminal-styled for `bash_tool`) would be a nice-to-have, not a requirement.
- Custom skill/plugin/MCP usage has not appeared in any test export yet — see Open Question #5.

---

## Guiding principles

- **Vendor-specific code lives behind one boundary, not scattered through generically-named files.** ClaudePlus is Claude/Anthropic-specific throughout today, with no such boundary anywhere. Because this feature is itself new, permanently vendor-specific code, it's built directly against that boundary from the start (Phase 1) instead of adding to the entanglement the boundary exists to fix.
- **Reuse the existing rendering pipeline, don't fork it.** ClaudePlus already has a full concept of a conversation with structured content blocks, rendered branch-first from a flat message list via parent links. An imported conversation should be reshaped to fit that exact model, not given a parallel rendering path.
- **Both conversation `uuid` and message `uuid` are stable identity, and both get used.** The conversation uuid decides which stored conversation a newly exported one belongs to; the message uuids inside it decide, message by message, what's already known versus genuinely new. Never key anything off title, since titles can change.
- **Importing again must only ever add, never discard.** A later export of a conversation the app already has is treated as *more information about that conversation*, not a fresh replacement for it. If claude.ai branched or edited an earlier message since the last import, that shows up as the new export's messages diverging from the stored ones partway through — and the old, already-imported branch stays exactly as it was, with the new one added alongside it, not overwritten. Re-running an export that hasn't changed at all must still be a no-op — a real diff, not a blind merge.
- **Imported data is clearly imported.** The user should always be able to tell, at a glance, which chats came from a file versus which are live — and know that an imported chat is read-only.
- **Every category the export provides gets captured — nothing is silently dropped by default.** Memories, Projects, Feedback/reflections, and account/login metadata are each real, present categories in the export. This plan stores all of them cleanly and de-duplicated, even the ones with no browsing UI yet, since ClaudePlus has no UI concept for most of them today and building one is separate, larger scope. Storing now means the later UI work starts from correct data instead of a rework — and it's the default treatment for any new category, not something decided away case by case.

---

## Phase 1 — Establish the vendor boundary

**Problem:** ClaudePlus is Claude/Anthropic-specific throughout its codebase, but nothing marks which files are inherently tied to claude.ai's actual API, JSON shapes, model/effort/tool identifiers, or live-page structure versus which only depend on the app's own internal, already-normalized shape — both kinds of code currently sit side by side in the same generically-named folders. The import feature is itself entirely new, permanently vendor-specific code. Building it before this boundary exists would add fresh entanglement on day one, in exactly the code this move exists to untangle.

**Target behavior:**
- A new `src/vendors/anthropic/` tree (naming proposal) becomes the sole home for every file whose correctness depends on claude.ai's actual API endpoints, JSON field names, model/effort/tool-name identifiers, or live-page structure. The dividing line: a file moves if a hypothetical second vendor's adapter would need its own, different version of it; a file stays if a second vendor's adapter would produce the same internal shape and this file would keep working unmodified against that shape.
- Files that relocate as-is (each is entirely vendor-specific already):
  - The live API client: `ClaudeApi`.
  - The claude.ai-shaped conversation/message plumbing: `ConversationTree`, `MessageContent`, `MessageToolSteps`, `StreamEventApplier`, `ChatMessage`, `ConversationDirectory`, `currentBranchMessages`.
  - The widget pipeline: `WidgetExtractor`, `WidgetIframeSource`, `WidgetMount`, `WidgetToolCall`, `WidgetHash` (the last is technically generic but only meaningful inside this vendor-specific pipeline, so it moves with it rather than being split out for no benefit).
  - The claude.ai-shaped export builder: `ConversationExportBuilder` (its output, the neutral `ExportedConversation` shape, is what `ConversationExporter` and every format under `src/export/formats` already consume — those stay put, unchanged).
  - The model/effort catalog: `ModelCatalog`, `ModelCatalogSource`.
  - claude.ai's own URL scheme: `Router`, `conversationIdFromPath`, `conversationPath`.
  - The claude.ai-shaped usage summarizer: `ConversationSummarizer`.
  - The claude.ai-shaped tool-step renderer: `MessageToolStepsPane`.
  - The locale mapping tied to claude.ai's completion endpoint: `resolveLocale`.
  - Config constants that are claude.ai identifiers rather than app-internal settings: `MODELS`, `EFFORTS`, `THINKING_MODES`, `WIDGET_TOOL_NAMES`, `ROOT_MESSAGE_UUID`, `CHAT_PATH_PATTERN`, `STREAM_START`, `ATTACHMENT_NAME_FIELDS`, `ALLOWED_LOCALES`, `DEFAULT_LOCALE`, `NEW_CHAT_PATH`.
  - Typedefs that document the raw API contract itself: `ApiConversation`, `ApiMessage`, `ContentBlock`, `ConversationListing`, `UploadedFile`, `ComposerSnapshot`, `StreamEvent`.
- Files that need a narrow seam rather than a full move, because they're mostly generic orchestration with one or two direct reads of raw claude.ai field names mixed in: `ChatSession` (direct `current_leaf_message_uuid` access and a raw `apiMessage`-shaped object built inline), `ConversationListPanel` (its column definitions read raw `ConversationListing` fields directly), `SearchEngine` (seeded partly from raw `ConversationListing` fields), `StatsIndex` (its cache-key/staleness check reads `ApiConversation.uuid`/`.updated_at` directly). Each of these keeps its file and location; the specific vendor-shaped field accesses are replaced with a call into a small vendor-side accessor living under `src/vendors/anthropic/`, so the vendor-specific knowledge still lives in exactly one place without relocating otherwise-generic files.
- `src/header.js`'s Tampermonkey injection target (`@match https://claude.ai/*`) is inherently vendor-specific by nature but can't itself relocate — it's the userscript's required entry metadata. Noted here rather than silently left off this inventory.
- Everything not listed above (`src/core`, `src/dock`, `src/ui` including `composer`/`dialogs`/`html`/`tables`/`panels` other than the two exceptions above, `src/color`, `src/dom`, `src/math`, `src/text`, `src/time`, `src/settings`, and the rest of `src/config`/`src/types`) stays exactly where it is — confirmed to operate only on the app's own internal shape or to be pure UI/utility code with no data-shape awareness at all.
- This phase is a structural move only: relocation, import-path updates, and the narrow seams described above — no behavior change. It's verified the same way every other ClaudePlus change is verified: a live smoke pass against real claude.ai confirming chats still load, branch navigation, widget extraction, model/effort selection, search, stats, and chat export all still work exactly as before the move — not a new automated test suite.
- Once this lands, the import feature's own vendor-specific piece (Phase 3's parsing/mapping step) is written directly under `src/vendors/anthropic/import/` from the start; everything else this plan adds (storage, merge logic, UI) is written against the app's internal shape only, the same as every vendor-agnostic file already listed above.

---

## Phase 2 — Storage foundation

**Problem:** Nothing today persists a conversation's full message body client-side — `ChatSession` only ever holds one in memory, freshly fetched. Imported conversations have no live source to re-fetch from, so they need to be stored in full, locally.

**Target behavior:**
- A new IndexedDB store, keyed by conversation `uuid`, holds each imported conversation's full body (shaped like the app's existing internal conversation model — see Phase 3): its title, and the accumulated set of messages with their parent links, plus a small amount of import bookkeeping (when it was last imported).
- A second small store holds imported memory *files*, keyed by account `uuid` + file `path` (e.g. `/profile.md`) — one row per memory file, not one row per account, matching the export's own per-file granularity.
- A third store holds imported Artifact content, keyed by `artifact_id`: title and the active version's real HTML, so a message's `"Artifact"` tool call can be rendered by simple lookup rather than needing the conversation body to carry a large blob inline.
- A fourth store holds imported Projects, keyed by project `uuid`: name, description, the custom `prompt_template`, and its docs (each with their own uuid/filename/content).
- A fifth store holds imported Feedback/reflections, keyed by account `uuid` + `period`: the recap content for that period.
- A sixth store holds imported account/security metadata: one row per account `uuid` for the profile snapshot (from `users.json`), and a separate append-only log of login events (from `login_history.json`), each event keyed by whatever combination of its own fields uniquely identifies it (timestamp + IP + browser, confirmed against a real sample before implementation).
- This is the one deliberate, one-time IndexedDB version bump this feature needs — consistent with the project's existing rule that the schema version only changes when the stored shape genuinely changes, never routinely.

---

## Phase 3 — Parsing and mapping export data into the app's own shape

**Problem:** The export's JSON is very close to the shape ClaudePlus's renderer already expects, but a few things still need translating or filtering before it's usable.

**Target behavior:**
- This is the import feature's own vendor-specific code, living under `src/vendors/anthropic/import/` per Phase 1 — the only place that knows the export's literal JSON shape. It reads the selected file(s) (see Open Question #1 for exactly which files) and produces the conversation array and, if provided, the memory-file array, the Artifact-frame collection, the Project array, the Feedback/reflections array, and the account-profile/login-history data.
- A mapping step turns each raw exported message into the same message/content-block shape the app already renders live messages with. Because `uuid`, `parent_message_uuid`, `sender`, and `created_at` already match the app's own field names and meaning almost directly, this is a light shape conversion, not a restructuring:
  - Content blocks map type-for-type onto the app's existing block vocabulary (`text`, `tool_use`, `tool_result`, `thinking`).
  - `injected_prompt_block` is captured and stored as part of the message, not discarded — it's just excluded from the rendered chat log itself, and surfaced instead through the lightbulb list workflow, matching how it's handled for live conversations.
  - A `tool_use` named `"Artifact"` is matched to its paired `tool_result`'s `structured_content.artifact_id`, which is looked up against the imported frame content (if the frames file was provided — see Open Question #1). When found, it renders with full fidelity through the existing widget mount, fed the real HTML directly instead of an iframe-extracted copy. When the frames file wasn't provided, or that particular artifact isn't in it, this falls back to the same "unavailable" treatment as any other widget.
  - Anywhere else a `tool_use` is one of the app's known widget-producing tools (`chart_display_v0`, `recipe_display_v0`, and others — distinct from Artifacts, since these only ever have JSON input/output, never a real rendered file): the mapper records what's needed to re-run the existing live-page extractor against that conversation's own claude.ai URL (conversation `uuid` + message `uuid`) the same way it already works for a live chat. This extraction is attempted lazily, when the message is actually rendered/viewed, not eagerly for every widget in every conversation being imported (see Open Question #7). It only falls back to "extraction unavailable" if that live lookup genuinely fails — conversation deleted from the account since export, or the export belongs to a different account than the one currently signed in.
  - Each message's `files[]` entries are matched to its `attachments[]` entries by `file_name` (the only shared key). A match with content renders in full, as readable, searchable text. A `files[]` entry with no matching `attachments[]` entry renders as a plain filename-only placeholder, since the export contains nothing else for it to show.
- Since a conversation's own message set may already contain more than one leaf (a real branch, captured within a single export), and the export doesn't say which one was on screen, the mapper picks a sensible default for **new** conversations: the leaf whose own last message has the latest timestamp. (For a conversation already known from an earlier import, Phase 4 owns updating this, since it depends on what's already stored.)
- This mapping is intentionally the single place that knows about the export's per-message quirks — everything downstream (storage, rendering, search, stats) works purely in the app's own message shape and doesn't need to know a message was imported versus live.

---

## Phase 4 — Incremental merge and de-duplication

**Problem:** This is the crux of the "maximum utility" requirement — re-importing weeks later, with a mix of unchanged, renamed, continued, and *branched* conversations, must merge cleanly. Critically: if a conversation was branched or edited on claude.ai since the last import, the earlier import's messages must **not** be discarded — the old branch and the new one both stay, exactly as real claude.ai branching already works. A later export's `chat_messages` already contains the earlier export's messages verbatim, plus whatever's new, each carrying its own real `parent_message_uuid` — so merging is a per-message existence check, not an inference or list-walk.

**What's stored per conversation is a tree, not a flat list.** What accumulates locally is the same shape the live API already uses: messages with parent links, and — when a conversation has been branched — multiple messages sharing the same parent. A conversation imported only once is just a tree with one straight line in it; that's not a special case, it's the same structure with nothing branching yet.

**Merging one newly exported conversation into what's already stored:**
1. **Conversation not seen before** → classified as **New**. Every one of its messages is stored exactly as exported, parent links included — no reshaping needed.
2. **Conversation already stored** → for every message in the new export, check its `uuid` against what's already stored:
   - **Already known** → skip; nothing to do for that message.
   - **Not known yet** → store it as a new node, using its own `parent_message_uuid` exactly as the export gives it (that parent is either an already-stored message, or another new message from this same export — both are handled the same way, since the export already resolved the real relationship; nothing needs to be inferred).
   - This one rule handles every case without special-casing: a plain continuation is just new messages whose parent is the old leaf; a branch or an edited earlier message is new messages whose parent is somewhere *before* the old leaf — either way, the previously stored branch is untouched and stays fully reachable, and the new one is simply added alongside it.
   - **Rename with no new messages** (every message `uuid` in the new export already matches stored ones) → no message-tree changes at all, just the title field updates.
   - **Truly unchanged** (rename included) → nothing to write, skipped entirely.
   - The conversation's default-shown leaf (see Phase 3) is re-picked the same way after merging — whichever leaf now has the latest last-message timestamp — so a freshly imported continuation or branch becomes what's shown by default, while every older branch stays reachable through the app's existing branch-switcher, unmodified.
3. This per-message diff is what the picker in Phase 7 classifies and displays: **New** (whole conversation), **Changed** (existing conversation, new messages merged in — worth distinguishing continuation from branch in the UI, see Phase 7), **Renamed only** (title changed, no new messages), **Unchanged** (skipped).
- The same "only add, never discard" idea applies to memory files, but per-file rather than per-conversation: each is keyed by account `uuid` + file `path`, and a file is only overwritten when the newly exported version's own `updated_at` is newer — a file untouched since the last import is left alone, and there's no cross-file merging since each file's content is a complete, self-contained note, not something to diff line-by-line.
- Imported Artifact frames follow the same rule: a new one is added, an already-known one is only touched if a re-import brings a version it doesn't already have (matching by version id) — nothing is ever replaced with an older or identical copy.
- Imported Projects follow the same rule at two levels: the project itself, keyed by its `uuid` (name/description/prompt_template updated when the export's own `updated_at` is newer), and each of its docs independently, keyed by doc `uuid` (a doc is only overwritten when it comes back with a newer `created_at`/content).
- Imported Feedback/reflections follow the same "only add" idea, keyed by account `uuid` + `period`: a period not seen before is added; a period already stored is left alone, since a recap for a past period is treated as a fixed historical record (see Open Question #6).
- The account profile snapshot (`users.json`) is a single evolving record, not a log — a re-import overwrites it with the newer snapshot. Login history (`login_history.json`) is treated like Feedback/reflections: an append-only log, deduped by each event's own identity, new events added, already-known events left alone.
- This classification is computed *before* anything is written, so it can drive the picker UI in Phase 7 (letting the user see and choose what's about to change) rather than being a silent side effect of clicking "import."

---

## Phase 5 — Making imported chats show up as chats

**Problem:** Today, the Chats list is sourced entirely from one class that wraps the live `listConversations` API call, and opening a chat always means a fresh network fetch. Neither has any notion of a second, local-only source.

**Target behavior:**
- The existing conversation list is extended to merge in imported conversations' listings alongside the live ones it already fetches, each tagged so the rest of the UI can tell them apart (see Phase 7 for how that's shown).
- Opening a chat pane already goes through one central place that decides how to load a conversation by id; that decision point is extended to check whether the id belongs to an imported conversation first, and if so, load its full body from the local store instead of calling the live API. Every other part of message rendering, branch navigation (including for conversations that accumulated real branches across repeated imports — see Phase 4), and stats/search indexing keeps working unmodified, because the loaded object is shaped exactly like a live one.
- Imported conversations are fed through the exact same indexing step live conversations already go through, so they show up in stats totals and in whatever the existing search already covers — without building any new search capability, just extending its input.

---

## Phase 6 — Read-only composer for imported chats

**Problem:** There's currently no concept of "this chat can't be replied to" anywhere in the composer — sending is only gated on whether something is mid-send or the box is empty.

**Target behavior:**
- The active-chat concept gains a read-only flag, set whenever the open conversation is an imported one.
- When active, the composer replaces its text box with a short, clear explanatory line (e.g. "This is an imported chat — read-only, there's no model to reply to") instead of showing a disabled-looking textarea that invites a click. Model/effort selectors and the send affordance are hidden entirely rather than shown disabled, since they're meaningless here.
- The guard against sending also exists one layer down, at the point a prompt would actually be dispatched — not just in the composer's own visibility logic — so there's no path (keyboard shortcut, stale UI state, etc.) that could attempt to send into a conversation with nothing listening.

---

## Phase 7 — The import screen itself

**Problem:** This needs to be a real, reviewable picker — not a blind "upload and hope," per the user's explicit ask.

**Target behavior**, as a new modal (following the existing Settings-dialog pattern: a static layout with named regions, a dynamically rendered list section, delegated click handling for row actions):

1. **File selection.** The user picks the exported file(s) — see Open Question #1 for exactly which ones, given a real export is a manifest plus several separate per-category zips rather than one combined archive. Conversations are required; memories, Artifact frames, Projects, Feedback/reflections, and account/login metadata are each independently optional, with the picker clearly showing which optional pieces were actually provided (so it's obvious up front whether Artifacts will render with full fidelity or fall back to "unavailable").
2. **Parsed summary**, shown immediately after selection, before anything is written:
   - Header counts: how many conversations are New, Changed, Renamed only, and Unchanged; how many memory files, Projects, Feedback/reflections periods, and login-history events were found.
   - A scrollable list of every conversation found, each row showing its title, a badge for which of those four it is, message count, and last-updated date — enough to recognize what's being imported without opening it. For a **Changed** row, worth showing whether the new messages look like a plain continuation or an actual new branch (the merge in Phase 4 already knows the difference), so the user isn't surprised later by a branch they didn't expect.
   - Select-all / select-none, plus a smart default selection (New, Changed, and Renamed-only pre-checked, Unchanged unchecked, since re-checking something identical is pointless).
   - A separate toggle for "also import memory files," on by default, showing how many were found and how many are themselves new/changed/unchanged (per-file, per Phase 4). Similar toggles for Projects, Feedback/reflections, and account/login metadata, each shown only when that category's file was provided.
3. **Import.** Writes happen in batches with a progress indicator, the same style already used for the existing full-history backfill, since importing 100+ conversations with rich content is not instant.
4. **Result summary**: how many conversations were newly added, how many merged (continuations and branches broken out separately), how many renamed, how many memory files, Projects, Feedback/reflections periods, and login-history events saved — then the Chats list refreshes to show the results immediately.
- Imported rows in the Chats list carry a small, permanent marker (icon or badge) distinguishing them from live chats, and support local deletion (removing them from the local store, distinct from claude.ai's own delete, which obviously doesn't apply here).

---

## Explicitly out of scope for this pass

- **A Projects UI.** Projects are stored (Phase 2/4), but nothing in ClaudePlus's UI browses them — that's separate, larger scope than "make exported chats readable." Conversations that happened inside a project still import fine as ordinary chats regardless (the export doesn't link them to their project — see above).
- **A memories UI.** Storage only, per the user's own instruction — the later feature becomes a pure UI addition on top of already-correct, already-deduplicated data rather than a rework.
- **A Feedback/reflections UI.** Storage only, same reasoning as memories and Projects.
- **An account-profile/login-history UI.** Storage only — captured for completeness (see "What the export actually contains"), but nothing in ClaudePlus surfaces it today.
- **Reconstructing a branch that was never captured by *any* export.** If a branch existed on claude.ai only briefly, between two exports, and was never itself exported, it's genuinely gone — nothing in any file describes it. What *is* reconstructed is everything that ever appeared in any export, including real branches — that's a designed capability of this plan, not a gap.
- **A from-scratch, JSON-only static renderer for `chart_display_v0`/`recipe_display_v0`-style widget tool calls.** Not needed for the common case, since the plan reuses the existing live-page extractor directly (see "What the export actually contains" and Phase 3) — that only fails when the source conversation was deleted from the account since export or belongs to a different account. Building a renderer from the raw JSON alone, for that narrower deleted-conversation case, remains a possible future enhancement rather than something this pass needs.
- **Migrating the narrow-seam files' surrounding logic beyond what Phase 1 needs.** `ChatSession`, `ConversationListPanel`, `SearchEngine`, and `StatsIndex` get only the specific vendor-shaped field accesses routed through a vendor-side seam (Phase 1); any further refactor of those files is unrelated to this feature.

---

## Suggested build order

1. Vendor boundary (Phase 1) — relocates existing vendor-coupled code first, so every phase below is written against the post-migration structure from the start rather than adding to the entanglement Phase 1 removes.
2. Storage foundation (Phase 2) — everything else needs somewhere to write to.
3. Parsing/mapping (Phase 3) — turns raw export data into the app's own shape.
4. Merge/de-dup logic (Phase 4) — pure logic, testable against synthetic export data before any UI exists.
5. Directory/session integration (Phase 5) — makes imported chats actually appear and open.
6. Read-only composer (Phase 6) — small, but should land before real users open a real imported chat.
7. Import screen (Phase 7) — the picker UI wraps all of the above; it's the last piece because it needs the merge classification (Phase 4) and the storage writes (Phase 2) to already work.

---

## Open questions before implementation starts

1. **How is the export file selected?** A real export is a manifest JSON plus separate zips per category (`conversations-000.zip` required; `memories-000.zip`, `frames-000.zip`, `projects-000.zip`, `light_metadata-000.zip`, `feedback-000.zip` each optional/conditional on what the account has) — not one combined archive. ClaudePlus has zero runtime dependencies today; parsing zips directly would mean either the first external library the project has ever added, or a small hand-written ZIP-central-directory reader paired with the browser's native decompression API. The simpler alternative: the user extracts `conversations.json` (required) and, if they want them, the memory file(s), the artifact folder(s), and the project file(s) from their respective zips, then selects whatever they have directly in a normal multi-file picker — zero new parsing risk, at the cost of a few manual unzip steps for full fidelity. Recommend the simpler option unless one-click zip upload is worth that added complexity to you.
2. **What should the binary-attachment placeholder actually look like?** The data question is settled (nothing but a filename), just not the visual. The app's visual language is entirely emoji/CSS-based today (📁 🌐 📈 💡 etc.), with no image assets anywhere. Recommend a plain icon plus the filename (e.g. 📎 `1790516690926_image.png`) in that same style, rather than introducing the project's first bundled image asset — but say if you'd rather have an actual placeholder graphic.
3. **Where does "Import chat export…" live in the UI?** Proposed: a new entry in the existing Settings screen's Import/Export section, next to the current settings-JSON import/export. Open to a dedicated toolbar entry instead if you'd rather it be more prominent.
4. **Should a locally deleted imported chat "stay deleted" if it reappears in a later export?** i.e., is local deletion a real removal (a later re-import silently brings it back, since the merge logic has no memory of the deletion), or a tombstone (re-import must remember not to resurrect it)? Leaning toward tombstone, since silently resurrecting something the user deliberately removed would undercut trust in the delete action — but this is worth confirming.
5. **Custom skill/plugin/MCP usage hasn't appeared in any test export yet.** Everything else in this plan (conversation shape, branching, content-block types, memory-file shape, text- and binary-attachment fidelity, project-doc fidelity, Artifact frames, Projects) is confirmed against real exports. Worth either generating one more export that actually invokes an installed skill/plugin, or accepting it gets designed against real data whenever one is first encountered.
6. **Feedback/reflections is planned to be captured and stored by default**, the same way memories and Projects are. What's still open: (a) is storage-only, no-UI-yet the right treatment, or is this category different enough (it's commentary *about* the account rather than content the user produced) that you'd rather it be opt-in per import rather than on by default; (b) the merge rule in Phase 4 treats each `period` as an immutable historical record once seen — flag if you'd rather a re-import always refresh a period's content in case Anthropic's own recap for that period is ever revised after the fact.
7. **When should a widget's live re-extraction actually happen?** Recommend lazily — only when the user opens the imported chat and the widget's message is actually rendered, the same as how extraction already behaves for a live chat — rather than eagerly for every widget across every conversation at import time, which could mean dozens of hidden-iframe loads during a single large import. Also worth confirming: is it safe to assume import always happens while signed into the same claude.ai account the export came from? If not, the widget-extraction fallback (and possibly other live-data assumptions) needs an explicit "this export is from a different/no-longer-accessible account" state, not just a silent per-widget failure.
