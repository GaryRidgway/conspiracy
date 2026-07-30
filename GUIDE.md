# Conspiracy — user guide

An infinite whiteboard for pinning up ideas and linking them with red
thread. Everything lives in your browser; a board only leaves your device
if you connect Google Drive.

Press **?** in the app at any time for the shortcut cheat-sheet.

---

## Contents

- [The five things you can add](#the-five-things-you-can-add)
- [Moving around the canvas](#moving-around-the-canvas)
- [Cards](#cards)
- [Images](#images)
- [Frames](#frames)
- [Embeds](#embeds)
- [Buttons](#buttons)
- [Connections (the red thread)](#connections-the-red-thread)
- [Selecting and arranging](#selecting-and-arranging)
- [Colors, and filtering by color](#colors-and-filtering-by-color)
- [Finding things and jumping around](#finding-things-and-jumping-around)
- [Linking to items](#linking-to-items)
- [The side panel (docked frames)](#the-side-panel-docked-frames)
- [Pinning buttons to the toolbar](#pinning-buttons-to-the-toolbar)
- [Undo, and how saving works](#undo-and-how-saving-works)
- [Boards](#boards)
- [Export, import, clear](#export-import-clear)
- [Google Drive sync](#google-drive-sync)
- [Settings](#settings)
- [Touch and tablets](#touch-and-tablets)
- [Keyboard-only use](#keyboard-only-use)
- [Full keyboard reference](#full-keyboard-reference)
- [Limits and gotchas](#limits-and-gotchas)

---

## The five things you can add

Everything on a board is one of five item types, added from the floating
palette on the left — or by right-clicking empty canvas and picking
"Add … here", which places the item exactly where you clicked.

| Item | What it's for |
|---|---|
| **Card** | A note: a title plus a rich-text body. The main unit of a board. |
| **Frame** | A named rectangular region — a labelled area you can group things in, jump to, or dock to the side panel. |
| **Embed** | A live web page rendered inside a resizable box on the canvas. |
| **Image** | A picture from a file or the clipboard, resizable on the canvas. |
| **Button** | A clickable chip that jumps to another item on the board, or opens a URL. |

While a board is empty a centered hint points you at the palette.

## Moving around the canvas

| Gesture | Result |
|---|---|
| Scroll / two-finger swipe | Pan |
| **Space** + drag | Pan (works over items too) |
| **⌘/Ctrl** + scroll, or trackpad pinch | Zoom about the cursor |
| Drag empty canvas | Box-select |
| **Fit** button, or **Shift+1** | Zoom out to frame everything on the board |
| **Shift+2** | Frame just what's selected — this one zooms *in* |
| **Reset view** button | Return to the board's default view |
| Zoom bar (bottom right) | Zoom in/out, click the percentage to snap back to 100%, or fit |

The status strip at the bottom left shows the world coordinates under
your cursor, and whether your changes are saved.

**Reset view** normally snaps to the board's origin at 100%. If you mark
a frame as the default view (right-click the frame → *Use as default
view*), Reset frames that region instead — a useful "home" for a board
whose content sits far from the origin.

## Cards

- **Add**: palette → **Card**, or right-click → *Add card here*.
- **Title**: double-click it to rename. **Enter** commits and drops into
  the body; **Escape** cancels the edit.
- **Body**: always editable — just click and type. Cards auto-size to
  their content (they don't have a resize handle): width hugs the title,
  clamped between 240px and 520px.
- **Move**: drag the card's header. Dragging the body would fight with
  text selection.
- **Delete**: the trash icon in the header, or select it and press
  **Delete**.

### Rich text

Focus a card body and a small floating toolbar appears above the card:

- **Bold** / *Italic*
- Bulleted list / numbered list
- **Link** — inserts an inline link to another item on this board (see
  [Linking to items](#linking-to-items))

The formatting buttons light up for whatever is already in force where your
caret sits, so you can tell at a glance whether the next character will come
out bold — and a second press turns it off again.

Pasted content keeps its structure, including tables pasted from GitHub
or a document, even though the toolbar doesn't offer tables itself.

## Images

Two ways in: the **Image** tool in the left palette (or right-click →
*Add image here*) picks files from disk, and **⌘/Ctrl+V** pastes a
screenshot. Where a paste lands depends on what has focus:

- **on the canvas** — it becomes an image on the board in its own right,
  placed under your cursor;
- **while editing a card body** — it lands inline at the caret, as part of
  that card's text.

An image on the board behaves like anything else: drag it anywhere, give it
arrows, color it, link to it. Drag it by the picture — there's no title bar
to grab. Selecting it (or hovering) reveals a bar above it where you can
give it a name, which is also what screen readers and **⌘K** search see.

**Resizing** happens at the handles: pull a **corner** to scale it, which
holds its proportions, or an **edge** to stretch one dimension on its own.
Hold **Shift** while pulling a corner to break the proportions there too.

**Cropping**: double-click an image (or right-click → *Crop*). The whole
picture appears dimmed around it, and the bright part is the window you're
keeping:

- **drag a handle** to move that edge of the window — the picture holds
  still while the window closes in on it;
- **drag the picture** to slide it under the window — the window stays
  exactly where it sits on the board. The dimmed part counts too: drag
  anywhere on the picture, inside the window or out;
- hold **Shift** (or **Ctrl**, or **Cmd**) while dragging a handle to keep
  the shape **regular**: a circle stays round, a triangle or hexagon stays
  equilateral, and anything rectangular stays square. Note this is the
  reverse of its job on an ordinary resize, where the proportions are
  already held and the modifier releases them — a crop starts free, so
  there the modifier is what constrains it. Expect the window to *jump* the
  moment you hold the key on a lopsided one: a square can't be wider than
  the picture is tall, so it snaps to the biggest one that fits and drags
  from there;
- **arrow keys** pan it too, so cropping works without a mouse.
- **Esc** (or **Enter**, or a click away from the picture) finishes.

If the image has a shape, you'll see that shape while you crop — you're
choosing the framing for it, after all.

There is nothing to confirm: each drag is a normal edit, so **⌘/Ctrl+Z**
walks back through them like anything else. Afterwards, resizing scales
what you framed rather than re-cropping it, and right-click → *Reset crop*
brings the whole picture back — cropping never removes anything from the
stored image.

**Shapes**: right-click an image for a row of shape chips — rectangle,
rounded, circle, triangle, diamond, hexagon. These are *masks* too,
so nothing is thrown away: choosing rectangle again brings the whole
picture back, whenever you like. The bounding box (and its handles) stays
rectangular, so a circular image is still easy to grab and resize.

Images are downscaled on the way in (longest edge 1600px, WebP), and the
picture itself is stored separately from the board — the board only keeps
a reference to it. That's why an image-heavy board no longer eats the
same storage budget as the text and layout around it. Resizing only ever
changes the box on the board, never the stored picture.

An occasional consequence: if a picture shows as a dashed empty box, its
bytes aren't on this device. That happens on a board you've just opened
somewhere new, before its images have finished arriving. Everything else
on the board works normally meanwhile.

**Exporting** a board writes the pictures into the file, so an export is
still a complete, portable backup.

### How much room am I using?

**Settings** (the gear, top right) reports it: how much of this browser's
board-text budget you've used, how much your pictures take, and whether
the browser has agreed not to clear them.

The app also speaks up on its own, once per session, when something is
actually worth acting on — and what it suggests depends on which limit
you're near:

- **Board text near the limit.** Export or delete a board you don't need
  in this browser. Connecting to Drive does *not* help here; a Drive board
  keeps a local copy plus a sync snapshot, so it uses slightly more of
  this particular budget, not less.
- **A large picture library that exists only in this browser.** This isn't
  a limit — it's that the browser is allowed to clear it. Saving the board
  to Drive keeps the pictures in your own Drive, after which the local copy
  is just a cache and losing it costs a re-download.

## Frames

A frame is a labelled region: a rectangle with a title tab in its top-left
corner. Frames sit *behind* everything, and their interiors don't
intercept clicks, so cards on top of a frame stay fully usable.

- **Move**: drag the title tab. **Resize**: the handle at the bottom-right
  corner.
- **Rename**: double-click the title, or right-click → *Rename*.
- **Right-click** a frame for its options:
  - **Move items with frame** — a toggle. When on, dragging the frame
    carries every item *fully inside* its rectangle along with it.
    Membership is recomputed at the moment the drag starts.
  - **Use as default view** — makes this frame what **Reset view** frames.
    At most one frame per board can hold this.
  - **Dock to side panel** — see [The side panel](#the-side-panel-docked-frames).
- Frames have no connection ports: arrows link ideas, not regions. If you
  want an arrow pointing at an area, connect to a card inside it.

Box-select takes a frame only when your marquee **fully encloses** it —
otherwise almost every drag across a board would grab the region.

## Embeds

An embed is a real web page on your canvas.

- **Add**: palette → **Embed**. A dialog asks for a URL.
- **Move**: drag the header. **Resize**: bottom-right handle.
- **Rename**: double-click the label (defaults to the site's name).
- **Edit URL**: the pencil icon in the header.

The header also carries:

- **Content zoom** (the `100%` control) — scales the page inside the box
  independently of canvas zoom. Click the number to type a percentage,
  arrow keys nudge it by 1%, double-click resets it to 100%.
- **Zoom canvas to this frame** — frames the embed in the viewport.
- **interact** — toggles *interact mode*. Normally an embed ignores your
  clicks so you can drag and select it like any other item; in interact
  mode clicks reach the page inside. Double-clicking the embed body
  toggles this too, and **Escape** (or any pan/zoom gesture) exits it.

### Loading behaviour

Embeds load lazily so a board with a dozen of them doesn't hammer the
network on open:

- Visible on screen → loads immediately.
- Just off-screen → queued, loading one at a time, nearest first.
- Far away, or shrunk very small → stays a **"click to load"**
  placeholder. Click it to force the load.

Once loaded, an embed stays loaded — with one exception. Docking or
undocking a frame physically moves the embeds in its region between the two
windows, and a moved embed always reloads from scratch, losing whatever was
on the page (scroll position, a part-filled form). You'll see the
placeholder return, reading **"reloading…"**, until it paints again.

**Many sites refuse to be embedded** (`X-Frame-Options` / CSP) and will
show a blank box. That's the site's choice, not a bug — the dialog warns
about it. Also note that dragging an embed into or out of the side panel
reloads its page, because the browser reloads any `<iframe>` that gets
re-parented.

## Buttons

A button is a small chip that does one thing when clicked.

- **Add**: palette → **Button**. The link picker opens right away, since a
  button with no link does nothing.
- **Link it** to either:
  - **an item on this board** — clicking the button flies the view to it,
    selects it, and flashes it; or
  - **a URL** — clicking opens it in a new tab. (A pasted
    `#node=…` link to something on this board is recognised and navigates
    in place instead of opening a second copy of the app.)
- Its icon tells you which: a link glyph for a URL, a target glyph for a
  board item, a plus while it's unconfigured.
- **It names itself.** A button still called *Button* takes the name of
  whatever you link it to — the item's own title, or a URL's site. Rename it
  yourself and that name is kept from then on; re-linking never overwrites it.
- **Press**: a plain click. **Move**: click and drag — any real movement is
  treated as a drag, not a press.
- **Right-click** for *Rename*, *Set/Change link…*, *Remove link*,
  *Detach*, *Pin to toolbar*.

### Docking buttons to things

Drop a button onto another item and it attaches, becoming part of that
item's furniture. Its position is then maintained for you:

| Drop target | Result |
|---|---|
| A card's bottom edge | A full-width tab in a tray under the card (up to 3) |
| Just right of a frame's title tab | A row of buttons alongside the title |
| Another button | A horizontal menu chain |

While you drag a button over somewhere it can dock, that target is
**outlined in gold** — the same outline you get when aiming a connection at
something. Dragging the host moves the whole assembly; dragging a docked
button moves the assembly by its root. Selecting the host highlights its
docked buttons with it, and **Detach** (right-click) frees one again.
Deleting the host doesn't delete its buttons — they're left in place.

## Connections (the red thread)

- **Draw one**: hover an item to reveal its four ports — small handles at
  the middle of each edge, which light up as your cursor nears them — then
  drag from one to another item.
- **Keyboard**: select an item and press **C**, then **Tab** or the arrow
  keys to aim at a target, **Enter** to create it, **Escape** to cancel.
- **Select one**: click the line. By keyboard, select an item and press
  **E** to step through its connections (**Shift+E** backward);
  **Escape** steps back to the item.
- **Label it**: double-click the line, or press **Enter** on a selected
  one. The label rides at the midpoint of the curve.
- **Delete it**: select it and press **Delete**, or right-click →
  *Delete connection*.

Connections follow their endpoints, tint toward the colors of the items
they join, and clean themselves up if an endpoint is deleted.

## Selecting and arranging

- **Click** an item to select it; **Shift+click** to add to the selection.
- **Drag empty canvas** to box-select; **⌘/Ctrl+A** selects everything.
- **Click empty canvas** or press **Escape** to deselect.
- **Move**: drag, or nudge with the arrow keys — 10px per press, 1px with
  **Shift** held. A burst of nudges undoes as one step.
- **Duplicate**: **⌘/Ctrl+D**, or right-click → *Duplicate*.
- **Copy / cut / paste**: **⌘/Ctrl+C** / **X** / **V**. Copying takes the
  selection *and the connections between its members*, so pasting
  reproduces a whole sub-graph. The copy lands **under your cursor**, so you
  can copy something, scroll to the far side of the board, and paste it right
  where you're looking. Pasting repeatedly from one spot cascades so the
  copies don't stack exactly; move the cursor and the next one lands there
  instead. Right-click → *Paste here* does the same from the point you
  clicked.
- **Move to top**: right-click → *Move to top* raises an item above its
  neighbours. (Frames are always behind, by design, so this doesn't apply
  to them.)
- **Delete**: **Delete** or **Backspace**, or right-click → *Delete*.

## Colors, and filtering by color

Right-click any item and pick a swatch from the color row: **red, amber,
green, blue, purple, pink, gray**, or clear it. The color tints the item's
heading and border, and the connections attached to it. Setting a color on
a multi-item selection colors all of them in one step, and colouring an item
that has **docked buttons** colours those too — the assembly is one object,
so it takes one colour.

Once anything on the board is colored, a **legend of dots** appears under
the tool palette. Click a dot to **spotlight** that color — matching items
stay bright, everything else dims (items directly connected to a
spotlighted item stay visible so you can still see what links to what).
Click more dots to spotlight several colors, or the clear control to stop.

Filtering is a per-device view state: it isn't saved, isn't synced, and
doesn't enter undo history.

## Finding things and jumping around

Press **⌘/Ctrl+K** (or the **Find** button) for quick jump. Type anything
and it searches every card title and body, frame name, embed label and
URL, and item ID on the board. Arrow keys move through the results;
**Enter** flies the view to the chosen item, selects it, and flashes it.

**Tab** / **Shift+Tab** cycle items in reading order (top to bottom, then
left to right). **Alt+arrow** hops to the nearest item in that direction.

## Linking to items

Every card, frame and embed has a **tag icon** in its header: *Copy link
to this item*. It puts a `#node=<id>` deep link on your clipboard.

That link works in three places:

1. **Pasted in a browser** — opens the app with that item framed and
   selected.
2. **As a button's link** — the button flies to the item.
3. **Inside a card body** — use the link button on the floating text
   toolbar, then either search the board or paste an ID. Clicking the
   inline link navigates the view; it never opens a second tab.

`#board=<id>` links open a specific board.

## The side panel (docked frames)

A frame can be **docked** to the right edge, giving you a second window
into the same board that stays locked to that region — handy for a
reference area, a scratch space, or a checklist you want alongside your
main view.

- **Dock**: right-click a frame → *Dock to side panel*.
- The docked region's contents move into the panel and the frame
  disappears from the canvas. It's the same board, viewed twice, not a
  copy.
- Dock several frames and each gets a **vertical tab** on the edge rail.
  Click a tab to switch to it; click the active tab to minimize the panel;
  right-click a tab for that frame's menu.
- The panel has **its own pan and zoom** (per tab), a **Fit the frame
  region** button, a **Minimize** button, and **Undock**. Drag its left
  edge to resize it.
- **Drag items across the boundary** in either direction — drop something
  onto the panel and it joins the active tab; drag it out to the canvas
  and it leaves. Creating or pasting via the panel's right-click menu
  joins the active tab too.
- Membership is by **gesture, not geometry**: an item stays a member of the
  tab you dropped it into even if you then move it outside the frame's
  rectangle. The panel is a free work surface.
- A docked frame **can't be moved or resized** — its rectangle anchors its
  tab's contents. Undock first.
- **Undocking brings the frame to you**, rather than sending your view to
  it. The frame first grows to enclose everything you put in the panel, then
  the whole group lands in the middle of your current view, keeping its
  internal layout. If it's too big for the window, the canvas zooms out far
  enough to show all of it. A frame that's already fully on screen stays
  exactly where it is.
- Arrows draw when both ends are in the same window; an arrow spanning
  the boundary hides itself (the connection is not lost, and comes back
  when both ends are together again).

Which frames are docked, and what belongs to each, is part of the board
and syncs. The panel's width, which tab is active, whether it's
minimized, and each tab's pan/zoom are per-device and stay on this device.

## Pinning buttons to the toolbar

Right-click a button → **Pin to toolbar** and it leaves the canvas to
become a chip in a dock above the tool palette, always on screen at any
zoom. Useful for the two or three jumps you make constantly.

- Pinned buttons keep working exactly as before, and stay tinted with
  their color.
- Right-click a chip for *Unpin*, *Rename*, link options, *Duplicate*,
  *Copy*, *Cut*, colors, *Delete*.
- Unpinning drops the button in the middle of your current view, not back
  where it came from — after a while pinned, its old spot is usually
  somewhere you're no longer looking.
- A pinned button has no canvas presence: it's skipped by box-select,
  **Tab**, Fit, search results, and frame-carry.
- Pins are part of the board, so they follow it to your other devices.
- The dock grows upward and stops short of the toolbar; past that it
  scrolls, so pin as many as you like.
- Only buttons can be pinned today.

## Undo, and how saving works

- **Undo**: **⌘/Ctrl+Z**. **Redo**: **⌘/Ctrl+Shift+Z** (or **Ctrl+Y**).
  The toolbar buttons do the same and grey out when there's nothing to do.
- Typing and rapid nudges group into single undo steps rather than one
  step per keystroke.
- Undo covers content only. Panning and zooming are never undoable — the
  view is yours, not the board's.
- An **import** is one undo step, so you can undo a bad import.
- A Drive **pull or merge clears the undo history** (see below).
- Saving is automatic and local, about a third of a second after you stop
  editing. The **status strip** shows `saving…` then `saved` — wait for
  `saved` before closing the tab.
- If the strip turns red and reads `save failed`, the browser refused the
  write and **this board is not on disk**. Running out of browser storage is
  the realistic cause. Export the board to a file before reloading, or you'll
  lose everything since the last successful save.

## Boards

The button at the top left of the toolbar names the current board and
opens the board menu.

- **Switch**: click any row.
- **New board**: the *+ New board* button.
- **Rename**: the pencil icon on the row (renaming a Drive board renames
  its Drive file too).
- **Delete**: the trash icon. You must type `DELETE` to confirm. For a
  device board this is permanent and cannot be undone; a Drive-backed
  board's file survives in your Drive and can be re-opened.
- Each row carries a badge: **Device** (this browser only) or **Drive**.

## Export, import, clear

- **Export** downloads the whole board as `whiteboard.json` — every item,
  connection, and your current view. It's a plain, portable backup.
- **Import** replaces the current board with a JSON file (it asks first if
  the board isn't empty, and the import is undoable).
- **Clear** empties the current board. You must type `CLEAR` to confirm.
  Unlike deleting a board, a Clear *is* undoable.

## Google Drive sync

Sync is **opt-in, per board**, and there's no server involved: each board
becomes a **folder** in your own Google Drive, holding a
`.whiteboard.json` file and an `assets` folder of the board's pictures. The
app requests only the narrow permission to manage files it created. Until
you press Connect, the app makes no network requests at all.

This is also what makes Drive the right home for an image-heavy board: the
pictures live in your Drive rather than only in this browser's storage,
which the browser is free to clear. Boards saved to Drive before this
change were single files; they move into a folder of their own the next
time they sync, keeping their history and their sync state.

Open the board menu to find the Drive bar:

1. **Connect Drive** — signs in.
2. **Save to Drive** — turns the current board into a Drive-backed board.
3. **Open from Drive** — picks up a board saved from another device.
4. **Sign out** — disconnects.

Once a board is Drive-backed it reconciles in the background about every
ten seconds, plus when you switch to the board, return to the tab, or
leave the page. The Drive bar tells you where you stand: `synced`,
`changes pending…`, `syncing…`, `merging…`. Local saves are always
immediate regardless — Drive is the slower, batched layer on top.

### Reconnecting on a later visit

You only sign in once. After that, the first time you click or type on a
new visit, the app reconnects on its own — you don't need to open the
board menu, and there's no popup. Google's sign-in only lasts about an
hour per browser session, which is why a reconnect is needed at all; it
waits for a click or keypress because browsers only let a sign-in window
open in response to something you did.

If it can't reconnect silently — you signed out of Google, or revoked the
app's access — a yellow **Drive: reconnect** button appears in the status
strip at the bottom-left. That's the one Drive state visible without
opening any menu, because it's the one that means *your edits aren't
reaching Drive*. Clicking it signs you back in. Nothing appears there if
you've never connected Drive.

### When two devices edited the same board

The app merges automatically, field by field. Edits to different items,
or to different fields of the same item, all survive. Only when the same
field was changed to two different values is there a genuine conflict —
and there the copy on **the device you're using wins**, because there is
no reliable way to know which edit was newer.

You get a notice saying so ("merged, N kept this device") with a
**Review** button. The review panel shows both versions of each conflicted
item side by side and lets you flip any of them to the other device's
version — as normal, undoable edits. Local-wins is a default, not a
verdict.

If there's no shared history to merge against (the first time two copies
diverge), you're asked to choose outright: *Keep this device*, *Keep
Drive's version*, or *Decide later*.

**Two caveats worth knowing:** a pull or merge clears your undo history,
and two browser tabs on the same device editing the same board can
confuse each other's sync bookkeeping — use one tab per board.

Setting up Drive on your own deployment is covered in
[SETUP-google-drive.md](SETUP-google-drive.md).

## Settings

The cog button (next to **?**) holds board preferences. Settings are
per-device and never sync.

- **Fly to destinations** — when on, buttons, links, search results and
  deep links glide the view to their target with an eased zoom. Turn it
  off for instant cuts. Any scroll or click cancels a flight in progress,
  and the app respects your system's *reduce motion* setting.

## Touch and tablets

| Gesture | Result |
|---|---|
| One-finger drag on empty canvas | Pan |
| Two-finger pinch | Zoom (anywhere, including over items) |
| Long-press an item | Its menu (the right-click equivalent) |
| Long-press empty canvas, then drag | Box-select |
| Long-press empty canvas, release | The canvas menu |
| Tap an item / drag it | Select / move, as with a mouse |

Hit targets grow on touch devices, and everything that reveals on hover
with a mouse (ports, resize handles) also reveals when an item is
selected.

## Keyboard-only use

Every action is reachable without a pointer, with two exceptions noted
below.

The load-bearing idea is that the **canvas** and the **chrome** have
different keyboards. With focus on the canvas, **Tab** cycles board items,
arrows nudge, and letters are commands. Once focus is in the toolbar,
palette or a dialog, every key keeps its normal browser meaning — **Tab**
traverses controls, **Enter** presses buttons.

- **F6** / **Shift+F6** hop between regions: canvas → toolbar → palette →
  zoom bar → settings → help → canvas.
- **Escape** always steps *back*: close a dialog, close the board menu,
  stop editing text, leave the chrome, exit an embed's interact mode,
  clear the selection.
- **M** (or **Shift+F10**, or the Menu key) opens the context menu for the
  current selection — the same menu a right-click gives, with arrow-key
  navigation.
- Selection changes are announced to screen readers.

Known gaps, deliberately scoped rather than half-built:

- **Resize is pointer-only** — node/frame resize handles and the side
  panel's width splitter have no keyboard equivalent.
- Board items don't yet expose screen-reader object semantics, so a
  screen-reader user browsing the document (rather than driving the app's
  own keys) sees an undifferentiated canvas.
- The single-key commands are documented in the **?** panel but aren't
  machine-enumerable via `aria-keyshortcuts`.

## Full keyboard reference

### Canvas

| Action | Keys |
|---|---|
| Pan | scroll, or **Space**+drag |
| Zoom at cursor | **⌘/Ctrl**+scroll |
| Box-select | drag empty space |
| Fit everything | **Shift+1** |
| Fit the selection | **Shift+2** |
| Find & jump | **⌘/Ctrl+K** |
| Select all | **⌘/Ctrl+A** |
| Clear selection | **Escape** |

### Items

| Action | Keys |
|---|---|
| Cycle items in reading order | **Tab** / **Shift+Tab** |
| Hop to the nearest neighbour | **Alt**+**↑↓←→** |
| Nudge 10px / 1px | **↑↓←→** / **Shift**+**↑↓←→** |
| Open, edit, or press | **Enter** |
| Start a connection | **C** (then Tab/arrows to aim, **Enter** to create) |
| Select an arrow | **E** / **Shift+E** |
| Duplicate | **⌘/Ctrl+D** |
| Copy / cut / paste | **⌘/Ctrl+C** / **X** / **V** |
| Context menu | **M**, **Shift+F10**, or the Menu key |
| Delete | **Delete** or **Backspace** |

### Editing

| Action | Keys |
|---|---|
| Rename a title | double-click it |
| Label an arrow | double-click it, or **Enter** |
| Use an embedded page | double-click it |
| Undo / redo | **⌘/Ctrl+Z** / **⌘/Ctrl+Shift+Z** (**Ctrl+Y**) |
| Finish / back out | **Escape** |

### App

| Action | Keys |
|---|---|
| Hop between panels | **F6** / **Shift+F6** |
| Help & shortcuts | **?** |
| Switch boards | toolbar menu, or a `#board=<id>` link |

## Limits and gotchas

- **Boards live in this browser** unless you connect Drive. A different
  browser, a different machine, or cleared site data means a different set
  of boards. **Export** is your backup.
- **Storage is finite.** Boards live in your browser's storage, and the
  browser is allowed to clear it under pressure. Pictures are kept in a
  separate, much larger store than the board text, and they're downscaled
  on the way in — but a big library of screenshots that exists only in one
  browser is a library you could lose. Connect Drive, or export.
- **Many web pages refuse to be embedded** and render blank.
- **Re-parenting an embed reloads it** — moving one into or out of the
  side panel, or docking a region containing one, restarts that page.
- **Deleting a device board is permanent.** There is no undo and no trash.
- A **Drive pull or merge clears undo history.**
- **One tab per board.** Two tabs on the same device editing one
  Drive-backed board can confuse each other's sync state.
