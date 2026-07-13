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
Node ids must be unique **across devices**, not just within a session — the
merge treats same-id as the same record and would fuse two unrelated nodes —
so `newId()` ends in a random tail. Don't "simplify" it away.

### Node kinds: buttons and frames are cards

Button nodes (`kind:'button'`, with `action:{type:'node'|'url', target}`) and
frame nodes (`kind:'frame'`, with `title`, `w`, `h`, `moveContents?`) live in
the **cards collection**, not their own collections. This is deliberate:
`mergeBoards` iterates the fixed list `['cards','iframes','connections']`, and
so do export/import, undo snapshots, clipboard, and color coding. A new
top-level collection would be **silently dropped** by the merge code in every
already-deployed client during sync. Adding a new node type = a new `kind`
on cards; `renderCard()` dispatches on it.

The same applies to any new **top-level field**: `mergeBoards` rebuilds the
document from a fixed field list (`schema`, `version`, `viewport`, the three
collections), so new persistent data must live on records *inside* those
collections, never beside them.

### Docked buttons: derived x/y, still stored

A button with `attachedTo` (+ `attachOrder`) docks to a **root**: a card
(full-width bottom tray, max 3 tabs), a frame (row right of the title tab),
or a free button (horizontal menu chain). Its `x`/`y` (and tray width)
becomes **derived** — recomputed by `layoutAttachments()` from the root's
live geometry. The derived value is still written back into the record, on
purpose: clients that don't know the layout rule (older deploys, exports,
the merge) keep placing the button correctly from plain `x`/`y`. The
recompute runs inside `commit()` (so no content mutation can leave a stale
stored position), plus per-frame during drags and after full renders. It
must run even when nothing is attached — the same pass is what clears docked
styling after the last detach/orphan. `layoutAttachments()` itself never
commits; the caller's commit carries its writes in the same undo step.

Chains stay **flat**: `attachButton` re-points a drop on a docked button at
that button's root (and re-roots the dropped button's own children), so
`attachedTo` normally points straight at a root and cycles can't be built
locally. A concurrent-edit merge can still nest or loop them, so `dockRoot()`
walks with a visited set and treats a cycle as detached — never assume one
hop. Deleting a dock orphans its buttons in place (`delete attachedTo`)
rather than cascading the delete. Title-row geometry must come from
`getBoundingClientRect` + `toWorld`, not `offsetTop/offsetLeft` — those are
integers measured from the padding edge, and the frame's fractional border
visibly misaligns the row.

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
- Two sanctioned bypasses replace content wholesale and maintain `version`,
  `lastContent`, and the save themselves: `applyContentSnapshot` (undo/redo)
  and `applyPulledBoard` (sync pull/merge). Don't add a third.
- Renderers never write text into a **focused** editable — the
  `document.activeElement !== el` guards in `renderCard`/`renderButton`/
  `renderFrameNode`/`renderIframe`/`drawConnection`. A background sync pull
  re-renders mid-typing; without the guard it wipes the caret and the
  in-flight edit.
- `renderConnection` self-heals: a connection whose endpoint no longer exists
  is deleted at render time, without a commit — the deletion persists with
  whatever commit comes next.

### Board switching

`loadAndShow(id)` does **not** save the outgoing board. Every call site must
`saveCurrent()` first (`openBoard`, `createBoard`, `openFromDrive` all do), or
the outgoing board's last ≤400ms of edits are lost: the pending `scheduleSave`
timer fires after `currentBoardId`/`board` have already switched, so it saves
the *new* board and the old edits evaporate.

### Viewport is per-device, never content

Pan/zoom lives under `whiteboard:viewport:<id>`, is stripped by
`contentForStore()` from every localStorage write and every Drive write,
never bumps `version`, and is preserved (not overwritten) when a remote board
is pulled (`applyPulledBoard`). Breaking this makes every pan churn the sync
and yanks one device's view to another's. One deliberate exception:
`exportBoard()` serializes the live `board` *including* viewport — a JSON
backup restores the exact view on import.

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

Deep links: `#board=<id>` opens a board, `#node=<id>` frames a node. A
Copy-ID link pasted *back into the app* (card links, button links) is
recognized by `deepLinkNodeId()` and navigates in place — it must never
open the app in a second tab.

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
6. **Single-flight per board**: the `reconciling` Set makes overlapping
   triggers (10s tick, boot, board-switch, tab-return, tab-leave flush)
   coalesce instead of double-pushing. `refreshDriveStatus` checks it too, so
   the per-commit status refresh can't stomp the transient "syncing…/merging…"
   messages mid-reconcile.
7. **Silent reconnect only inside a user gesture**: `tryDriveSilentReconnect`
   runs when the board menu opens, never on bare page load — Google's token
   flow opens a popup the browser blocks outside a gesture. Most reloads skip
   it anyway via the sessionStorage token cache.

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
  (a scaled composited layer bitmap-blurs text); iframes render at a 1440px
  logical width scaled down.
- Node DOM is **hydrated lazily** (`pendingNodes`/`queueHydration`): boot and
  board-switch render only nodes near the viewport (half-viewport margin,
  generous size estimates for auto-sized cards); the rest materialize in
  idle chunks of 24, nearest first, and pan/zoom promotes anything that
  comes near. Connections tolerate a pending endpoint (`pathBetween` returns
  null) and draw when it hydrates. **RULE: code needing every node's
  DOM/geometry calls `hydrateAll()` first** (Tab order, spatial nav, fit,
  select-all, search lists, `frameContents`); single-target paths call
  `ensureNode(id)` (deep links/jumps), which pulls the whole dock cohort so
  a chip never appears without its card. Hydration never mutates records —
  a missed flush site shows as an unreachable node, not data loss.
