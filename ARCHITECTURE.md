# Architecture

An infinite-canvas whiteboard: vanilla JS, no build step, no runtime
dependencies. Three files are the whole app — `index.html` (static shell,
modals, toolbars), `styles.css`, and `app.js` (~4,000 lines, one IIFE, all
logic). `config.js` holds the Google OAuth client id + Picker API key
(origin-restricted, safe to commit — see SETUP-google-drive.md).

Deployed as static files to GitHub Pages from `main`
(https://garyridgway.github.io/conspiracy/, `.nojekyll`, no CI build).
**Every push to `main` deploys.**

This document records the invariants that are easy to break because they are
*not* visible from the code you happen to be editing. Read the section for the
area you're touching before changing it.

## Data model

One board is one JSON document:

```js
{
  schema: 1,
  version: 0,          // bumped by every commit() — the sync watermark
  viewport: {x,y,zoom},// per-DEVICE view; stripped from storage & Drive (see below)
  cards: {},           // id → { x, y, title, body, color?, kind?, ... }
  iframes: {},         // id → { x, y, w, h, src, ... }
  connections: {}      // id → { from, to, label? } — from/to are any node id
}
```

Id prefixes: cards/buttons/frames `c_`, iframes `f_`, connections `cn_`.

### Node kinds: buttons and frames are cards

Button nodes (`kind:'button'`, with `action:{type:'node'|'url', target}`) and
frame nodes (`kind:'frame'`, with `title`, `w`, `h`, `moveContents?`) live in
the **cards collection**, not their own collections. This is deliberate:
`mergeBoards` iterates the fixed list `['cards','iframes','connections']`, and
so do export/import, undo snapshots, clipboard, and color coding. A new
top-level collection would be **silently dropped** by the merge code in every
already-deployed client during sync. Adding a new node type = a new `kind`
on cards; `renderCard()` dispatches on it.

### Record shape rules (the merge depends on these)

- Records are flat objects, except fields may nest **one level** of plain
  object (e.g. a button's `action`). `valueEqual()` compares recursively by
  value, so nesting is safe — but records must survive a JSON round-trip
  identically (no Dates, no undefined-valued keys, no class instances).
- To remove a field, `delete` it (see `delete c.label`). Never assign
  `undefined` — a present-but-undefined key breaks value equality against a
  JSON-parsed copy of the same record.

## The mutation pipeline

`commit()` is the **single chokepoint** for content mutations:

    mutate board.* → commit() → version++ → recordUndo() → scheduleSave() (400ms → localStorage)
                                                        → refreshDriveStatus() ("changes pending…")

- `commit({coalesce:true})` groups a rapid burst (typing, arrow-key nudges)
  into one undo step (600ms window).
- `commit({viewportOnly:true})` is for pan/zoom only: **no version bump, no
  undo, no Drive involvement** — the viewport persists to its own local key.
- If you mutate `board.cards/iframes/connections` without calling `commit()`,
  the change won't save, sync, or undo. During drags, positions are mutated
  live and committed once on pointerup.

### Viewport is per-device, never content

Pan/zoom lives under `whiteboard:viewport:<id>`, is stripped by
`contentForStore()` from every localStorage write and every Drive write,
never bumps `version`, and is preserved (not overwritten) when a remote board
is pulled (`applyPulledBoard`). Breaking this makes every pan churn the sync
and yanks one device's view to another's.

## Persistence (localStorage)

| Key | Contents |
|---|---|
| `whiteboard:library` | array of `{id, name, mode:'device'\|'drive', driveFileId?, syncedLocalVersion?, driveVersion?, updatedAt}` |
| `whiteboard:current` | id of the open board |
| `whiteboard:board:<id>` | board content (viewport stripped) |
| `whiteboard:viewport:<id>` | this device's pan/zoom for that board |
| `whiteboard:base:<id>` | merge base: content as of the last successful sync |
| `whiteboard:drive:opted` | '1' after a real Drive connect (gates silent reconnect) |
| `whiteboard` | legacy single-board key; migrated by `ensureLibrary()` |

sessionStorage: `whiteboard:drive:tok` caches the OAuth access token so
reloads within its ~1h life reconnect without a popup.

Deep links: `#board=<id>` opens a board, `#node=<id>` frames a node.

## Drive sync

Opt-in per board (`drive.file` scope; each board is one `.whiteboard.json`
in the user's own Drive; no server anywhere). Google scripts load lazily on
first Connect — **the app and tests are network-clean until then**, and a
test asserts it.

### Batched save model

Local saves are immediate (400ms debounce → localStorage). Drive I/O is
batched: `syncTick` runs `reconcileDriveBoard(current)` every 10s
(`SYNC_POLL_MS`), and `flushPendingSync` fires on tab-hide/pagehide.
There is **no per-edit Drive push** — don't add one back; an editing session
must not hit Drive on every pause.

### Reconcile state machine (`reconcileAttempt`)

Watermarks per library entry: `syncedLocalVersion` (local `board.version` at
last sync) and `driveVersion` (Drive file version at last sync). Divergence
on either side picks the branch:

- neither changed → no-op (one cheap `getMeta`)
- only remote → **pull** (`applyPulledBoard`: replaces content, clears undo,
  keeps local viewport)
- only local → **push** via `guardedUpdate`
- both → **three-way merge** against `whiteboard:base:<id>`; no base
  (legacy/first divergence) → `#conflict-modal` prompt

Invariants that took real bugs to learn — keep them:

1. **`guardedUpdate` before every push/merge write**: re-reads Drive's
   version immediately before the PATCH and bails (`'retry'`) if it moved.
   Drive has no content-version precondition, so this is how the two-device
   clobber window stays a single getMeta→PATCH gap. The retry loop (bounded,
   3×) re-reconciles and merges — it never overwrites blind.
2. **`editedMeanwhile()` re-check** after every `await` in a branch that
   replaces the live board. The user keeps typing during network calls;
   applying a pull/merge computed against a stale `board.version` silently
   deletes those keystrokes. Return `'retry'` instead.
3. **Deep-snapshot before pushing** (push branch): `updateFile` serializes at
   fetch time, so pushing the live `board` object can send content newer than
   the recorded watermark — and then the saved base disagrees with what Drive
   actually holds, which makes a later merge resurrect stale remote values.
4. **Read meta before content** everywhere a (content, version) pair is
   recorded (see `openFromDrive`). Meta-first + a racing push = harmless
   redundant pull next tick. Content-first = "in sync" with edits you never
   saw, which a later local push then overwrites.
5. After every successful push/pull/merge: `saveBase()` + `setDriveSyncMeta()`
   with the exact content/version pair that Drive now holds.

### Merge semantics (`mergeBoards`, pure, tested)

Per collection → per record → per field, diffed against the base:
non-overlapping edits both survive; same field changed to different values on
both sides = conflict, **local wins**, counted and surfaced ("merged, N kept
this device" + notice naming the nodes); delete-vs-edit keeps the edit;
both-delete stays deleted. Exposed as `window.__wb_mergeBoards` so tests
exercise it without OAuth — keep it pure.

### Known limitations (accepted, not bugs)

- A pull/merge clears the undo/redo stacks (rebasing undo history across a
  merge is a project of its own).
- Two tabs on one device editing the same board share watermarks in
  localStorage and can confuse each other (no `storage`-event coordination).
- The on-close Drive push is best-effort (fetch may be cut); boot reconcile
  catches whatever was missed.
- `saveBase` failing on quota is swallowed; a stale base degrades merges
  toward local-wins but loses nothing.

## View layer

- `#viewport` (fixed, full-screen) → `#world` (transformed by
  `translate(x,y) scale(zoom)`). All node positions are **world coordinates**
  via `style.left/top`; `toWorld()` inverts the transform for pointer events.
- Connections are SVG paths inside `#world` (they inherit the transform);
  connection labels are HTML pills in `#world` positioned at the cubic
  bezier's t=0.5 midpoint: `(a + 3·cp1 + 3·cp2 + b) / 8`.
- Perf tricks that look like noise but aren't: the dot grid is a
  viewport-sized layer moved by sub-tile `transform` remainder (never
  `background-position` — full-screen repaint per frame); `body.panning`
  promotes `#world` to a GPU layer during pans and demotes it before zoom
  (a scaled composited layer bitmap-blurs text); iframes lazy-load only when
  on-screen and ≥120px wide, and render at a 1440px logical width scaled down.
- The color filter/legend is **pure view state**: in-memory only, never
  committed, no version bump, per device.
- `frameNode(id)` / `selectNode` / `flashNode` are the shared navigation
  primitive — deep links, ⌘K jump, and button actions all go through them.

## Interaction model

- Selection: `selectedNodes` Set + at most one `selectedConn`. Box-select
  deliberately **skips frame nodes** (any large box would grab the region and
  drag everything with it).
- Frames sit at z-index −1 with `pointer-events:none` interiors
  (`auto` on the tab/resize children) so clicks pass through to cards on top.
  "Move items with frame" carries nodes **fully inside** the frame rect,
  computed at drag start.
- Keyboard model — the load-bearing distinction is `onCanvas`
  (`activeElement` is `<body>`): on the canvas, Tab cycles nodes in reading
  order, arrows nudge (Shift=1px), Enter opens, C aims a connection
  (Tab/arrows retarget, Enter creates), Delete removes. In the chrome, all
  keys keep native meaning (Tab traverses controls). F6 hops canvas → toolbar
  → palette → zoom bar; Escape steps back toward the canvas. Modals trap Tab
  (capture-phase listener) and restore focus to their trigger on close.
  **Never intercept a key without checking `onCanvas`/`editing` first.**
- Escape is a priority chain: open modal → board menu → blur editing → blur
  chrome → exit iframe interact mode → clear selection.

## Security boundaries

- `sanitizeHtml()` allowlists tags for card bodies (paste and load paths).
  `<img>` survives **only** with a `data:image/` src — remote image URLs are
  stripped (they'd be tracking pixels that fire on every render for every
  viewer of a shared board).
- Pasted images are canvas-downscaled (longest edge 1600px, WebP 0.85 with
  PNG fallback, halving until ≤ ~1.5MB) before becoming data URIs —
  localStorage quota is the whole database.
- Embeds are plain `<iframe>`s: cross-origin isolation is the sandbox. Many
  sites refuse framing (X-Frame-Options/CSP) and show blank; that's expected.
- `config.js` values are origin-restricted client identifiers, not secrets.
  Gotcha: the API key's Website restriction must include the **bare origin**
  (`https://garyridgway.github.io/*`) — the Picker validates against the
  origin, not the `/conspiracy/` path.

## Tests

`npm test` → Playwright, Chromium only, 4 workers, against
`python3 -m http.server 8123` (real localStorage needs http). Two suites:
`tests/whiteboard.spec.js` (behavior) and `tests/usability.spec.js`
(encodes known complaints about Miro/FigJam/etc. plus keyboard/a11y and the
merge unit tests). Conventions that prevent flakes:

- Wait for `#saveState` to read `saved` before asserting on stored content
  (the 400ms debounce races you otherwise).
- Pin nodes by `data-id` — `.last()` locators re-resolve when later nodes
  appear.
- After flying the viewport (jump/button/deep link), `#fitContent` before
  interacting with something that may now be off-screen.
- No Google script may load before the user clicks Connect (asserted).
- Merge logic is tested through `window.__wb_mergeBoards` — no OAuth needed.
- `test.fixme()` entries are specs for known gaps, not broken tests.

## Conventions

Comments explain *why* (constraints, rejected alternatives), section banners
(`════`) split app.js; match them. No frameworks, no build step, no runtime
deps — additions must justify themselves against "one file, view-source
debuggable". Icons are self-hosted SVGs applied via CSS masks
(`-webkit-` longhands, not the shorthand).
