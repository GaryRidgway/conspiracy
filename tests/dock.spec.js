// ════════════════════════════════════════════════════════════════════════
//  DOCKED FRAME WINDOW
//  Right-click a frame → "Dock to side panel": the frame's region becomes a
//  second window (#dock-panel) into the same world. Exclusive model — while
//  docked, the region's nodes live in #dock-world (the canvas shows only the
//  frame's collapsed tab), so every node still has exactly one element.
//  Both windows share world coordinates, which is what makes cross-window
//  drags work. Membership is STICKY, not geometric: an explicit `dockMembers`
//  list on the frame's own card record, so it's board content that syncs and
//  undoes. Only the arrangement (active tab, minimized, width, per-tab
//  pan/zoom) is per-device view state riding the viewport key.
// ════════════════════════════════════════════════════════════════════════
import { test, expect } from '@playwright/test';
import { drag, addCardAt, nodePos, worldScale, installErrorGuard } from './helpers.js';

const EMBED_URL = 'http://localhost:8123/tests/fixtures/embed.html';

// default frame: 640×400 at the view centre (≈ screen (320,160)–(960,560))
async function addFrame(page) {
  await page.click('#addFrameNode');
  await page.keyboard.press('Escape');
  return page.locator('.frame-node');
}
async function dockViaMenu(page) {
  await page.locator('.frame-node .frame-tab').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Dock to side panel' }).click();
  await expect(page.locator('#dock-panel')).toBeVisible();
}
const parentWorld = (loc) => loc.evaluate((el) => el.parentElement.id);
const mainTransform = (page) => page.evaluate(() => document.getElementById('world').style.transform);
const dockTransform = (page) => page.evaluate(() => document.getElementById('dock-world').style.transform);

installErrorGuard(test);

test('docking a frame moves its contents into the panel; undocking returns them', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const inside = await addCardAt(page, 640, 360);            // inside the region
  const outside = await addCardAt(page, 150, 640);           // canvas-only
  await dockViaMenu(page);

  await expect(page.locator('#dock-active-name')).toHaveText('Frame');
  expect(await parentWorld(inside)).toBe('dock-world');      // region node → panel
  expect(await parentWorld(outside)).toBe('world');          // the rest stays put
  await expect(page.locator('.frame-node')).toHaveClass(/frame-docked/);
  await expect(page.locator('.frame-node')).toBeHidden();    // no ghost on the canvas

  // the member is visible inside the panel's bounds
  const panel = await page.locator('#dock-panel').boundingBox();
  const bb = await inside.boundingBox();
  expect(bb.x).toBeGreaterThan(panel.x);

  await page.click('#dockUndockBtn');
  await expect(page.locator('#dock-panel')).toBeHidden();
  expect(await parentWorld(inside)).toBe('world');
  await expect(page.locator('.frame-node')).not.toHaveClass(/frame-docked/);
  await expect(page.locator('.frame-node')).toBeVisible();   // ghost restored
});

