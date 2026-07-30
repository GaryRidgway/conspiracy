# Architecture

An infinite-canvas whiteboard: vanilla JS, no build step, no runtime
dependencies. Three files are the whole app — `index.html` (static shell,
modals, toolbars), `styles.css`, and `app.js` (~6,600 lines, one IIFE, all
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

### Node kinds: buttons, frames and images are cards

Button nodes (`kind:'button'`, with `action:{type:'node'|'url', target}`), frame
nodes (`kind:'frame'`, with `title`, `w`, `h`, `moveContents?`) and image nodes
(`kind:'image'`, with `asset`, `w`, `h`, `title?`) live in
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

Adding a kind means touching more than `renderCard()`. `CARD_KIND_LABEL` is the
one place that names a kind for the node picker, ⌘K and the context menu's
Delete item, so a kind that forgets it reads as "Card" everywhere. What a kind
does NOT need is a place in `mergeBoards`, undo, clipboard, color coding, dock
membership or `frameContents` — those are all kind-blind, which is the whole
payoff for staying inside the cards collection.

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

### Pinned nodes: chrome, not canvas

A record with `pinned` (epoch ms — doubles as the dock's sort order) renders
as a chip in `#pin-dock`, hugging the top of the tool palette, instead of on
the canvas.
The field is shared content (syncs/merges like any field), so pins follow
the board to every device. Invariants:

- **Only kinds in `PINNABLE_KINDS` pin** (currently just `button`). The pin
  machinery is kind-agnostic on purpose; widen the set one kind at a time.
- **`isPinned()` = flag AND allowlist.** A record whose kind leaves the
  allowlist instantly renders back on canvas at its stored `x`/`y`;
  `healPins()` (run on `renderAll`, i.e. board load) then strips the stale
  flag from the data.
- **Pinning never touches `x`/`y`** — that's what makes the heal (and older
  deploys, which ignore the unknown field and just render the node) safe.
- **A pinned node has NO canvas presence**: it never enters `nodeEls` or
  `pendingNodes`. That single property is what exempts it from marquee, Tab,
  spatial nav, fit, search lists, frame-carry, and copy — all of which key
  off `nodeEls`. Don't special-case pinned ids in those systems; keep the
  exemption at the render layer (`renderAll`/`reconcileToBoard`/
  `renderNodeNow` skip, reconcile removes the el when the flag appears).
- Arrows to a pinned endpoint hide (`drawConnection` collapses on a null
  path) but the connection records survive for the unpin.
- Pinning detaches (`attachedTo` is deleted first); `setButtonAction`
  re-renders the dock, not the canvas, for pinned ids.
- **Chips are button nodes visually**: same markup and `.btn-node` classes
  (plus `.pin-chip` layout overrides), `applyNodeColor` for color coding —
  only behaviors differ (no ports/drag/selection). The chip and canvas
  context menus share `buttonMenuItems()`; chip-only extras (Unpin,
  Duplicate/Copy/Cut, swatches, Delete) call the id-taking cores
  (`duplicateNodes`, `copyNodes`, `setNodesColor`) — never the
  selection-based wrappers, which can't see pinned ids.

### Docked frame window (`#dock-panel`, DOCKED FRAME WINDOW section)

Frames can dock to the right edge as **tabs sharing one second window into
the same world** — bespoke work areas with per-tab pan/zoom. The invariants:

- **Exclusive model**: while docked, a region's nodes render in
  `#dock-world` instead of `#world`. The frame itself leaves the canvas
  entirely (`.frame-docked` is `visibility: hidden` — not display, so its
  tab rect stays measurable for docked-button layout). A node still has
  exactly ONE element; `nodeEls` stays a single map. Never render a node
  in both. Inactive tabs' members stay parented in the panel with
  `.dock-stowed` (also visibility) — hidden but measurable.
- **One shared coordinate space.** Both windows view the same world units;
  only the transform differs. All screen→world conversions go through
  `ctxToWorld(ctx, x, y)` / `pointerWorld(e)` (which picks the window under
  the pointer). This is what makes cross-window drags work: the drag delta
  is world-space, so dropping over the other window just lands there —
  never mix `getBoundingClientRect` with the wrong window's transform.
  Movers reparent live when the pointer crosses, so the ghost follows.
- **Never measure a panel node for layout without checking it has a box.**
  `#dock-panel` is `display: none` while hidden or minimized, so everything
  inside measures 0 — and `renderAll` renders nodes BEFORE `syncDockPanel()`
  un-hides the panel. `layoutFrame` scaled an embed by `wrap.clientWidth / lw`,
  which made every embed in a docked frame boot at `scale(0)`: a blank box with
  `loaded` already set, so not even the placeholder showed, and nothing
  re-measured it. It now bails on a zero box and a `ResizeObserver`
  (`frameWrapResize`) re-runs the layout when a box appears — which covers boot,
  un-minimize, and any future render-order change without depending on one.
- **Membership is STICKY, not geometric.** Each docked frame carries an
  explicit member list on its OWN card record (`dockMembers` — real, synced
  content, like any other field): seeded center-in-rect when the frame
  docks, then changed ONLY by gestures — drop over the panel joins the
  active tab, drop over the canvas leaves, panel-menu creations/pastes
  join, duplicates of members follow their source, and docked-button
  assemblies follow their root. **The drop/creation position is law** — the
  panel is a free work surface, so members may live outside the frame's
  rect; never clamp placements to the region. Geometry must never silently
  reassign: the docked region's canvas ghost is invisible, so a node
  created on the canvas over those world coordinates must NOT vanish into
  the panel. The one geometric rule left: reconcile (undo/remote — never
  commit) prunes members a full region-size beyond the rect — reverted
  cross-window drags, not deliberate placements. Presence of `dockMembers`
  (even `[]`) on a `kind:'frame'` card IS "this frame is docked" — absence
  means undocked; remove with `delete`, never assign `undefined` (same rule
  as any other field — see Record shape rules below).
- **Split between synced content and per-device chrome.** Which frames are
  docked, and their membership, is board content — it merges per-record/
  per-field exactly like any other card field (non-overlapping edits to
  different frames' `dockMembers` both survive; the same frame's membership
  edited on both sides is a conflict, local wins, surfaced in merge review
  like any other field conflict) and rides undo via the normal content
  snapshot. Active tab, minimized state, panel width, and each tab's own
  pan/zoom are ephemeral per-device arrangement — `{width, minimized,
  active, tabs: [{frameId, viewport}]}` rides `whiteboard:viewport:<id>`,
  never touches board content, never bumps `version`, never syncs, and
  restoring it on every ⌘Z would yank the panel around unrelated undos.
  `deriveDockTabs(prevDock)` is the single place that reconciles the two:
  given whatever `board.cards` currently says is docked, it rebuilds
  `dock.tabs`, preferring `prevDock`'s existing tab order/viewport/chrome
  for tabs that still qualify and defaulting fresh ones. It runs after
  every full or partial board replacement (boot, board-switch, undo/redo,
  Drive pull/merge) via `reconcileToBoard`, so a frame's dock survives a
  race where local content briefly lagged Drive — there's no separate
  "restore once at load" step to race against. `migrateLegacyDockMembers`
  is a one-time upgrade path: it adopts a device's pre-existing per-device
  membership into `dockMembers` the first time a frame lacks the field.
- Arrows: both ends in one window → that window's SVG (`#dock-connections`
  vs `#connections`, entries move via appendChild); one end each →
  hidden, records intact. `url(#…)` marker refs resolve document-wide.
