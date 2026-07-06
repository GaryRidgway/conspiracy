# Infinite Whiteboard

Vanilla JS infinite-canvas whiteboard with optional Google Drive sync.
No build step, no frameworks, no runtime dependencies: `index.html` +
`styles.css` + `app.js` (one IIFE, section banners) are the whole app.

**Read `ARCHITECTURE.md` before touching sync, merge, persistence, node
kinds, or keyboard handling** — it records invariants that were learned
from real data-loss bugs and are invisible from any single code site.

## Commands

- `npm test` — full Playwright suite (spins up `python3 -m http.server 8123`
  itself). Run it twice after changes to timing-sensitive areas; flakes are
  treated as failures.
- No build/lint step. The app runs by serving the repo root.

## Hard rules

- `main` auto-deploys to GitHub Pages on push.
- Every content mutation goes through `commit()`; pan/zoom uses
  `commit({viewportOnly:true})` and must never bump `version`.
- New node types are a `kind` on the **cards** collection, never a new
  top-level collection (deployed clients' merge would silently drop it).
- Record fields must survive a JSON round-trip; remove fields with `delete`,
  never by assigning `undefined`.
- Keep the app (and tests) network-clean until the user opts into Drive.
- Card-body HTML goes through `sanitizeHtml()`; `<img>` only with
  `data:image/` src.
- Keyboard handlers must check `onCanvas` / `editing` before intercepting
  keys — chrome focus keeps native key behavior.
- Tests: wait for `#saveState` = `saved` before reading stored content; pin
  nodes by `data-id`, not `.last()`.

## Style

Comments explain *why*, not what. Match the existing section-banner layout
in app.js and the existing test helpers (`addCardAt`, `connectTwoCards`,
`drag`) before writing new ones.