- Iframes load in **tiers** (`frameViewState`/`evaluateFrameLoading`):
  `visible` (intersects the real viewport, ≥120px on screen) gets `src`
  immediately; `near` (within one viewport of an edge) goes into an idle
  queue drained ONE at a time, nearest-to-center first — the next starts
  only after the current one fires `load` (4s fallback for embeds that
  never do), inside `requestIdleCallback` (plain timeout on Safari), and
  never while the tab is hidden; `far` (or shrunk under 120px) stays a
  "click to load" placeholder. Loading is one-way — frames never unload —
  and the queue is rebuilt wholesale each evaluation, so a queued frame
  that scrolls into view just loads via the visible path instead.
  Covered by `tests/loading.spec.js`.
- The color filter/legend is **pure view state**: in-memory only, never
  committed, no version bump, per device.
- `frameNode(id)` / `selectNode` / `flashNode` are the shared navigation
  primitive — deep links, ⌘K jump, and button actions all go through them.
- Cross-file constant couplings: `GRID_INSET` (app.js) must equal
  `#grid { inset: -160px }` in styles.css (the grid phase math folds it in),
  and `visibleRect()` hard-codes the bottom chrome height (52px).
- The floating text toolbar and node picker are fixed-positioned chrome that
  re-track their card every frame. Their off-screen behavior is deliberately
  asymmetric — ease off once and freeze when the card flees; chase-and-lock
  when it returns — see the comment block above `positionTextToolbar` before
  touching it.

## Interaction model

- Selection: `selectedNodes` Set + at most one `selectedConn`. Box-select
  takes a frame node only when the box **fully encloses** it — mere overlap
  would grab the region (and drag everything with it) on almost any marquee.
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
- Iframe "interact mode" (`interactiveId`) is runtime-only state and must
  never trap the user: every canvas gesture (pan, wheel, zoom controls, ⌘K
  jump) calls `exitInteract()`. Any new gesture must too.

### Touch input (TOUCH GESTURES section in app.js)

- Everything is Pointer Events, so a finger drives the same handlers as the
  mouse — the touch layer only *re-maps roles*: one finger on empty canvas
  pans (`startPan`, with `clearOnTap` restoring tap-to-deselect), two fingers
  pinch-zoom/pan anywhere, long-press (500ms, 8px slop) synthesizes a
  `contextmenu` event, and long-press on empty canvas arms the box-select
  marquee (release-in-place opens the canvas menu instead).
- **Every window-level drag must filter by `pointerId`** (capture it at
  `pointerdown`, ignore other pointers in move/up). Without this a second
  finger steers the first finger's gesture — the jitter class of bug.
- The layer takes a finger back from an in-flight gesture by dispatching a
  **synthetic `pointercancel`** with that pointerId: every drag already
  tears down on pointercancel, so no per-gesture abort plumbing exists.
  `abortingTouch` re-entrancy flag keeps the layer from untracking its own
  synthetic cancels; consequently **new drags must register the same
  move/up/cancel trio** and treat cancel as "end without side effects
  beyond commit-if-moved".
- Pinch math is anchored at gesture start (`z0`, `d0`, world point `w0`
  under the initial midpoint): pan and zoom fall out of one equation per
  move, so there is no per-event integration drift. Distance floor 30px
  guards the ratio against adjacent fingers.
- Fingers claimed by the view (`claimedTouches`: pinch members, fired
  long-presses, 3rd+ fingers) must not click on lift — browsers still fire
  `click` after `preventDefault`ed pointerdowns, so a capture-phase click
  listener squelches clicks for 400ms after a claimed lift (else lifting a
  pinch finger over a button node would trigger navigation).
- Hover affordances (ports, resize handles) already reveal on `.selected`;
  `@media (pointer: coarse)` only grows hit targets. Don't gate features on
  hover alone.
- Tests drive this with synthetic `PointerEvent`s (`pointerType:'touch'`,
  explicit `pointerId`s) — see `tests/touch.spec.js`. Playwright cannot
  produce real multi-finger touches.

## Security boundaries

- `sanitizeHtml()` allowlists tags for card bodies (paste and load paths).
  Disallowed tags are unwrapped (children kept), except `SCRIPT`/`STYLE`
  which are dropped with their contents. `<img>` survives **only** with a
  `data:image/` src — remote image URLs are stripped (they'd be tracking
  pixels that fire on every render for every viewer of a shared board).
- Pasted images are canvas-downscaled (longest edge 1600px, WebP 0.85 with
  PNG fallback, halving until ≤ ~1.5MB) before becoming data URIs —
  localStorage quota is the whole database.
- Embed and button URLs are untrusted (a shared/imported board is authored by
  someone else). **Every URL that reaches an `<iframe src>` or `window.open()`
  must pass `safeNavUrl()` (http/https only)**. The embed iframe's sandbox
  (`allow-scripts allow-same-origin allow-forms`) does NOT cover this: with
  both `allow-scripts` and `allow-same-origin`, a `javascript:` src executes
  in *this page's* origin — stored XSS with every board in localStorage and
  the Drive token in sessionStorage. The create paths normalize via the
  modal; the load/render paths guard at the sink.
  Many real sites refuse framing (X-Frame-Options/CSP) and show blank; that's
  expected, not the guard.
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