- While docked a frame can't move or resize (its rect anchors its tab's
  contents); undock first. Deleting it (or losing it to undo/remote merge)
  closes its tab — `deriveDockTabs` just won't find `dockMembers` on it
  anymore; the last tab closing hides the panel.
- **Undocking moves the region, not the camera** (`landRegionInView`). The
  panel has its own pan/zoom, so a frame's world position is usually far
  from wherever the canvas is looking; handing it back at those coordinates
  put it off screen, which read as the contents vanishing. The frame grows
  to enclose its members, then frame and members translate by ONE delta to
  the centre of `visibleRect()` — rigid, so relative layout and every
  internal arrow survive. It then zooms out if the region overflows the
  view, never in. Skipped entirely when the frame is already fully visible:
  no point dirtying content to nudge what the user is looking at. Same
  bargain as `unpinNode`, and the same cost — position becomes a per-device
  artifact that syncs, so another device sees the region jump. The move is
  content and rides undock's own `commit()` as one undo step; the zoom is
  view-only through `setMainViewport`. The member list comes from the
  `dockMembers` INDEX, not the stored array: the array omits buttons
  attached to a member, which still have to travel.
- Main-canvas geometry consumers exclude members: fit, marquee (per-window
  via `ctx`), `findSnapTarget` (same-window only). `frameViewState`
  treats panel embeds as visible while open, far while minimized.
  Navigation (`frameNode`) into a member pans the PANEL.
- Reparenting an `<iframe>` element reloads its page — embeds crossing the
  boundary (or dock/undock of a region containing them) reload. Inherent
  browser behavior; accepted, but not silent: `markIframeReloading()` runs
  before the move and re-shows the placeholder until `load` fires (4s
  bail-out, as some pages never fire it). Without it the element stays
  `.loaded` over a blank box and the embed reads as having disappeared.

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

