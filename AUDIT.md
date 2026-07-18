# Code audit — July 2026

Working checklist from the four-way review (duplication, performance,
accessibility, documentation) after the docking / fly-to / settings work.
Reordered into **model sections**: work the Sonnet section on a cheaper
model, swap to Fable for the hot-path/interaction-design section, then
close out. Item numbers are stable from the original ordering — keep
referring to them by number. Within each section, work top to bottom.
Check items off as they land; delete the file when it's empty.

Workflow (applies regardless of model): talk through each item and get an
OK before implementing; full Playwright suite (×2 when timing-sensitive)
gates every commit; buckets are for iteration only.

Line numbers were verified at commit `73ebf55` and will drift as items land.

---

## Done

### 1. [x] `resetView` ignores the fly-to setting on its no-home branch — done, 8cb806b
- **Where:** `app.js:4418-4426`
- **What:** With a home frame set, the button routes through `frameNode` →
  `setMainViewport` and glides. Without one, it hand-copies `land()`
  (viewport assign + `applyViewport()` + viewportOnly commit) and always
  hard-cuts — the same button honors the setting on one branch and ignores
  it on the other.
- **Fix:** Replace the three hand-rolled lines with `setMainViewport(0, 0, 1);`.

### 2. [x] Accessibility attribute pass (no behavior change) — done, 804dfc4
(includes the help/settings CSS grouping from "confirmed clean"; the
Copy-ID announcement reads "ID copied" per user preference)

### 3. [x] ARCHITECTURE.md — record the invariants learned this cycle — done, 52febc7
(settings-never-merge, fly-to/viewportOnly contract, never-emulate-
reducedMotion, stale counts, board-deletion semantics)

---

## Section A — Sonnet (well-specified, mechanical or self-contained)

The finding and the fix are both already written down; the work is
executing the spec and passing the suite.

### 4. [x] Shared `tests/helpers.js` — done
- **What:** `drag()` is byte-identical in five spec files (whiteboard:19,
  usability:20, dock:13, pin:13, touch:29). `addCardAt()` has four copies and
  three (usability:27, pin:20, touch:36) still use the `.last()` pattern
  CLAUDE.md bans — the fixed id-diff variant lives only in `dock.spec.js:23`
  (with the comment explaining why `.last()` breaks once `#dock-world`
  exists). `worldScale()` ×3, `nodePos()` ×3. Worst: `card()` has
  **incompatible signatures** — `card(x, y, title, body)` in
  usability:1545-1549 vs `card(title, body)` in merge-review:20-22.
- **Fix:** `tests/helpers.js` with plain `module.exports` (specs are already
  CommonJS; no build step violated). Standardize on the dock id-diff
  `addCardAt`. Rename or merge the two `card()` shapes so the collision is
  impossible. Helpers used by a single file stay local.