test('the panel pans and zooms independently of the main canvas', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  await addCardAt(page, 640, 360);
  await dockViaMenu(page);
  const main0 = await mainTransform(page);
  const dock0 = await dockTransform(page);

  // wheel-pan inside the panel: only the panel's transform moves
  const panel = await page.locator('#dock-viewport').boundingBox();
  await page.evaluate(([x, y]) => {
    document.getElementById('dock-viewport').dispatchEvent(new WheelEvent('wheel',
      { deltaX: 80, deltaY: 60, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, [panel.x + 100, panel.y + 100]);
  await expect.poll(() => dockTransform(page)).not.toBe(dock0);
  expect(await mainTransform(page)).toBe(main0);

  // wheel-pan on the canvas: the panel holds still
  const dock1 = await dockTransform(page);
  await page.evaluate(() => {
    document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel',
      { deltaX: 120, deltaY: 0, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => mainTransform(page)).not.toBe(main0);
  expect(await dockTransform(page)).toBe(dock1);
});

test('dragging a card from the canvas into the panel re-homes it into the region', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 170, 620);              // well outside the region
  await dockViaMenu(page);
  expect(await parentWorld(card)).toBe('world');

  // grab it by the MIDDLE of its header (a large grab offset), and hold it
  // over the panel before releasing: the ghost must follow the cursor across
  // the boundary (live reparent), not render back on the canvas
  const hb = await card.locator('.card-header').boundingBox();
  const panel = await page.locator('#dock-viewport').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move((hb.x + panel.x) / 2, (hb.y + panel.y + panel.height / 2) / 2, { steps: 6 });
  // hover near the panel's LEFT EDGE — with the grab offset, the card's box
  // pokes past the region's edge here; the drop must settle it fully inside
  await page.mouse.move(panel.x + 40, panel.y + panel.height / 2, { steps: 6 });
  expect(await parentWorld(card)).toBe('dock-world');        // follows mid-drag
  await page.mouse.up();

  expect(await parentWorld(card)).toBe('dock-world');        // and stays after the drop
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await expect(card).toBeVisible();                          // visible where it was dropped

  // and back out: drop over empty canvas → it leaves the region. Grab a
  // VISIBLE part of the header — the card may overhang the panel's edge,
  // and the overhang is clipped (unhittable).
  const hb2 = await card.locator('.card-header').boundingBox();
  const panel2 = await page.locator('#dock-viewport').boundingBox();
  const gx = Math.max(hb2.x + 24, panel2.x + 12);
  await drag(page, { x: gx, y: hb2.y + hb2.height / 2 }, { x: 200, y: 620 });
  expect(await parentWorld(card)).toBe('world');
});

test('arrows: inside the panel they draw in its own layer; spanning arrows hide until undock', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const a = await addCardAt(page, 560, 300);                 // both inside the region
  const b = await addCardAt(page, 760, 430);
  const outside = await addCardAt(page, 150, 640);
  // connect a→b and a→outside by dragging ports
  const connect = async (fromLoc, toLoc) => {
    await fromLoc.hover();
    const port = fromLoc.locator('.port.right');
    const pb = await port.boundingBox();
    const tb = await toLoc.boundingBox();
    await drag(page, { x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 },
                     { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 });
  };
  await connect(a, b);
  await connect(a, outside);
  await expect(page.locator('#connections .conn')).toHaveCount(2);

  await dockViaMenu(page);
  // the internal arrow moved to the panel's SVG and still has a path
  await expect(page.locator('#dock-connections .conn')).toHaveCount(1);
  expect(await page.locator('#dock-connections .conn .line').getAttribute('d')).toMatch(/^M/);
  // the spanning arrow is hidden (its record survives)
  await expect(page.locator('#connections .conn')).toHaveCount(1);
  await expect(page.locator('#connections .conn')).toBeHidden();

  await page.click('#dockUndockBtn');
  await expect(page.locator('#connections .conn')).toHaveCount(2);
  await expect(page.locator('#connections .conn').first()).toBeVisible();
});

test('multiple frames dock as tabs: switching stows one region and shows the other', { tag: '@dock' }, async ({ page }) => {
  // frame A with a card, then a second frame elsewhere with its own card
  await addFrame(page);                                       // 640×400 at view centre
  await page.locator('.frame-node .frame-name').dblclick();
  await page.keyboard.type('Alpha');
  await page.keyboard.press('Enter');
  const cardA = await addCardAt(page, 640, 360);
  await dockViaMenu(page);

  // second frame on the now-clear canvas
  await page.click('#addFrameNode');
  await page.keyboard.type('Beta');
  await page.keyboard.press('Enter');
  const cardB = await addCardAt(page, 500, 300);
  await page.locator('.frame-node:not(.frame-docked) .frame-tab').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Dock to side panel' }).click();

  const tabs = page.locator('#dock-rail .dock-rail-tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveClass(/active/);            // newest tab is active
  await expect(page.locator('#dock-active-name')).toHaveText('Beta');
  await expect(cardB).toBeVisible();                          // Beta's card shows
  await expect(cardA).toBeHidden();                           // Alpha's card is stowed
  expect(await parentWorld(cardA)).toBe('dock-world');        // …but still off-canvas

  await tabs.nth(0).click();                                  // switch to Alpha
  await expect(cardA).toBeVisible();
  await expect(cardB).toBeHidden();

  // undock Beta via its rail tab's context menu: its region returns to the
  // canvas, Alpha stays docked
  await tabs.nth(1).click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Undock' }).click();
  await expect(page.locator('#dock-rail .dock-rail-tab')).toHaveCount(1);
  expect(await parentWorld(cardB)).toBe('world');
  expect(await parentWorld(cardA)).toBe('dock-world');

  // both-tab arrangement survives reload
  await page.locator('.frame-node:not(.frame-docked) .frame-tab').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Dock to side panel' }).click();
  await expect(page.locator('#dock-rail .dock-rail-tab')).toHaveCount(2);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await page.reload();
  await expect(page.locator('#dock-rail .dock-rail-tab')).toHaveCount(2);
});

test('a member dropped in the panel\'s top third stays exactly where dropped (no snap-away)', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 300);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await dockViaMenu(page);

  // the fitted region occupies the panel's middle band; drag the card into
  // the TOP THIRD of the panel (world space above the frame's rect). The
  // panel is a free work surface — the drop position is law.
  const pv = await page.locator('#dock-viewport').boundingBox();
  const hb = await card.locator('.card-header').boundingBox();
  await page.mouse.move(hb.x + 24, hb.y + 10);
  await page.mouse.down();
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height * 0.15, { steps: 8 });
  const preDrop = await nodePos(card);
  await page.mouse.up();
  const postDrop = await nodePos(card);
  expect(postDrop).toEqual(preDrop);                          // zero movement on release
  expect(await parentWorld(card)).toBe('dock-world');         // still a member
  await expect(card).toBeVisible();

  // bottom third too
  const hb2 = await card.locator('.card-header').boundingBox();
  await page.mouse.move(hb2.x + 24, hb2.y + 10);
  await page.mouse.down();
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height * 0.85, { steps: 8 });
  const preDrop2 = await nodePos(card);
  await page.mouse.up();
  expect(await nodePos(card)).toEqual(preDrop2);
  expect(await parentWorld(card)).toBe('dock-world');

  // and the placement survives the panel's per-device persistence
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await page.waitForTimeout(500);
  await page.reload();
  expect(await parentWorld(page.locator('.node.card'))).toBe('dock-world');
});

