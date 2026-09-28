# Live testing in the real claude.ai page

ClaudePlus runs inside the claude.ai page, so a change is only proven once it has run there. The
headless smoke tests (`tests/smoke`, run against `build/dev` and `build/prod`) use a mocked claude.ai
and cover behavior; the live check covers real data and the real page.

The browser used for this is the Browser pane of the Claude desktop app. It is a real browser
profile that is logged in to the user's own claude.ai account and holds their imported chats in
IndexedDB, so treat everything in it as real:

- Only read. Never send a message, delete a chat, or leave test conversations, test records or
  extra panels behind. Undo any layout change made while testing (for example close a panel that
  was added), and remove any record that was written for a test.
- Reading a chat through the app is fine; it only fetches.

## Injecting a build

The build has to be pushed first, because the page loads it from GitHub through jsDelivr.

1. Build (`ops/build.ps1`, or the rollup and terser commands it runs), commit and push the branch.
2. Take the full commit SHA (`git rev-parse HEAD`). Use the SHA, never the branch name: jsDelivr
   caches branch URLs, so a branch URL can serve an older build.
3. Open a claude.ai page in the Browser pane (`https://claude.ai/new`, or `/chat/<id>` to start in
   a chat). Reload it first so an earlier injected build is gone.
4. Run this in the page (the Browser pane's JavaScript tool), with the SHA filled in:

   ```js
   await new Promise((resolve, reject) => {
     const script = document.createElement('script');
     script.src = 'https://cdn.jsdelivr.net/gh/sky-dot-net/ClaudePlus@<full-sha>/build/dev/ClaudePlus.js';
     script.onload = resolve;
     script.onerror = () => reject(new Error('load'));
     document.head.append(script);
   });
   document.querySelector('.claude-plus-launcher').click();
   ```

   A script element is required: claude.ai's Content Security Policy forbids `eval` and inline
   scripts, but allows a script loaded by a script element. `build/dev` is readable and has line
   numbers in its errors; `build/prod` is the minified one users install.
5. ClaudePlus does not start by itself. The click on `.claude-plus-launcher` mounts it. Wait for
   `.claude-plus-message` (a chat's messages) or `.claude-plus-panel` to appear before measuring.

## Driving and inspecting it

- Read state with the JavaScript tool: DOM (`querySelectorAll`), `localStorage` (`claudePlus.*`
  keys) and IndexedDB (database `claudePlus`, stores such as `conversationSummaries` and
  `importedConversations`). Return small JSON, and split long polling loops into calls under the
  tool's 45 second limit.
- Real clicks and key presses (`computer` tool) exercise the real handlers, so use them for
  hotkeys, drags and anything that depends on focus. Dispatching events from script is enough for
  reading and for clicks on table rows, but tabs of the dock need a real `mousedown`/`mouseup`/
  `click` sequence.
- Use `performance.now()` around an action to time it, and poll for its visible result
  (`.claude-plus-message--highlighted`, a count label, a row) instead of sleeping a fixed time.
- A long chat is a good test: the app windows its message list, so a few messages are in the DOM
  while `scrollHeight` is hundreds of thousands of pixels. Check where a jump lands by comparing
  the highlighted element's rectangle with the list's.

## After testing

- Reload the page to drop the injected build; ClaudePlus itself is installed through the
  userscript manager, not through this injection.
- Restore the layout and any stored setting the test changed.
