# Injecting a build into the claude.ai page

The build is loaded from GitHub through jsDelivr, so it has to be pushed first.

1. Build, commit and push the branch.
2. Get the full commit SHA: `git rev-parse HEAD`. Use the SHA in the URL, not the branch name,
   because jsDelivr caches branch URLs.
3. Open `https://claude.ai/new` (or `https://claude.ai/chat/<id>`) in the Browser pane. Reload it
   if an earlier build was injected, so the page starts clean.
4. Run this in the page with the Browser pane's JavaScript tool, with the SHA filled in:

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

5. Wait until `.claude-plus-panel` (and `.claude-plus-message` for a chat) is in the DOM.

The injection has to use a script element: claude.ai's Content Security Policy blocks `eval` and
inline scripts, but allows a script loaded by a script element. `build/dev` is the readable build;
`build/prod` is the minified one.