test('minimize flies the region off screen to an edge tab; restore brings it back', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 360);
  await dockViaMenu(page);

  await page.click('#dockMinBtn');
  await expect(page.locator('#dock-panel')).toBeHidden();
  const railTab = page.locator('#dock-rail .dock-rail-tab');
  await expect(railTab).toBeVisible();
  await expect(railTab).toHaveText('Frame');
  await expect(card).toBeHidden();                           // stowed with the panel

  await railTab.click();
  await expect(page.locator('#dock-panel')).toBeVisible();
  await expect(card).toBeVisible();

  // clicking the ACTIVE rail tab minimizes again (fewer-clicks toggle)
  await railTab.click();
  await expect(page.locator('#dock-panel')).toBeHidden();
  await railTab.click();
  await expect(page.locator('#dock-panel')).toBeVisible();
});

test('rail tabs open the frame menu: color them like frames, rename via the pill', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  await dockViaMenu(page);
  const railTab = page.locator('#dock-rail .dock-rail-tab');

  // color from the tab's right-click menu — the tab AND the header pill tint
  await railTab.click({ button: 'right' });
  await page.locator('#context-menu .ctx-swatch[title="Purple"]').click();
  await expect(railTab).toHaveClass(/colored/);
  await expect(page.locator('#dock-panel')).toHaveClass(/colored/);
  // …and it IS the frame's color (stored on the record, syncs like any color)
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  expect(await page.evaluate(() => {
    const b = JSON.parse(localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current')));
    return Object.values(b.cards).find((c) => c.kind === 'frame').color;
  })).toBe('purple');

  // rename from the same menu, editing the header pill in place
  await railTab.click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Rename' }).click();
  await page.keyboard.type('War room');
  await page.keyboard.press('Enter');
  await expect(page.locator('#dock-active-name')).toHaveText('War room');
  await expect(railTab).toHaveText('War room');

  // undock: the frame comes back colored and renamed
  await page.click('#dockUndockBtn');
  await expect(page.locator('.frame-node')).toHaveClass(/colored/);
  await expect(page.locator('.frame-node .frame-name')).toHaveText('War room');
});

test('undocking grows the frame to fully contain members placed outside its rect', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 300);
  const id = await card.getAttribute('data-id');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await dockViaMenu(page);

  // park the member in the panel's top area — world space above the rect
  const pv = await page.locator('#dock-viewport').boundingBox();
  const hb = await card.locator('.card-header').boundingBox();
  await drag(page, { x: hb.x + 24, y: hb.y + 10 }, { x: pv.x + pv.width / 2, y: pv.y + pv.height * 0.12 });
  expect(await parentWorld(card)).toBe('dock-world');

  await page.click('#dockUndockBtn');
  await expect(page.locator('#dock-panel')).toBeHidden();
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  // the frame's rect now fully contains the card
  const rec = await page.evaluate((id) => {
    const b = JSON.parse(localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current')));
    const fr = Object.values(b.cards).find((c) => c.kind === 'frame');
    const el = document.querySelector(`.node.card[data-id="${id}"]`);
    const c = b.cards[id];
    return { fr, card: { x: c.x, y: c.y, w: el.offsetWidth, h: el.offsetHeight } };
  }, id);
  expect(rec.card.x).toBeGreaterThanOrEqual(rec.fr.x);
  expect(rec.card.y).toBeGreaterThanOrEqual(rec.fr.y);
  expect(rec.card.x + rec.card.w).toBeLessThanOrEqual(rec.fr.x + rec.fr.w);
  expect(rec.card.y + rec.card.h).toBeLessThanOrEqual(rec.fr.y + rec.fr.h);
});