- **Verify:** full suite twice (timing-sensitive rule applies).
- **Correction on landing:** specs actually use ESM `import`/`export`
  syntax throughout (Playwright transpiles it), not CommonJS — so
  `helpers.js` uses `export function`/`export const`, matching house style,
  rather than `module.exports`. `card()` split into `cardRecordAt(x, y,
  title, body)` (usability's shape) and `cardRecord(title, body)`
  (merge-review's minimal shape). `nodePos` standardized on usability's
  `{x, y, w, h}` superset; dock/touch callers only read `x`/`y` so this is
  compatible. `worldTransform` in touch.spec.js stays local (used directly
  for translate assertions beyond just scale).

### 5. [x] Modal lifecycle registry (`wireModal`) — fixes real conflict-modal bugs — done
- **What:** every modal hand-copies a 4-piece protocol (remember focus on
  open, restore on close, backdrop `e.target === modal` dismiss, Escape
  branch in the global keydown chain). Frame (4361-4407), button-link
  (4275-4352), clear (4440-4462), delete-board (4471-4503) each carry all
  four; the Escape chain is four near-identical branches in a row
  (4657-4676). The **conflict modal (5838-5862) already diverged**: no
  focus save/restore (keyboard user dismissing it lands on `<body>` at the
  top of the page), no backdrop dismiss, and its own separate capture-phase
  Escape listener.
- **Fix:** small `wireModal(overlayEl, close)` that registers the backdrop
  listener and pushes `{el, close}` into a `MODALS` array; the keydown
  chain's modal section becomes one loop; open/close helpers own focus
  save/restore. ~20 lines replacing ~50. Bring the conflict modal onto it —
  that's the user-visible fix riding along. Note existing minor drift:
  `blModal`/`boardMenu` branches null-check their element, frame/clear/delete
  don't; `blInput` has a redundant Escape handler at 4339.
- **Explicitly NOT doing:** a `typedConfirm` factory for clear vs
  delete-board — at n=2 the remaining ~15 lines each of word-gate logic stay
  inline (revisit only if a third typed confirmation appears). Help/settings
  popover mirroring also stays as-is, but their Escape branches (4682/4687)
  and the board menu's (4677) can ride the same registry if it's cheap
  (a popover is just `{el, close}` too).
- **Landed as planned**, plus two things found during verification:
  1. **Conflict modal doesn't fit the open()/close() shape** — it resolves a
     fresh Promise per call, so there's no fixed `close` to hand `wireModal`.
     Fixed with a mutable indirection (`conflictClose`, set/cleared per
     invocation) so the shared chain can still reach whichever call is live.
     Added `window.__wb_openConflictModal` (mirrors `__wb_openMergeReview`)
     since the real modal is only reachable via a live Drive round-trip the
     suite keeps network-clean of — two new tests in merge-review.spec.js
     cover Escape-restore and backdrop-click-restore directly.
  2. **Backdrop dismiss moved from `pointerdown` to `click`.** Closing on
     `pointerdown` and calling `restoreModalFocus()` synchronously loses a
     race with the browser's own mousedown default action (shift focus away
     from the non-focusable backdrop) — the restore would win, then get
     silently clobbered a moment later. `click` fires after that default
     action settles, so the restore is what the user actually sees. Applies
     to all five modals now on `wireModal`, not just the conflict modal.
  3. **Board menu rides the Escape loop only, not the backdrop.** It's an
     anchored popover (dismissed by `!e.target.closest('#board-menu-wrap')`),
     not a full-page overlay — pushed into `MODALS` directly rather than via
     `wireModal`, so its existing outside-click behavior is untouched.
  4. **Surfaced, not introduced:** removing `blInput`'s redundant local
     Escape handler exposed that button-link-modal's Escape-dismiss now
     correctly restores focus to its trigger (`#addButton`) — previously
     the redundant handler and the global chain fired on the same keydown,
     and the second (no-op) pass fell through into the bare-canvas Escape
     branch, which blurred `#addButton` back to `<body>` as an accidental
     side effect. Frame-modal already had this same restore-to-trigger
     property (openFrameModal is also toolbar-triggered) and was simply
     never exercised with a chained bare Escape afterward. One usability
     spec test relied on the accidental blur; updated it to send Escape
     twice, matching the app's existing "first Escape steps out of chrome,
     second clears canvas selection" design (documented in the code at
     app.js's Escape handler) rather than weakening the assertion.

### 6. [x] Help/settings popovers: fix the focus drop (and the `role`) — done
- **Landed:** `role="dialog"` → `role="region"` on both. Settings gets
  remember/restore, gated on `settingsPanel.contains(document.activeElement)`
  at close time — an outside click is a deliberate navigation and shouldn't
  yank focus back to the trigger, only an Escape-while-tabbed-in should.
  Help gets no remember/restore at all: it's pure reference text with zero
  focusable elements, so focus can never legitimately land inside it.
  Both now ride the item-5 `MODALS` Escape loop (registered the same way as
  the board menu — Escape-dedup only, their existing outside-click dismiss
  stays separate), removing the two remaining standalone Escape branches.

### 17. [ ] Gate `refreshColorFilter`/`layoutAttachments`/re-sanitization on mutation type
- **Split off from item 9** (see below) after item 9 itself was investigated
  and declined — this half doesn't touch `recordUndo`/undo history at all,
  so it doesn't inherit that item's risk.
- **Where:** `commit()` (app.js ~530-550) unconditionally runs
  `layoutAttachments()`, `refreshColorFilter()` (full legend DOM rebuild),
  and — for body edits specifically — `saveCardBody` re-sanitizes the
  card's whole innerHTML (~4995), on every commit including every keystroke
  of a title/body edit.
- **What:** a title or body edit can't change which nodes are docked
  (`attachedTo` is a separate field only touched by dock/undock actions)
  and can't change any node's `color` (only the context-menu color picker
  touches that) — so `layoutAttachments()`'s full `Object.entries(board.cards)`
  scan + DOM query, and `refreshColorFilter()`'s full legend rebuild, are
  100% wasted work on every keystroke of a text edit.
- **Fix:** thread a cheap mutation-kind hint through `commit(opts)` (e.g.
  `opts.affects = {dock: false, color: false}` from the coalesce call
  sites) and skip `layoutAttachments()`/`refreshColorFilter()` when the
  caller asserts they can't apply. Arrow nudges are the one coalesced
  caller that's NOT safe to skip `layoutAttachments()` for — a nudged node
  can carry docked buttons that must re-derive position. Re-sanitizing in
  `saveCardBody` stays as-is (correctness-critical: it's the XSS boundary
  from CLAUDE.md's `sanitizeHtml()` rule, not a place to cut corners).
- **Verify:** full suite twice; this is a targeted skip, not a timing
  change, so lower risk than item 9 — but still touches the shared
  `commit()` chokepoint, so treat call-site coverage carefully (every
  `commit({coalesce:true})` site needs its hint set correctly, not just
  the common ones).

### 9. [x] Get the whole-board `JSON.stringify` out of the per-keystroke path — investigated, declined
- **Where:** `commit({coalesce:true})` per input event (5000-5006, titles
  1260/1380/2244/2592, arrow nudges 4880) → `recordUndo` →
  `contentSnapshot()` stringifies all cards/iframes/connections (580-637)
  plus an O(size) string compare. Pasted images are ~1.5MB data URIs inside
  card bodies (3184-3222) — several MB stringified per keystroke on a board
  with screenshots.
- **Tried #1 — snapshot once per burst, not per keystroke:** `recordUndo`
  skips `contentSnapshot()` during an active coalesce burst, catching up
  `lastContent` only when the burst settles or is interrupted. Caught by a
  new test before it landed: a burst interrupted by an unrelated edit
  (e.g. nudge card A, then immediately drag card B before the 600ms timer
  fires) silently merged BOTH edits into one undo step instead of two —
  because by the time the interrupting commit's `recordUndo` runs, its own
  mutation is already applied to `board.cards`, so there's no clean way
  left to snapshot "burst end, before the interrupt." Confirmed against
  the pre-fix code that the original two-step behavior is real and
  expected, not incidental.
- **Tried #2 — same synchronous logic, only its scheduling deferred**
  (`setTimeout(fn, 0)` instead of an inline call, with an explicit
  `drainPendingRecordUndo()` for `undo()`/`redo()`/board-switch so nothing
  reads stale state): this was meant to preserve exact undo granularity
  while moving the stringify off the keystroke's own call stack. Fuzz-ran
  the **existing, already-passing** "a burst of nudges undoes as a single
  step" test in a loop — failed on the 9th of 10 runs. Root cause: an
  unrelated, already-finished commit's deferred bookkeeping was still
  queued when a new burst started; both got drained in the same batch,
  and `contentSnapshot()` (always reading the live board) contaminated the
  older entry with the newer burst's changes. `setTimeout(0)` does not
  reliably fire between consecutive `commit()` calls — real timer
  throttling (~4ms in Chromium) can be slower than back-to-back commits.
- **Declined:** every version tried either changes undo granularity in a
  disclosed way or has a genuine, reproducible race. And the failure is
  structural, not bad luck: `commit()` is a *post-hoc* chokepoint (call
  sites mutate `board` first, then notify), so the state "just before edit
  N+1" exists at exactly one moment — commit N — and `contentSnapshot()`
  can only read the live board. Accurate undo boundaries therefore
  REQUIRE synchronous work at every commit; any flavor of deferral merges
  boundaries. The per-keystroke cost stays.
- **The one door still open (Fable-tier, only if it ever matters):** make
  the snapshot **cheaper instead of later** — a per-record string cache
  (`Map<id, json>`) with dirty hints threaded through `commit(opts)`, so a
  keystroke re-stringifies one card and concatenates cached strings for
  the rest. Failure mode is a stale cache producing a wrong undo snapshot
  (silent history corruption that passes tests); every wholesale-board-
  replacement path (undo apply, merge, pull, import, board switch) needs
  correct invalidation. Same risk class as items 7/8. Do NOT build it
  speculatively — only if typing on a real image-heavy board demonstrably
  janks, and then with the same fuzz-loop verification standard that
  caught attempt #2.
- **Split off:** the *other* half of this item — gating `layoutAttachments`/
  `refreshColorFilter`/re-sanitization, which doesn't touch `recordUndo` at
  all — is safe on its own and moved to item 17.

### 10. [ ] `findSnapTarget`: precompute candidates at drag start
- **Where:** `app.js:1559-1608`.
- **What:** dragging a free button runs two full card loops per move, with
  `countDocked` (itself O(cards)) inside, plus `getBoundingClientRect` per
  frame tab and `nodeGeom` per candidate — right after the drag handler
  dirtied layout. ~O(n²) per pointermove.
- **Fix:** only the dragged button moves, so target geometry is static —
  compute the docked-count map and candidate rects once at drag start.

### 11. [ ] Fly-to: cap hydration and defer iframe loads mid-flight
- **Where:** fly loop 4086-4098 → `applyViewport` → `scheduleFrameEval`
  (710) → `promotePendingInView` (3386-3395) + `evaluateFrameLoading` (2504).
- **What:** `promotePendingInView` hydrates every pending near-view node
  synchronously in one rAF (no `HYDRATE_CHUNK` cap like `drainHydration`
  has) — a flight sweeping a dense region hydrates dozens of nodes in one
  animation frame (visible hitch). `evaluateFrameLoading` sets iframe `src`
  the instant an embed intersects — including transiently, mid-flight, for
  embeds merely flown past.
- **Fix:** while `flyRAF` is set, cap `promotePendingInView` at
  `HYDRATE_CHUNK` per frame (or skip and promote on landing), and route
  "visible" iframe loads through the existing idle queue until landing.

### 12. [ ] Marquee: stop `markNode` scanning all cards
- **Where:** `startBoxSelect` onMove 3545-3570 → `setSelection` (856-863) →
  `markNode` (816-827) scans `board.cards` per marked node to co-select
  docked buttons — O(changed × cards) per move on docked-button-heavy boards.
- **Fix:** build the attachedTo→root reverse map once per gesture (or reuse
  the one `layoutAttachments` already builds).

### 15. [ ] ⌘K jump list (and `#node-picker`, `#bl-list`): listbox semantics
- **What:** arrow keys move a `.sel` class on plain divs (5461-5483) —
  silent to screen readers.
- **Fix:** `role="listbox"`/`role="option"` + `aria-activedescendant` on
  the input, or `announce()` the highlighted item.

---

## Section B — Fable (hot-path rewiring & interaction design)

These either thread through render/commit/merge where the failure mode is
a subtle stale-state bug that passes tests, or require designing new
keyboard interaction against the `onCanvas`/`editing` key-handling rules.

### 7. [ ] Node drag: batch layout writes/reads; cache mover sizes
- **Where:** `startNodeDrag` onMove, `app.js:932-957`; `nodeGeom` 788-793;
  `layoutAttachments` 1476-1549.
- **What:** per mover per pointermove: `style.left/top` write →
  `redrawConnectionsFor` → `offsetWidth` read = forced synchronous layout
  per mover per frame; then `layoutAttachments()` does a full
  `Object.entries(board.cards)` scan + a full-DOM `querySelectorAll` + its
  own interleaved reads, on the same move.
- **Fix:** write all mover positions first, then do all reads/redraws.
  Node sizes don't change mid-drag — cache `{w,h}` per mover at drag start
  and let `nodeGeom` use the cache for the drag's duration.
- **Related cheap fix:** the dragged node's own port-proximity handler
  (`addPorts`, 987-1010) reads `getBoundingClientRect` on the same events —
  early-return when `el.classList.contains('dragging')`.

### 8. [ ] Endpoint→connections index for `redrawConnectionsFor`
- **Where:** `app.js:2938-2942`.
- **What:** linear scan of ALL connections, called per drag-move per mover,
  per docked button in `layoutAttachments` (1516, 1548), per hydrated node
  (3320 — a 24-node idle chunk = 24 × O(C)), and per keystroke via
  `saveCardBody` (5004). `drawConnection` also recomputes `spectrumStops`
  (7 stop-color writes + 14 hex↔HSL conversions) when colors can't have
  changed (2916-2921).
- **Fix:** maintain a `Map` from node id → connection ids, updated on
  connection create/delete. O(all) → O(degree). No data-model change —
  runtime index only, rebuilt on board load/merge.

### 13. [ ] Connections are keyboard-unreachable once created
- **What:** `C`-mode creates arrows by keyboard, but `selectConn` is only
  called from pointer paths (865-869); Tab cycles nodes only. The Delete
  handler already supports `selectedConn` (4829-4831) — keyboard just can't
  set it. Label editing is dblclick-only (2857).
- **Direction:** include connections in the Tab cycle, or a "next
  connection of selected node" key; Enter to edit label.

### 14. [ ] Keyboard path to context-menu actions
- **What:** color coding, Pin to toolbar, Dock frame, button-link editing,
  Copy ID exist only behind `contextmenu`. Nodes never hold real DOM focus
  (selection is virtual), so ContextMenu key / Shift+F10 can't target them.
  `openContextMenu` (3799-3856) also never moves focus in, has no
  `role="menu"`, no arrow-key nav — only Escape.
- **Cheap half:** focus the first `.ctx-item` on open + arrow nav +
  `role="menu"`/`menuitem`.
- **Structural half:** a keyboard trigger (e.g. Shift+F10 opens the menu
  for the selected node).

---

## Section C — closeout (either model; do LAST)

### 16. [ ] Record known limitations in ARCHITECTURE.md (deliberate, scoped)
Written last because it records what items 13–15 leave undone.
- Nodes have no screen-reader semantics: bare `div.node.card` with unlabeled
  contenteditable (1216-1226); the roving-selection model is announce()-based
  and invisible to virtual-cursor/browse-mode users. Proper fix =
  `role="group"` + `aria-label` per node + `aria-roledescription` — record
  as a known limitation with that scope rather than half-fixing.
- Pointer-only residue: node/frame resize and dock-panel width
  (`#dock-resizer`) have no keyboard equivalent (keyboard resize à la
  Shift+Alt+arrows would be structural).
- Discoverability: C-mode and the F6 region cycle (4900-4912) are only
  documented in the help panel; consider `aria-keyshortcuts` on relevant
  chrome.

---

## Confirmed clean (audited, no action — don't re-litigate)

- **Modal focus trap** (Tab cycling, 4251-4264) is generic across all
  `.modal-overlay`s; focus remember/restore helpers exist and work where wired.
- **Reduced motion:** global 0.01ms block properly media-gated
  (styles.css:1875-1884) — zero cost in normal operation; fly-to checks
  `matchMedia` in JS; no uncovered JS animation found.
- **Contrast:** computed the risky pairs — danger-on-bg ≈ 7.2:1, danger
  button text ≈ 8:1, muted text ≈ 8.6:1. Selection is border+ring+shadow,
  not hue-only.
- **Listener hygiene:** no leaks — creation-time wiring only, drag handlers
  remove their window trio on up, deleted nodes GC their listeners.
- **viewportOnly commits** are debounced (400ms); wheel pan is rAF-coalesced;
  never a per-frame localStorage write. `cancelFly`'s window listeners are
  passive/early-return — negligible.
- **Navigation plumbing:** deep links, ⌘K, button actions, dock navigation
  all correctly route through `frameNode`/`setMainViewport`; `resetView`
  (item 1) is the only stray.
- **Ports/edge math:** side-midpoint proximity math is the single copy;
  temp-drag path reuses `borderPoint` correctly.
- **Section banners & why-comments** at the new sites (SETTINGS, fly-to,
  delete-board, playwright storageState) all match house style.
- **Fit-and-center math** exists in 4 algebraic variants (dockFitRegion
  2059, frameNode 4114/4132, fitToContent 4213) — deliberate pad/cap
  differences, stable, behavior-tested. Consolidate into a pure
  `fitTransform(r, g, pad, maxZoom)` only if touching that area anyway.
- **CSS panel duplication** — folded into item 2's sweep, done.