Deleting a board (`removeBoard`, behind the typed-DELETE modal) removes it
from this device only: a Drive-mode board's file survives in Google Drive
and can be re-opened; a device board is gone with no undo. The modal's note
text states whichever applies.

### Viewport is per-device, never content

Pan/zoom lives under `whiteboard:viewport:<id>`, is stripped by
`contentForStore()` from every localStorage write and every Drive write,
never bumps `version`, and is preserved (not overwritten) when a remote board
is pulled (`applyPulledBoard`). Breaking this makes every pan churn the sync
and yanks one device's view to another's. One deliberate exception:
`exportBoard()` serializes the live `board` *including* viewport — a JSON
backup restores the exact view on import.

The same rule covers preferences: `whiteboard:settings` (the cog panel —
`flyTo`, …) is per-device, loaded once at boot, and never synced or merged.
A new preference must be a field on the `settings` object, **never** a board
field — deployed clients' `mergeBoards` would drop it or churn `version` on
every toggle.

## Persistence (localStorage)

| Key | Contents |
|---|---|
| `whiteboard:library` | array of `{id, name, mode:'device'\|'drive', driveFileId?, driveFolderId?, driveAssetsFolderId?, syncedLocalVersion?, driveVersion?, updatedAt}` |
| `whiteboard:current` | id of the open board |
| `whiteboard:board:<id>` | board content (viewport stripped) |
| `whiteboard:viewport:<id>` | this device's pan/zoom for that board |
| `whiteboard:settings` | per-device preferences (`flyTo`, …) — never synced, never merged, never board content |
| `whiteboard:base:<id>` | merge base: content as of the last successful sync |
| `whiteboard:drive:opted` | '1' after a real Drive connect (gates silent reconnect) |
| `whiteboard` | legacy single-board key; migrated by `ensureLibrary()` |

sessionStorage: `whiteboard:drive:tok` caches the OAuth access token so
reloads within its ~1h life reconnect without a popup.

IndexedDB `whiteboard` → object store `assets`: pasted image bytes, keyed by
asset id (see *Image assets*). The only data the app keeps outside
localStorage.

### Image assets (IndexedDB `whiteboard` → `assets`)

An image's bytes live in IndexedDB as a Blob under a random `a_…` id. Two things
reference one: an **image node** (`kind:'image'`) holds the id in its `asset`
field, and a **card body** holds `<img data-asset="ID">` with **no src**.
`hydrateImageNode()` / `hydrateAssets()` supply an object URL at render time and
`sanitizeHtml()` strips it again on the way back into the record. That round trip
is what lets the sanitizer's src allowlist stay `data:image/`-only even though
every rendered image carries a `blob:` src — nothing but `data:` ever enters
stored HTML.

**Both spellings have to stay in `ASSET_REF_RE`**, the single regex that answers
"is this asset still referenced". It scans serialized content rather than parsed
records (cheap across every board on disk), so it matches `"asset":"a_…"` and the
escaped `data-asset=\"a_…\"`. Miss one and the boot GC reaps live pictures; it
also feeds `pushDriveAssets`/`pullDriveAssets`, so a miss there strands bytes.

Why the bytes left the board JSON: base64 costs ~1.33 bytes per image byte
against a ~5 MB localStorage quota, and a Drive board paid it twice (the local
content cache plus the merge base). Three large screenshots could exhaust a
board's whole storage, and it surfaced only as `save failed` at paste time.

- **Ids are random, not content hashes.** Hashing would dedup identical pastes
  but needs `crypto.subtle`, absent on a plain-http LAN origin. The only
  property the merge depends on is that an id's bytes never change, which
  random ids give for free. `extractInlineImages` dedups within its own pass.
- **Writes settle on the transaction, not the request.** A quota failure aborts
  the transaction *after* the request has reported success — resolving early
  reports a stored image that isn't there.
- **Object URLs are cached and never revoked.** A card body re-renders on every
  pull, merge and undo, and a revoked URL renders as a broken image.
- **A missing asset is a normal state, not an error**: a board can arrive
  before its bytes, or the store can be evicted. It renders as
  `.asset-missing`, sized from the image node's stored box (or the img's
  `width`/`height` attributes) so the layout doesn't jump when the bytes land.
- **Nothing the user does re-encodes stored bytes.** An image node's `w`/`h` are
  a display box, independent of the asset's pixels, and `shape` is a mask over
  it. Since an id's bytes are immutable and Drive copies are never reaped, a
  resize or crop that re-encoded would have to mint a new id and strand the old
  bytes on every device that has them. So every image edit is presentational,
  and reversible for free.