test('docking and undocking ride the undo history', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 360);
  await dockViaMenu(page);
  expect(await parentWorld(card)).toBe('dock-world');

  // undo the dock: panel closes, the region is back on the canvas
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#dock-panel')).toBeHidden();
  expect(await parentWorld(card)).toBe('world');
  await expect(page.locator('.frame-node')).toBeVisible();

  // redo: docked again, membership restored
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('#dock-panel')).toBeVisible();
  expect(await parentWorld(card)).toBe('dock-world');

  // undock (grows nothing here), then undo THAT: docked again
  await page.click('#dockUndockBtn');
  await expect(page.locator('#dock-panel')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#dock-panel')).toBeVisible();
  expect(await parentWorld(card)).toBe('dock-world');
});

test('editing chrome scales with the panel zoom', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 360);
  await dockViaMenu(page);                        // fit zoom ≈ 0.6 → clamped scale 0.7
  await card.locator('.card-body').click();
  await expect(page.locator('#text-toolbar')).toBeVisible();
  const tf = await page.locator('#text-toolbar').evaluate((el) => el.style.transform);
  expect(tf).toMatch(/scale\(0\.7/);
});

test('the docked window survives a reload (per-device view state)', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 360);
  const id = await card.getAttribute('data-id');
  await dockViaMenu(page);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await page.waitForTimeout(500);                            // debounced viewport save

  await page.reload();
  await expect(page.locator('#dock-panel')).toBeVisible();
  expect(await parentWorld(page.locator(`.node.card[data-id="${id}"]`))).toBe('dock-world');
  await expect(page.locator('.frame-node')).toHaveClass(/frame-docked/);
});

test('canvas tools ignore the panel: marquee and Fit act on canvas nodes only', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const member = await addCardAt(page, 640, 360);
  const canvasCard = await addCardAt(page, 200, 620);
  await dockViaMenu(page);

  // canvas marquee sweeps the whole visible canvas — the member (whose world
  // coords sit in the hidden region) must not join
  await drag(page, { x: 60, y: 120 }, { x: 820, y: 680 });
  await expect(canvasCard).toHaveClass(/selected/);
  await expect(member).not.toHaveClass(/selected/);

  // marquee inside the panel selects the member only
  const panel = await page.locator('#dock-viewport').boundingBox();
  await drag(page, { x: panel.x + 8, y: panel.y + 8 },
                   { x: panel.x + panel.width - 8, y: panel.y + panel.height - 8 });
  await expect(member).toHaveClass(/selected/);
  await expect(canvasCard).not.toHaveClass(/selected/);

  // Fit frames canvas content only: with the member stowed, the main view
  // centers on the remaining card rather than flying to the hidden region
  await page.keyboard.press('Escape');
  const t0 = await mainTransform(page);
  await page.click('#fitContent');
  await expect.poll(() => mainTransform(page)).not.toBe(t0);
  const vp = page.viewportSize();
  const cb = await canvasCard.boundingBox();
  expect(cb.x).toBeGreaterThan(0);
  expect(cb.x + cb.width).toBeLessThan(vp.width);
});

