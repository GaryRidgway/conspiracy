# Code audit — July 2026

Working checklist from the four-way review (duplication, performance,
accessibility, documentation) after the docking / fly-to / settings work.
Ordered as a suggested work-through: cheap correctness first, then
consolidation, then performance, then the structural accessibility projects.
Check items off as they land; delete the file when it's empty.

Line numbers were verified at commit `73ebf55` and will drift as items land.

---

## Phase 1 — quick correctness wins

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
One sweep of pure attribute additions; each is independent:
- [ ] Dock rail: children of `role="tablist"` (`#dock-rail`, built in
  `app.js:2026-2039`) are plain buttons — add `role="tab"` +
  `aria-selected` (active state currently only the `.active` class).
- [ ] `aria-controls` on the three popover triggers: `boardMenuBtn` →
  `#board-menu`, `settingsBtn` → `#settings-panel`, `helpBtn` →
  `#help-panel`. (Grep confirms zero `aria-controls` in the repo today.)
- [ ] Modals: point `aria-describedby` at the warning note. `#delete-board-note`
  (`index.html:236`) has an id nothing references; the clear-modal note
  (`index.html:220`) needs an id first. The Drive-vs-device deletion text is
  exactly what a screen-reader user needs to hear.
- [ ] Color-filter dots (`.cf-dot`, `app.js:1186`): add `aria-pressed`
  (state is currently only the `.active` ring + title swap).
- [ ] Icon-only buttons: mirror `title` into `aria-label`. Surface: undo/redo
  (`index.html:65-66`), zoombar (`174-177`), settings/help (`107`, `124`),
  text toolbar (`182-186`), dock header (`25-27`), card `copy-link` /
  `card-delete` (`app.js:1223-1224`), board rename/remove (`app.js:6162-6164`),
  ctx swatches (`app.js:3816`, `3824`). The notice dismiss buttons
  (`app.js:5714`, `5791`) already do this — copy that pattern.
- [ ] `setSaveState` (`app.js:712-716`): call the existing `announce()` on the
  `'error'` branch only ("Save failed"). Do NOT make `#saveState` a live
  region — dirty/saved churn on every commit would be noisy.
- [ ] Copy-ID feedback (`app.js:4155-4161`): icon swap is visual-only; add
  `announce('Link copied')`.

### 3. [ ] ARCHITECTURE.md — record the invariants learned this cycle
- [ ] **Persistence table (~line 220):** add the `whiteboard:settings` row —
  per-device preferences (`flyTo`, …), never synced, never merged, never a
  board field (or `mergeBoards` on deployed clients drops/churns it). The
  invariant currently lives only in the code banner at `app.js:5497-5499`;
  it belongs next to its sibling, "viewport is per-device".
- [ ] **Tests section (~line 467):** the reducedMotion prohibition — never use
  Playwright's `reducedMotion` emulation in this suite; the app's reduce CSS
  turns every style change into a 0.01ms transition, so
  `getBoundingClientRect` lags styles by one frame (racy assertions).
  The suite pre-seeds `whiteboard:settings {"flyTo":false}` via
  `storageState` (`playwright.config.js:17-28`); animation tests override
  with a clean storageState.
- [ ] **View layer navigation bullet (~line 365):** fly-to — jumps glide
  (eased, cancel-on-input, reduced-motion/hidden-tab cuts instantly) when
  `settings.flyTo` is on; a flight mutates only `board.viewport` and
  lands/cancels with `viewportOnly` commits — it must never bump `version`.
- [ ] **Stale line 5:** "~4,000 lines" → app.js is ~6,250. Round up or drop
  the number.
- [ ] **Stale Tests intro (~line 465):** "Two suites" — there are seven spec
  files (whiteboard, usability, dock, pin, touch, loading, merge-review);
  the doc already cites loading and touch elsewhere, contradicting itself.
- [ ] **Board switching (~line 201):** one line on removal semantics —
  Drive-mode boards only leave the device (the Drive file survives); device
  boards are gone with no undo; both behind the typed-DELETE modal.

---

## Phase 2 — consolidation (divergence has already bitten)

### 4. [ ] Shared `tests/helpers.js`
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
  impossible.
- **Verify:** full suite twice (timing-sensitive rule applies).

### 5. [ ] Modal lifecycle registry (`wireModal`) — fixes real conflict-modal bugs
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

### 6. [ ] Help/settings popovers: fix the focus drop (and the `role`)
- **Where:** `index.html:108,125`; `app.js:5508-5546`; Escape at 4682-4690.
- **What:** both declare `role="dialog"` but are non-modal popovers — no
  focus-in on open, no trap, and closing while focus is inside (e.g. on the
  `#setFlyTo` checkbox) drops focus to `<body>` with no restore.
- **Fix:** on close, return focus to the trigger when focus was inside the
  panel; either manage focus like the real modals or demote to a plain
  labelled region (recommendation: demote — they're popovers, not dialogs).

---

## Phase 3 — performance (mechanisms verified; felt impact needs large boards)

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

### 9. [ ] Get the whole-board `JSON.stringify` out of the per-keystroke path
- **Where:** `commit({coalesce:true})` per input event (5000-5006, titles
  1260/1380/2244/2592, arrow nudges 4880) → `recordUndo` →
  `contentSnapshot()` stringifies all cards/iframes/connections (580-637)
  plus an O(size) string compare. Pasted images are ~1.5MB data URIs inside
  card bodies (3184-3222) — several MB stringified per keystroke on a board
  with screenshots. Also per keystroke: `layoutAttachments()`,
  `refreshColorFilter()` (full legend DOM rebuild, 1145-1205), and
  `saveCardBody` re-sanitizing the card's whole innerHTML (5003).
- **Fix (cheapest first):** defer `contentSnapshot` into the existing 600ms
  coalesce window (snapshot once per burst, not per keystroke); or snapshot
  per-collection and reuse unchanged collections' strings. Gate
  `refreshColorFilter`/`layoutAttachments` on mutation types that can
  affect them. The 400ms localStorage debounce (509-526) is already fine.

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

---

## Phase 4 — structural accessibility (real projects, scope before starting)

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

### 15. [ ] ⌘K jump list (and `#node-picker`, `#bl-list`): listbox semantics
- **What:** arrow keys move a `.sel` class on plain divs (5461-5483) —
  silent to screen readers.
- **Fix:** `role="listbox"`/`role="option"` + `aria-activedescendant` on
  the input, or `announce()` the highlighted item.

### 16. [ ] Record known limitations in ARCHITECTURE.md (deliberate, scoped)
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
- **CSS panel duplication** (#help-panel/#settings-panel share nine
  declarations, styles.css 1168-1181 vs 1212-1224) — 2-minute grouping,
  fold into item 2's sweep or leave.