- **Shape geometry lives in CSS, not JS**: one `--clip` per shape keyed on
  `data-shape`, inherited by both the node's `.image-clip` and the context
  menu's preview chips. Two consumers, one definition — a chip can't advertise a
  shape the node won't draw. `IMAGE_SHAPES` is the closed set of keys allowed to
  reach the DOM, since board content is untrusted.

#### Crop: two rects, one derived field

`crop` is a source rect in 0..1 of the asset (absent = the whole picture). It
maps onto the node box, so the `<img>` is sized as a multiple of that box and
offset by the rect's origin — all percentages, which is why a later resize
rescales the framing with no JS at all.

Crop *mode* is modelled as two rects: the node box is a **window**, and the
**ghost** (`cropGhost`, runtime-only) is where the whole picture would sit if the
window showed all of it. `crop` is re-derived from the pair on every frame, and
each gesture moves exactly one of them:

| Gesture | Moves | So that |
|---|---|---|
| handle drag | the box | the edge you pull is the *only* edge that moves |
| drag inside / arrow keys | the ghost | the picture slides, the node stays put on the board |

`clampCropBox` keeps a handle drag inside the picture by bounding the **size** to
the room left between the *anchored* edge and the ghost, then placing the box from
that anchor. Bounding against the ghost's full width instead lets the box grow
past the anchor and be shoved back inside — so overshooting the picture dragged
the opposite edge out with the cursor and walked it home on the way back, which
reads as the crop snapping to where it started and can't be undone without
releasing the button.

**The modifier does opposite things in the two modes, because the defaults are
opposite.** Resizing holds the proportions and Shift/Ctrl/Cmd releases them;
cropping is free and the same keys constrain it — to `IMAGE_SHAPES[].ratio`, the
box aspect at which the current mask comes out *regular*. That ratio is **not 1
for every shape**: the clip polygons are percentages of the box, so an
equilateral triangle (and a regular hexagon, by the same construction) is √3/2 as
tall as it is wide. Both rules are expressed as one `lockAspect(ev, dir, aspect)`
hook returning a ratio or null, so "which key means what" lives with the node
type instead of inside the shared resize. When a locked drag hits the ghost's
edge, `clampCropBox` shrinks **both** dimensions by one factor — clamping the
overshooting side alone would break the very ratio the key is holding.

There is deliberately **no accept step**: every crop drag is an ordinary
`commit()`, so undo walks back through them and nothing is provisional. Escape,
Enter and a click away only leave the mode. The ghost is derived *once* on entry
— re-deriving per frame would chase the box being dragged — so any wholesale
content replacement invalidates it, and `exitCrop()` sits at the top of
`reconcileToBoard()` to cover undo, import, pull, merge and board switch at once.

Two things guard the mode, both learned from it dropping out mid-drag:

- **A gesture owns the mode until it ends** (`cropBusy`, set by `startCropPan`
  and by `makeBoxResizable`'s `onStart`/`onEnd`). Every hook in a crop drag reads
  `cropId` per frame, so anything that exited the mode mid-gesture converted that
  same drag into a plain resize under the user's hand — the box scaling the
  picture instead of cropping it, halfway through. A press outside the node
  clears the flag unconditionally, so a lost pointerup can't strand the mode.
- **The ghost layer takes pointer events**, and dragging it pans. With
  `pointer-events: none` it was an invisible hole exactly where you reach when
  you want *more* of the image: the press fell through to `#world`, whose
  handler starts a box-select, and the document-level "clicked away" listener
  exited the mode. It is also skipped in `nodeVisualGeom`, or Fit and fly-to
  would frame a region that vanishes on Escape.

The shape mask stays **on** while cropping: it's the framing for that shape that
the user is choosing. The window's masked-off corners fall through to the dimmed
ghost behind, which is exactly what's being cut away.

The image node has **no CSS border** for this reason: a border insets the clip
box (and with it the `<img>` the crop positions) by a pixel per side, which both
skews the crop and leaves a visible seam between the ghost and the window. Every
ring on it is a `box-shadow`, painted outside the box.

**Depth is a `drop-shadow` one element out from the mask.** A `box-shadow` only
knows the node's rectangle, so a circle or a transparent PNG got a hard-edged
rectangle behind it; a `drop-shadow` traces the alpha of what is actually painted
— the crop window (the `overflow: hidden` clip *does* reach the filter's input),
the shape mask, and the picture's own transparency. It needs its own element,
`.image-shade` wrapping `.image-clip`, because **filters paint before clipping**:
put both on one element and the clip cuts the shadow away to nothing. Only the
picture may live inside the shade — wrap the handles or the bar and the silhouette
is a rectangle again. Collapsing those two divs is a silent regression (no shadow
at all), so a test asserts the nesting and that `.image-clip` carries no filter of
its own. The shadow is off while cropping, where it would land on the ghost
instead of the board and read as grime rather than lift. The **rings stay
rectangular** on purpose: they mark the box the handles resize, which is a
rectangle even when the picture is a star.
- **Data URIs still exist at exactly two boundaries** — a board written before
  the asset store (hoisted by `migrateInlineImages` *after* first paint,
  version-bumped like `migrateLegacyDockMembers` and deliberately not a
  `commit()`, since an undo step would put the base64 straight back), and JSON
  export (`inlineAssetsForExport`, because an export is opened on a machine
  with no store of ours). Import (`extractInlineImages`) reverses both.
  An exported image node carries `assetData` beside its `asset`; import prefers
  bytes it already has under that id and otherwise decodes `assetData` under a
  fresh one. An image node whose bytes are missing exports with its reference
  **dangling rather than dropped** — deleting the node would silently take its
  position and its connections too, where a placeholder says what happened.
- **GC runs only at boot** (`collectUnusedAssets`): undo history references
  assets the live board has dropped, and the undo stacks are empty before the
  first edit. It counts `whiteboard:base:*` as references too — a base is what
  lets a merge resurrect a deleted card, so reaping its image would turn
  "merged" into "merged, but the picture is gone" — and skips anything younger
  than `ASSET_GC_GRACE_MS`.
- Browser storage is **evictable** by default; `ASSETS.persist()` asks for an
  exemption at boot. It's a request, not a guarantee, which is why a large
  image library still wants its Drive copy.

### Storage pressure (`checkStoragePressure`, settings meter)

Two stores with different ceilings and — the part that's easy to get wrong —
**different advice**. Keep them separate; a single blended number can't support
either message.

| Pressure | Ceiling | Advice |
|---|---|---|
| Board text (localStorage) | fixed ~5 MB | export or delete a board. **Never Drive** |
| Images (asset store) | origin quota, vast | — |
| Images, device-only, not persisted | not a limit at all | save to Drive |
| Whole origin near quota | `estimate()` | export, or delete images |

**Drive does not relieve localStorage.** A Drive board caches its content *and*
a merge base there, so connecting spends *more* of that budget, not less. A
warning that suggests Drive for board-text pressure is actively wrong, and a
test asserts the message never says the word.

The image warning is about **durability, not capacity**: browser storage is
evictable, so a big local-only library is one the browser may clear. Once the
board is on Drive the local copy is a cache — losing it costs a download — so
that board is deliberately *not* warned. Checked at boot and after every image
paste, at most one warning per session (the latch is set when something is
*said*, not when the check runs, so a quiet boot doesn't silence a later paste).

Deep links: `#board=<id>` opens a board, `#node=<id>` frames a node. A
Copy-ID link pasted *back into the app* (card links, button links) is
recognized by `deepLinkNodeId()` and navigates in place — it must never
open the app in a second tab.

## Drive sync

Opt-in per board (`drive.file` scope; no server anywhere). Google scripts load
lazily on first Connect — **the app and tests are network-clean until then**,
and a test asserts it.

### Folder layout

A Drive board is a **folder**: the `.whiteboard.json` at its top level and an
`assets` subfolder of image blobs. `driveFileId` still names the JSON file, and
that is the point — every watermark, guarded write and merge path below is
identical to what it was when a board was a bare file.

- **A legacy flat board is migrated by moving its file**, not by copying it:
  `ensureDriveLayout` creates the folder beside the file and re-parents it, so
  the file id (and therefore every sync watermark) survives. The move **bumps
  the file's Drive version**, which must be recorded — otherwise the next tick
  reads a phantom remote change and pulls, and a pull clears the undo stacks.
  Same reason a rename records its version now.
- Layout resolution runs **before** the `getMeta` in `reconcileAttempt`, for
  exactly that reason: a version read taken before the move is already void.
- **Adopt an existing folder, never create a second one.** A board opened from
  another device is already in a folder; the marker is an `assets` sibling.
  `findBoardFolder` distinguishes `'none'` (listable, not ours — a move is
  authorized) from `'blocked'` (couldn't see the parent, e.g. a file shared to
  us alone — do nothing, since guessing would strand the other device's
  assets).
- **Assets go up before the JSON, and come down after it.** Uploading first
  means Drive never holds a board whose references dangle; the worst case is an
  orphan nobody points at. Downloading after means a placeholder fills in
  instead of one slow image holding the whole board back.
- **Assets need no merge.** An id's bytes never change, so "is it there yet" is
  the only question. `pullDriveAssets` is therefore also called on the
  *in-sync* branch — a board just opened from Drive is version-equal but has no
  bytes yet, and that branch is where it lands.
- **Nothing in asset sync may break content sync.** Every call site logs and
  carries on. A board with missing images renders placeholders, which is
  supported; a board that won't sync is not.
- **Remote assets are never deleted.** Uploading before the JSON creates a
  window where an asset on Drive is referenced by a board revision nobody has
  pushed yet, so any eager "delete what's unreferenced" can destroy another
  device's image. Unreferenced blobs accumulate in a folder the user rarely
  opens; that's the accepted cost.
- A board with no images makes **zero extra Drive calls** — both directions
  compute their work set first and skip the folder listing when it's empty.

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
   never runs on bare page load — Google's token flow opens a popup the browser
   blocks outside a gesture. Most reloads skip it anyway via the sessionStorage
   token cache. It rides the FIRST discrete input instead (`pointerdown` /
   `keydown`, armed at boot for an opted-in user), because hanging it off the
   board menu alone left a returning user's board silently unsynced —
   `syncTick` bails on `!isConnected()` — until they opened a dropdown they had
   no reason to open. Three constraints on any change here:
   - Only **discrete** input grants transient activation. `mousemove`, `wheel`,
     `scroll` and `focus` grant none, so widening to them would reproduce the
     blocked popup this rule exists to avoid.
   - Skip **modifier-only** keydowns (`Shift`, `Control`, …). Chrome grants no
     activation for them, and Shift+Tab is a keyboard user's opening keystroke —
     firing on the Shift half spends the attempt on a press that cannot succeed.
   - Keep the event set **minimal**. `pointerdown` covers mouse, touch and pen,
     and `contextmenu` is preceded by its own `pointerdown`; adding `pointerup`
     or `contextmenu` makes one user action fire the hook twice, which after a
     failure spends two retries on a single click.

   `RETRYABLE_AUTH_ERRORS` separates "the request never reached Google"
   (`popup_failed_to_open`, re-arm and retry, bounded by
   `MAX_SILENT_ATTEMPTS`) from a definitive answer (`consent_required`,
   `access_denied` — only the Connect button can fix it, so stop asking).
   Boot also calls `DRIVE.warmup()` for an opted-in user: it loads the Google
   script *without* asking for a token, so the gesture's ~5s activation window
   isn't spent on a cold cross-network fetch. Warmup is gated on
   `whiteboard:drive:opted`, which is what keeps the network-clean guarantee —
   and the test asserting it — intact.
8. **One resolver slot per `connect()`, not a closure**: the GIS token client is
   created once, so its `callback`/`error_callback` must read `pendingAuth` at
   fire time. Closing over the first call's `resolve`/`reject` left every LATER
   `connect()` pending forever: one failed silent reconnect and the Connect
   button hung disabled for the rest of the page's life, which read as "Drive
   just doesn't connect."

### Merge semantics (`mergeBoards`, pure, tested)

Per collection → per record → per field, diffed against the base:
non-overlapping edits both survive; same field changed to different values on
both sides = conflict, **local wins**, counted and surfaced ("merged, N kept
this device" + notice naming the nodes); delete-vs-edit keeps the edit;
both-delete stays deleted. Exposed as `window.__wb_mergeBoards` so tests
exercise it without OAuth — keep it pure.

Each conflict also carries `alt` — the record as the OTHER side would have
resolved it (swap the args to `mergeRecord` to flip every tie), undefined
meaning "the alternative is the delete" — plus `keptSide`. The notice's
Review button opens the merge-review panel (`openMergeReview`, test hook
`window.__wb_openMergeReview`), which snapshots kept-vs-alt per record and
flips them via plain content commits: local-wins stays the default, but it
is REVERSIBLE (and undoable) after the fact. There are still no per-record
timestamps — "which is newer" is unknowable across devices; the panel shows
both versions instead of guessing.

The panel is non-modal and has no auto-dismiss, so it can sit open across
later sync ticks. Its `kept`/`alt` are snapshots taken at open time — if a
later pull/merge lands while it's still open (`board` gets fully replaced;
see Board switching), those snapshots no longer reflect the live record.
`applyMergeChoices` guards against this with a `mergeReviewVersion`
watermark (`board.version` at open, rebased after each of the panel's own
commits): a version drift it didn't cause means something else changed the
board meanwhile, so it closes the panel instead of applying a stale choice
over whatever just arrived. Without this, flipping a choice on a stale panel
silently overwrote newer synced content with no conflict raised for it.

### Known limitations (accepted, not bugs)

- A pull/merge clears the undo/redo stacks (rebasing undo history across a
  merge is a project of its own).
- Two tabs on one device editing the same board share watermarks in
  localStorage and can confuse each other (no `storage`-event coordination).
- The on-close Drive push is best-effort (fetch may be cut); boot reconcile
  catches whatever was missed.
- `saveBase` failing on quota is swallowed; a stale base degrades merges
  toward local-wins but loses nothing.
- A board **shared** to another user grants `drive.file` on the picked JSON
  only, so that user's app can't list the board's `assets` folder — their
  images render as placeholders. Sharing the *folder* is the fix, and it needs
  the Picker to offer folders (see `ROADMAP.md` → *Drive sharing*).
- Unreferenced blobs are never reaped from Drive (see *Folder layout*).

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
  Framing measures `nodeVisualGeom` (border box ∪ overflowing visible
  children), not `nodeGeom` — a frame's title tab rides above its box and
  would otherwise tuck under the top toolbar at high zoom.
- Main-canvas jumps land through `setMainViewport(x, y, zoom)`, which glides
  when `settings.flyTo` is on (eased camera flight; any wheel/pointerdown
  cancels it; `prefers-reduced-motion` and hidden tabs cut instantly). A
  flight mutates only `board.viewport` and both landing and cancelling end
  in `commit({viewportOnly:true})` — it must **never** bump `version`.
  Don't assign `board.viewport` directly for a jump; that reintroduces the
  hard-cut inconsistency `resetView` once had.
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
  (Tab/arrows retarget, Enter creates), E cycles the selected node's
  connections (Shift+E backward; Enter labels the highlighted one, Escape
  steps back to the node), M / Shift+F10 / ContextMenu open that node's (or connection's)
  context menu, Delete removes. In the chrome, all keys keep native meaning
  (Tab traverses controls). F6 hops canvas → toolbar → palette → zoom bar;
  Escape steps back toward the canvas. Modals trap Tab (capture-phase
  listener) and restore focus to their trigger on close.
  **Never intercept a key without checking `onCanvas`/`editing` first.**
- Selecting a connection by keyboard (E) keeps its anchor node in
  `connCycleFrom`, not in `selectedNodes` — `selectConn` clears the latter.
  The anchor is re-derived from the live connection if it goes stale, so it
  needs no separate invalidation. The keyboard context menu
  (`openMenuForSelection`) reuses `onCanvasContextMenu` via a synthetic
  event, so menu items live in exactly one place regardless of trigger.
- Escape is a priority chain: open modal → board menu → blur editing → blur
  chrome → exit image crop → exit iframe interact mode → clear selection.
- Iframe "interact mode" (`interactiveId`) is runtime-only state and must
  never trap the user: every canvas gesture (pan, wheel, zoom controls, ⌘K
  jump) calls `exitInteract()`. Any new gesture must too.
- Image "crop mode" (`cropId`) is the other runtime-only mode, and it is entered
  by **Enter** — so the keys that do something else inside it have to be worth
  it: the arrows pan the crop rather than nudging the node, which is both the
  only pointer-free way to crop and the only way to stop a nudge from sliding
  the box out from under the ghost its crop is measured against.

### Accessibility: known limitations (deliberate, scoped)

The keyboard model above makes every *action* reachable without a pointer
(select, nudge, connect, select/label an arrow, open the context menu,
delete). What remains unshipped — recorded here so it's a decision, not a
surprise:

- **Nodes have no screen-reader object semantics.** A card is a bare
  `div.node.card` holding an unlabeled `contenteditable`; selection is a
  visual `.selected` class plus an `aria-live` `announce()`, which a
  *virtual-cursor / browse-mode* user (arrowing the document, not driving the
  app's own keys) never encounters — to them the canvas is undifferentiated.
  The honest fix is a real object model: `role="group"` +
  `aria-label` (the node's title) + `aria-roledescription` ("card" /
  "frame" / "button") per node, and connections exposed likewise. That's a
  render-layer change touching every `renderCard`/`renderIframe`/
  `renderConnection` path and the selection model, not a patch — scoped out
  deliberately rather than half-added.
- **Resize is pointer-only.** Node/frame resize handles and the dock-panel
  width splitter (`#dock-resizer`) have no keyboard equivalent. A keyboard
  resize (e.g. a mode where arrows grow/shrink, à la Shift+Alt+arrows) would
  be a new interaction to design, not a wiring gap.
- **Shortcuts aren't machine-discoverable.** The single-key actions (C, E,
  M, F6, the ⌘-combos) are documented in the help panel (`?`) but not
  surfaced as `aria-keyshortcuts` on the relevant chrome, so assistive tech
  can't enumerate them. Additive when wanted.
- **E requires a node first.** Connection selection is anchored to a
  selected node by design (targeted, quiet on dense boards); there is no
  global "cycle every connection on the board" key. If a connection is
  wanted with no obvious owning node, select either endpoint and press E.

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
  which are dropped with their contents. `<img>` survives **only** as a
  `data-asset` reference or with a `data:image/` src — every other src,
  including the `blob:` one the renderer puts on live images, is stripped.
  Remote image URLs would be tracking pixels firing on every render for every
  viewer of a shared board.
- Pasted images are canvas-downscaled (longest edge 1600px, WebP 0.85 with
  PNG fallback, halving until ≤ ~1.5MB) before going to the asset store — see
  *Image assets* for why they are not data URIs any more.
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
`python3 -m http.server 8123` (real localStorage needs http). Suites:
`tests/whiteboard.spec.js` (behavior) and `tests/usability.spec.js`
(encodes known complaints about Miro/FigJam/etc. plus keyboard/a11y and the
merge unit tests), plus feature suites `dock`, `pin`, `touch`, `loading`,
and `merge-review`. Every test carries a feature-area tag (`@canvas`,
`@connections`, …) — `npm run test:<bucket>` runs one area while iterating;
the full suite still gates every commit. Conventions that prevent flakes:

- Wait for `#saveState` to read `saved` before asserting on stored content
  (the 400ms debounce races you otherwise).
- Pin nodes by `data-id` — `.last()` locators re-resolve when later nodes
  appear.
- After flying the viewport (jump/button/deep link), `#fitContent` before
  interacting with something that may now be off-screen.
- No Google script may load before the user clicks Connect (asserted).
- Merge logic is tested through `window.__wb_mergeBoards` — no OAuth needed.
- **Never emulate `reducedMotion` in Playwright.** The app's reduce CSS turns
  every style change into a 0.01ms transition (default
  `transition-property: all`), so `getBoundingClientRect` lags style writes
  by one frame and position assertions go racy. The suite instead pre-seeds
  `whiteboard:settings` to `{"flyTo":false}` via `storageState` in
  playwright.config.js so navigation stays an instant cut; suites testing
  the fly animation itself override with a clean `storageState`.
- `test.fixme()` entries are specs for known gaps, not broken tests.

## Conventions

Comments explain *why* (constraints, rejected alternatives), section banners
(`════`) split app.js; match them. No frameworks, no build step, no runtime
deps — additions must justify themselves against "one file, view-source
debuggable". Icons are self-hosted SVGs applied via CSS masks
(`-webkit-` longhands, not the shorthand).

## Deferred optimizations (decisions, not backlog noise)

Each was investigated during the code audit and parked with a specific
revisit trigger — recorded here so they aren't re-litigated. The full audit
trail (including the checklist that closed out every acted-on item) lived in
`AUDIT.md`; it was removed once complete and survives in git history.

- **Per-keystroke whole-board `JSON.stringify` (undo snapshots) — declined.**
  Every coalesced edit runs `recordUndo` → `contentSnapshot()`, which
  stringifies all cards/iframes/connections (several MB on a board with
  pasted images). Two deferral attempts both failed: snapshotting once per
  burst loses a genuine two-step undo boundary when a burst is interrupted
  (nudge A, then drag B before the 600ms timer), and `setTimeout(0)`-deferred
  bookkeeping races (fuzz-failed on the 9th of 10 runs) because `commit()` is
  a *post-hoc* chokepoint — sites mutate `board` first, then notify, so the
  "state just before edit N+1" exists only at commit N and `contentSnapshot()`
  only ever reads the live board. Accurate undo boundaries therefore *require*
  synchronous work at every commit; any deferral merges boundaries.
  **The one door still open:** make the snapshot cheaper, not later — a
  per-record `Map<id, json>` cache with dirty hints threaded through
  `commit(opts)` (re-stringify one card, concatenate cached strings for the
  rest). Same risk class as the item-7/8 runtime caches: a stale entry is
  silent undo-history corruption that passes tests, so every
  wholesale-board-replacement path (undo apply, merge, pull, import, board
  switch) needs correct invalidation. Build only if typing on a real
  image-heavy board demonstrably janks, and only with the same fuzz-loop
  verification that caught the second attempt.
- **`typedConfirm` factory (clear-board vs delete-board word gates) — not
  done.** At n=2 the ~15 lines each of word-gate logic stay inline; revisit
  only if a third typed confirmation appears.
- **`fitTransform(r, g, pad, maxZoom)` — not done.** Fit-and-center math
  exists in ~4 algebraic variants (`dockFitRegion`, `frameNode` ×2,
  `fitToContent`) with deliberate pad/cap differences; they're stable and
  behavior-tested. Consolidate into one pure helper only if touching that
  area anyway.