test('"Add card here" from inside the panel creates the card in the region', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  await dockViaMenu(page);

  // right-click near the panel's top — the point maps ABOVE the frame rect,
  // and that's fine: membership is sticky, so the card joins the tab and
  // lands exactly where clicked
  const pv = await page.locator('#dock-viewport').boundingBox();
  await page.mouse.click(pv.x + pv.width / 2, pv.y + 60, { button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Add card here' }).click();
  await page.keyboard.type('Born in panel');
  await page.keyboard.press('Escape');

  const card = page.locator('.node.card');
  await expect(card).toHaveCount(1);
  expect(await parentWorld(card)).toBe('dock-world');
  const bb = await card.boundingBox();
  expect(bb.x).toBeGreaterThan(pv.x);              // visible inside the panel
});

test('buttons navigate across windows: each window pans only for its own targets', { tag: ['@dock', '@nav'] }, async ({ page }) => {
  await addFrame(page);
  const note = await addCardAt(page, 480, 260);            // in the region
  await note.locator('.card-title').dblclick();
  await page.keyboard.type('Alpha note');
  await page.keyboard.press('Enter');
  const far = await addCardAt(page, 200, 640);             // canvas
  await far.locator('.card-title').dblclick();
  await page.keyboard.type('Far target');
  await page.keyboard.press('Enter');

  const addButtonTo = async (filter, x, y) => {
    await page.click('#addButton');
    await page.locator('#button-link-modal input').fill(filter);
    await page.locator('#button-link-modal .np-item').first().click();
    const id = await page.locator('.btn-node:not(.pin-chip)').last().getAttribute('data-id');
    const btn = page.locator(`.btn-node[data-id="${id}"]`);
    const bb = await btn.boundingBox();
    await drag(page, { x: bb.x + 20, y: bb.y + 14 }, { x: x + 20, y: y + 14 });
    return btn;
  };
  const btnToFar = await addButtonTo('far target', 620, 500);   // lives in the region
  const btnToNote = await addButtonTo('alpha note', 130, 380);  // lives on the canvas
  await dockViaMenu(page);
  expect(await parentWorld(btnToFar)).toBe('dock-world');

  // panel button → canvas target: MAIN pans, panel holds still
  let m0 = await mainTransform(page), d0 = await dockTransform(page);
  await btnToFar.click();
  await expect(far).toHaveClass(/selected/);
  expect(await mainTransform(page)).not.toBe(m0);
  expect(await dockTransform(page)).toBe(d0);

  // canvas button → panel target: PANEL pans (capped at 100% so the rest of
  // the notes area stays in view), main holds still
  await page.click('#fitContent');
  m0 = await mainTransform(page); d0 = await dockTransform(page);
  await btnToNote.click();
  await expect(note).toHaveClass(/selected/);
  expect(await dockTransform(page)).not.toBe(d0);
  expect(await mainTransform(page)).toBe(m0);
  expect(await dockTransform(page)).not.toMatch(/scale\([1-9]\d*\.\d*[1-9]/); // no >1 zoom blow-up
  await expect(btnToFar).toBeVisible();                    // context survived the jump
});

test('jumping to a node in the panel pans the panel, not the canvas', { tag: ['@dock', '@nav'] }, async ({ page }) => {
  await addFrame(page);
  const member = await addCardAt(page, 640, 360);
  await member.locator('.card-title').dblclick();
  await page.keyboard.type('Deep clue');
  await page.keyboard.press('Enter');
  await dockViaMenu(page);
  const main0 = await mainTransform(page);

  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('deep clue');
  await expect(page.locator('#jump-list .np-item')).toHaveCount(1);
  await page.keyboard.press('Enter');

  expect(await mainTransform(page)).toBe(main0);             // canvas untouched
  await expect(member).toHaveClass(/selected/);
  const panel = await page.locator('#dock-viewport').boundingBox();
  const bb = await member.boundingBox();
  expect(bb.x).toBeGreaterThan(panel.x);                     // centered in the panel
  expect(bb.x + bb.width).toBeLessThan(panel.x + panel.width + 1);
});

// ════════════════════════════════════════════════════════════════════════
//  DOCK vs DRIVE SYNC RACE
//  Dock membership is real, synced content (a frame card's `dockMembers`
//  field) — deriveDockTabs rebuilds dock.tabs from whatever board.cards
//  currently says on every reconcile (boot, board-switch, undo/redo, Drive
//  pull/merge), not just once at load. So a frame missing from a stale local
//  snapshot at load time isn't a permanent loss: once Drive delivers the
//  frame (with its dockMembers intact), the very next reconcile picks it
//  back up automatically.
// ════════════════════════════════════════════════════════════════════════
test('a Drive pull landing after load recovers dock state a stale local snapshot dropped', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 360);
  const cardId = await card.getAttribute('data-id');
  await dockViaMenu(page);
  const frameId = await page.locator('.frame-node').getAttribute('data-id');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await page.waitForTimeout(500);                            // debounced viewport (dock) save

  // capture the fully-synced content — this is what "Drive" will later deliver
  const { boardKey, goodContent } = await page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    const boardKey = 'whiteboard:board:' + cur;
    return { boardKey, goodContent: JSON.parse(localStorage.getItem(boardKey)) };
  });

  // simulate a local cache that's behind Drive: this device hasn't pulled the
  // frame card back down yet, even though its own per-device dock preference
  // still names it
  await page.addInitScript(([boardKey, frameId]) => {
    const b = JSON.parse(localStorage.getItem(boardKey));
    delete b.cards[frameId];
    localStorage.setItem(boardKey, JSON.stringify(b));
  }, [boardKey, frameId]);
  await page.reload();
  await expect(page.locator('#dock-panel')).toBeHidden();    // restore dropped the "missing" frame's tab
  await expect(page.locator(`[data-id="${frameId}"]`)).toHaveCount(0);

  // the Drive pull lands moments later with the frame back in it
  await page.evaluate((content) => {
    window.__wb_applyPulledBoard(localStorage.getItem('whiteboard:current'), content);
  }, goodContent);

  await expect(page.locator('#dock-panel')).toBeVisible();
  await expect(page.locator(`.frame-node[data-id="${frameId}"]`)).toHaveClass(/frame-docked/);
  expect(await parentWorld(page.locator(`.node.card[data-id="${cardId}"]`))).toBe('dock-world');
});

