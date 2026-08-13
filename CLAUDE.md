# Infinite Whiteboard

Vanilla JS infinite-canvas whiteboard with optional Google Drive sync.
No build step, no frameworks, no runtime dependencies: `index.html` +
`styles.css` + `app.js` (one IIFE, section banners) are the whole app.

**Read `ARCHITECTURE.md` before touching sync, merge, persistence, node
kinds, or keyboard handling** — it records invariants that were learned
from real data-loss bugs and are invisible from any single code site.

**Use `MAP.md` to navigate `app.js` instead of reading it end to end** — it
lists every section with a one-line gist and a unique grep marker
(`grep -n '//  PORTS' app.js`). Generated; see Commands.

## Commands

- `npm test` — full Playwright suite (spins up `python3 -m http.server 8123`
  itself). Run it twice after changes to timing-sensitive areas; flakes are
  treated as failures.
- `npm run test:<bucket>` — one feature area while iterating (~4s vs ~33s).
  Buckets: `canvas` `cards` `connections` `frames` `buttons` `boards` `nav`
  `select` `undo` `chrome` `a11y` `dock` `touch` `docs`. Every test carries a
  Playwright `tag:`; tag new tests (cross-cutting tests take two tags).
  Buckets are for iteration only — the FULL suite still gates every commit.
- `npm run map` — regenerate `MAP.md` + the `ARCHITECTURE.md` contents from
  the `app.js` section banners. Run it after adding, removing or retitling a
  section; the `@docs` tests fail while either is stale.
- No build/lint step **for the app** — it runs by serving the repo root, and
  nothing in `tools/` runs at load or deploy time. `tools/` holds developer
  tooling only (doc generation, `bench-commit.mjs`), so it is not the build
  step this rule forbids.
- `node tools/bench-commit.mjs` — per-keystroke commit cost against boards up
  to the storage ceiling. Needs the dev server on :8123; not part of `npm
  test`. Re-run before re-litigating the undo-snapshot cost (ARCHITECTURE.md →
  Deferred optimizations).

## Hard rules

- `main` auto-deploys to GitHub Pages on push.
- Every content mutation goes through `commit()`; pan/zoom uses
  `commit({viewportOnly:true})` and must never bump `version`.
- New node types are a `kind` on the **cards** collection, never a new
  top-level collection (deployed clients' merge would silently drop it).
- Record fields must survive a JSON round-trip; remove fields with `delete`,
  never by assigning `undefined`.
- Keep the app (and tests) network-clean until the user opts into Drive.
- Card-body HTML goes through `sanitizeHtml()`; `<img>` only as a
  `data-asset` reference or with a `data:image/` src. Image *bytes* live in
  IndexedDB, never in the board JSON — referenced by an image node's
  `asset` field or a card body's `data-asset`, and **both spellings must
  stay in `ASSET_REF_RE`**: the boot GC reaps what it can't see.
- Keyboard handlers must check `onCanvas` / `editing` before intercepting
  keys — chrome focus keeps native key behavior.
- Tests: wait for `#saveState` = `saved` before reading stored content; pin
  nodes by `data-id`, not `.last()`.

## Style

Comments explain *why*, not what. Match the existing section-banner layout
in app.js and the existing test helpers (`addCardAt`, `drag`) before
writing new ones.
