# Roadmap

Ideas that are wanted but unbuilt. This is the "what we might build"
list; `ARCHITECTURE.md` is the "what you must not break" list, and its
**Deferred optimizations** section covers performance work specifically —
those are investigated-and-parked with revisit triggers, not candidates.

These were harvested from `whiteboard-plan.html`, the original 30/60/90
planning document, when it was retired: both its tracks had shipped, and
its storage section had gone stale enough to mislead (it specified
version-sentinel polling with last-write-wins whole-file saves — exactly
the design the sync work replaced with three-way merge + `guardedUpdate`).
The full plan survives in git history.

Nothing here is scheduled. The point is that each was a deliberate idea
rather than an oversight, so a later "why isn't there X?" has an answer.

## Drive sharing and ownership

The one slice of the Drive work that was planned and never started. Drive
sync itself is done (see `ARCHITECTURE.md` → *Drive sync*); what's missing
is everything around handing a board to somebody else:

- **Share through Drive's own dialog.** View vs. edit is enforced by
  Google, not by us — which is the whole appeal. A collaborator opens the
  shared file in the app via the existing Picker path.
- **"Make a copy"** — duplicate the Drive file so a shared board can be
  forked instead of co-edited. Needs `files.copy` plus a new library entry.
- **Make the ownership obvious** — an open-in-Drive link (`webViewLink`)
  and a plain statement that the data lives in the user's Drive. Currently
  nothing in the UI tells you where the file actually is.

Worth pairing with a **subtle syncing/synced affordance during background
pushes**: the Drive bar reports state, but only if the board menu is open.

## Board history

Periodic content snapshots stored alongside the board, so there's an undo
that survives a refresh.

This has a specific motivation beyond convenience. `ARCHITECTURE.md`
records two accepted limitations that both bottom out in undo being purely
in-memory: a Drive pull or merge clears the undo stacks, and rebasing undo
history across a merge is "a project of its own." Durable snapshots are
the cheaper answer to the same problem — you can't rewind the merge, but
you can recover what the board looked like before it.

The merge-review panel is the precedent for the interaction: show the
alternative, let the user commit it as ordinary undoable edits.

## Live co-editing

If real-time multiplayer ever matters, a CRDT (Yjs) wraps the same data
model. **Deliberately out of scope** while "boards are rarely
simultaneously edited" holds — the three-way merge plus the review panel
is the bet that it does.

Revisit trigger: users routinely hitting merge conflicts rather than
occasionally, i.e. the merge notice becoming familiar instead of rare.

## Embed URL presets

A saved list of URLs per embed node, with quick-switch buttons — so one
embed becomes a browsable panel rather than a fixed page.

Fits the docked-frame side panel especially well: a reference tab whose
single embed cycles between a few known pages. Note the constraint that
makes this attractive in the first place — changing an `<iframe>`'s `src`
is cheap, whereas re-parenting the element reloads it.

Storage-wise this is a field on the iframe record (an array of URLs), and
every URL still has to pass `safeNavUrl()` at the sink.

## More node types

Code blocks and sticky notes. Images are half-done already — a pasted
screenshot becomes a card holding the image, but there's no first-class
image node.

**The shape of this work is fixed, not open**: a new node type is a new
`kind` on the cards collection, dispatched in `renderCard()`. Never a new
top-level collection — deployed clients' `mergeBoards` would silently drop
it. See `ARCHITECTURE.md` → *Node kinds*.

## Design pass

Revisit the whole visual language as one piece rather than per-feature:
color scheme, type scale, spacing, card and frame chrome, connection
styling, toolbar. The original plan called the gold-on-slate palette
(`--accent: #FFC629`) provisional pending this pass, and it still is.

## Scaling a very large board

Two size ceilings that haven't been hit yet, recorded so the reasoning
isn't lost:

- **Browser storage.** localStorage is the whole database, and pasted
  images are the realistic way to exhaust it (they're already downscaled
  on the way in). A board of hundreds of screenshots is the failure case.
- **Splitting a board across files.** The original plan proposed
  per-node documents for this; its stated 1 MiB trigger was Firestore's
  limit, and doesn't transfer to a Drive file, so the premise needs
  redoing before the idea does. The keyed-map data model does keep the
  change mechanical whenever it's actually needed.