// ════════════════════════════════════════════════════════════════════════
//  LEGACY DOCK MIGRATION
//  Dock membership used to live only in the per-device chrome key. Adopt an
//  existing per-device dock into the frame card's synced `dockMembers` the
//  first time it loads under the new scheme.
// ════════════════════════════════════════════════════════════════════════
test('a pre-migration per-device dock is adopted into synced dockMembers on load', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const member = await addCardAt(page, 640, 360);
  const memberId = await member.getAttribute('data-id');
  const frameId = await page.locator('.frame-node').getAttribute('data-id');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  // simulate a pre-migration per-device dock: the frame docked, membership
  // only in the old per-device shape — the frame card itself has no
  // dockMembers yet, exactly as it would look right after this deploy lands.
  // addInitScript (not a plain evaluate before reload): reload fires pagehide
  // on the current page first, which flushes the real (empty) dock and would
  // clobber a plain write before the new page even boots.
  await page.addInitScript(([frameId, memberId]) => {
    const cur = localStorage.getItem('whiteboard:current');
    if (!cur) return;
    const key = 'whiteboard:viewport:' + cur;
    if (JSON.parse(localStorage.getItem(key) || 'null')?.dock) return;   // already migrated
    localStorage.setItem(key, JSON.stringify({
      x: 0, y: 0, zoom: 1,
      dock: { width: 420, minimized: false, active: frameId,
        tabs: [{ frameId, members: [memberId], x: 0, y: 0, zoom: 1 }] },
    }));
  }, [frameId, memberId]);
  await page.reload();

  await expect(page.locator('#dock-panel')).toBeVisible();
  await expect(page.locator(`.frame-node[data-id="${frameId}"]`)).toHaveClass(/frame-docked/);
  const stored = await page.evaluate((frameId) => {
    const cur = localStorage.getItem('whiteboard:current');
    const b = JSON.parse(localStorage.getItem('whiteboard:board:' + cur));
    return b.cards[frameId].dockMembers;
  }, frameId);
  expect(stored).toEqual([memberId]);
});

// ════════════════════════════════════════════════════════════════════════
//  NO STRAY SELECTION IN THE PANEL
//  The dock is a SECOND window (#dock-panel), a sibling of #viewport — so the
//  canvas's user-select:none doesn't reach it. Without a rule of its own, a
//  double-click to enter interact mode also starts a text selection, and a
//  range spanning the <iframe> paints the whole embed in the selection color.
// ════════════════════════════════════════════════════════════════════════
test('double-clicking a docked embed enters interact mode without selecting it', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);                                    // region at the view centre
  // an embed whose centre sits in the region → it docks along with the frame
  await page.click('#addFrame');
  await expect(page.locator('#frame-modal')).toBeVisible();
  await page.fill('#frame-url', EMBED_URL);
  await page.click('#frame-add');
  await expect(page.locator('#frame-modal')).toBeHidden();

  const embed = page.locator('.node.iframe-node');
  await dockViaMenu(page);
  expect(await parentWorld(embed)).toBe('dock-world');     // reparented into the panel
  await expect(embed).toHaveClass(/loaded/);               // active-dock embeds load on their own
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  const box = await embed.boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(embed).toHaveClass(/interactive/);          // the dblclick still does its real job
  // …and left nothing selected: no caret range, no highlighted embed
  expect(await page.evaluate(() => {
    const s = window.getSelection();
    return { text: s.toString(), collapsed: s.isCollapsed };
  })).toEqual({ text: '', collapsed: true });
});

// Reparenting an <iframe> reloads its page (ARCHITECTURE.md: inherent, accepted),
// so dock/undock refetches every embed in the region. The element keeps .loaded
// through that, which used to leave a blank box with no sign anything was
// coming — reading as "the embed disappeared". The placeholder has to come back
// for the duration.
test('an embed reparented by docking shows its placeholder until the reload paints', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  await page.click('#addFrame');
  await page.fill('#frame-url', EMBED_URL);
  await page.click('#frame-add');
  const embed = page.locator('.node.iframe-node');
  await expect(embed.locator('iframe')).toHaveAttribute('src', EMBED_URL);
  await expect(embed).toHaveClass(/loaded/);
  await expect(embed.locator('.frame-placeholder')).toBeHidden();

  // hold the refetch open so the transient state is observable at all
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  await page.route(EMBED_URL, async (route) => { await held; await route.continue(); });

  await dockViaMenu(page);
  await expect(embed).toHaveClass(/reloading/);
  await expect(embed.locator('.frame-placeholder')).toBeVisible();
  await expect(embed.locator('.ph-note')).toHaveText(/reloading/i);

  release();
  await expect(embed).not.toHaveClass(/reloading/);
  await expect(embed.locator('.frame-placeholder')).toBeHidden();
  await expect(embed.locator('.ph-note')).toHaveText(/click to load/i);   // idle text restored
});

// The panel carries its own pan/zoom, so a frame's world position is usually
// nowhere near where the canvas is looking. Undocking used to hand the region
// back at those coordinates — off screen, reading as "my contents vanished".
// It now comes to the user instead: the frame and every member translate
// rigidly to the middle of the visible canvas.
test('undocking lands the region in the middle of the current view', { tag: ['@dock', '@nav'] }, async ({ page }) => {
  const frame = await addFrame(page);
  const card = await addCardAt(page, 640, 360);
  const framePos = await nodePos(frame);
  const before = await nodePos(card);
  const offset = { x: before.x - framePos.x, y: before.y - framePos.y };
  await dockViaMenu(page);

  // wander the canvas away from the region's world coordinates
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 4; i++) v.dispatchEvent(new WheelEvent('wheel',
      { deltaX: 900, deltaY: 500, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  await page.click('#dockUndockBtn');
  await expect(page.locator('#dock-panel')).toBeHidden();

  // the whole frame is on screen…
  const box = await frame.boundingBox();
  const vp = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  // …and roughly centred horizontally (vertically the toolbar shifts it down)
  expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(40);

  // the member travelled by the same delta — relative layout is preserved
  const afterFrame = await nodePos(frame);
  const after = await nodePos(card);
  expect(after.x - afterFrame.x).toBe(offset.x);
  expect(after.y - afterFrame.y).toBe(offset.y);

  // and the whole undock, move included, is ONE undo step
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#dock-panel')).toBeVisible();
  expect(await nodePos(card)).toEqual(before);
});

// Centring alone isn't enough when the region is bigger than the window — at
// 300% a default 640x400 frame is 1920x1200. Pull the camera back just far
// enough, and never the other way: a small region must not commandeer the zoom
// level the user picked.
test('undocking zooms out only when the region overflows the view', { tag: ['@dock', '@nav'] }, async ({ page }) => {
  const frame = await addFrame(page);
  await addCardAt(page, 640, 360);
  await dockViaMenu(page);
  const zoomIn = (n) => page.evaluate((count) => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < count; i++) v.dispatchEvent(new WheelEvent('wheel',
      { deltaY: -600, clientX: 600, clientY: 400, ctrlKey: true, bubbles: true, cancelable: true }));
  }, n);

  await zoomIn(14);
  const zoomed = await worldScale(page);
  expect(zoomed).toBeGreaterThan(2);
  await page.click('#dockUndockBtn');
  await expect(page.locator('#dock-panel')).toBeHidden();

  expect(await worldScale(page)).toBeLessThan(zoomed);      // pulled back
  const box = await frame.boundingBox();                    // and it all fits
  const vp = page.viewportSize();
  expect(box.width).toBeLessThanOrEqual(vp.width);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
});

test('undocking a frame already in view moves nothing and leaves the camera alone', { tag: ['@dock', '@nav'] }, async ({ page }) => {
  const frame = await addFrame(page);
  const card = await addCardAt(page, 560, 300);             // well inside the region
  // shrink the world so the default frame sits comfortably inside the view
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 6; i++) v.dispatchEvent(new WheelEvent('wheel',
      { deltaY: 600, clientX: 600, clientY: 400, ctrlKey: true, bubbles: true, cancelable: true }));
  });
  const framePos = await nodePos(frame);
  const cardPos = await nodePos(card);
  const zoom = await worldScale(page);
  await dockViaMenu(page);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  await page.click('#dockUndockBtn');
  await expect(page.locator('#dock-panel')).toBeHidden();
  expect(await nodePos(frame)).toEqual(framePos);           // untouched content…
  expect(await nodePos(card)).toEqual(cardPos);
  expect(await worldScale(page)).toBeCloseTo(zoom, 5);      // …and untouched camera
});

// The suite pre-seeds fly-to OFF, so the landing above always cuts instantly.
// The app's own default is ON, and undocking is the one navigation that also
// mutates content in the same breath — the animated path has to reach the same
// place and not strand the camera mid-flight.
test.describe('undocking with fly-to at its default', { tag: ['@dock', '@nav'] }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('an animated landing settles with the region framed and the viewport saved', async ({ page }) => {
    const frame = await addFrame(page);
    await addCardAt(page, 640, 360);
    await dockViaMenu(page);
    await page.evaluate(() => {
      const v = document.getElementById('viewport');
      for (let i = 0; i < 14; i++) v.dispatchEvent(new WheelEvent('wheel',
        { deltaY: -600, clientX: 600, clientY: 400, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    const zoomed = await worldScale(page);
    await page.click('#dockUndockBtn');
    await expect(page.locator('#dock-panel')).toBeHidden();

    // let the flight land, then assert the destination — not a frozen mid-hop
    await expect.poll(() => worldScale(page)).toBeLessThan(zoomed);
    await page.waitForTimeout(900);
    const settled = await worldScale(page);
    const box = await frame.boundingBox();
    const vp = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);

    // the landed viewport reached storage (the flight commits on arrival)
    await expect.poll(() => page.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => x.startsWith('whiteboard:viewport:'));
      return k ? JSON.parse(localStorage.getItem(k)).zoom : null;
    })).toBeCloseTo(settled, 3);
  });
});

// ── Embed sizing inside the panel ──
// layoutFrame() scales the inner iframe from wrap.clientWidth, which is 0 inside
// a display:none subtree. renderAll renders nodes BEFORE syncDockPanel() un-hides
// the panel, so every embed in a docked frame booted at scale(0): a blank box,
// with `loaded` already set so not even the placeholder showed. Nothing
// re-measured it, so it stayed blank until the frame was resized by hand.
test('a docked embed is sized, not collapsed, after a reload', { tag: ['@dock', '@frames'] }, async ({ page }) => {
  await addFrame(page);
  await page.click('#addFrame');
  await page.fill('#frame-url', EMBED_URL);
  await page.click('#frame-add');
  await page.keyboard.press('Escape');
  await expect(page.locator('.iframe-node')).toHaveClass(/loaded/);
  await dockViaMenu(page);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  const before = await page.locator('.iframe-frame').boundingBox();
  expect(before.width).toBeGreaterThan(0);

  await page.reload();
  await expect(page.locator('#dock-panel')).toBeVisible();
  await expect(page.locator('.iframe-node')).toHaveClass(/loaded/);
  // the whole bug: a rendered, loaded embed with no size
  await expect.poll(async () => (await page.locator('.iframe-frame').boundingBox()).width)
    .toBeCloseTo(before.width, 0);
  const after = await page.locator('.iframe-frame').boundingBox();
  expect(after.height).toBeCloseTo(before.height, 0);
});

// Same measurement, reached the other way: minimized means display:none too, so
// a render while minimized must not bake in the collapsed scale either.
test('restoring a minimized panel sizes its embeds', { tag: ['@dock', '@frames'] }, async ({ page }) => {
  await addFrame(page);
  await page.click('#addFrame');
  await page.fill('#frame-url', EMBED_URL);
  await page.click('#frame-add');
  await page.keyboard.press('Escape');
  await dockViaMenu(page);
  const before = await page.locator('.iframe-frame').boundingBox();

  await page.locator('.dock-rail-tab.active').click();          // minimize
  await expect(page.locator('#dock-panel')).toBeHidden();
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await page.reload();                                          // renders while hidden
  await expect(page.locator('#dock-rail')).toBeVisible();
  await page.locator('.dock-rail-tab').first().click();         // restore
  await expect(page.locator('#dock-panel')).toBeVisible();

  await expect.poll(async () => (await page.locator('.iframe-frame').boundingBox()).width)
    .toBeCloseTo(before.width, 0);
});
