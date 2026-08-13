// ════════════════════════════════════════════════════════════════════════
//  DOCKED SIDE WINDOW
//  Right-click a frame, card or embed → "Dock to side panel". A FRAME's region
//  becomes a second window (#dock-panel) into the same world: its nodes live in
//  #dock-world, every node still has exactly one element, both windows share
//  world coordinates (which is what makes cross-window drags work), and
//  membership is STICKY — an explicit `dockMembers` list on the frame's own
//  record, board content that syncs and undoes. A CARD or EMBED instead becomes
//  THE PANEL: it fills #dock-item with no world, no camera and no members, so
//  the width splitter resizes the item (see ITEM TABS at the foot of this
//  file). Only the arrangement (active tab, minimized, width, per-region-tab
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
// #dock-world is a 0x0 transform holder, so "is it visible" is always false —
// whether it's the live container is a question about `display`.
const worldDisplay = (page) => page.evaluate(() =>
  getComputedStyle(document.getElementById('dock-world')).display);
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

// The panel is a WINDOW, not just its scroll area: #dock-header (title +
// Fit/Minimize/Undock) and #dock-resizer are inside #dock-panel but outside
// #dock-viewport. Dragging a member up to the top of the panel used to run
// the pointer off the viewport's rect, which read as "released over the
// canvas" — the node was stripped from `dockMembers` and handed back to a
// canvas that is looking somewhere else entirely, so it read as ejected.
test('a member dragged onto the panel\'s own chrome stays a member', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 300);
  const cardId = await card.getAttribute('data-id');
  const frameId = await page.locator('.frame-node').getAttribute('data-id');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await dockViaMenu(page);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  const members = () => page.evaluate((frameId) => {
    const cur = localStorage.getItem('whiteboard:current');
    return JSON.parse(localStorage.getItem('whiteboard:board:' + cur)).cards[frameId].dockMembers;
  }, frameId);
  expect(await members()).toContain(cardId);

  // release with the pointer over the title bar — still inside the panel
  const hd = await page.locator('#dock-header').boundingBox();
  const hb = await card.locator('.card-header').boundingBox();
  await page.mouse.move(hb.x + 24, hb.y + 10);
  await page.mouse.down();
  await page.mouse.move(hd.x + hd.width / 2, hd.y + hd.height / 2, { steps: 8 });
  expect(await parentWorld(card)).toBe('dock-world');          // no mid-drag hand-off
  await page.mouse.up();
  expect(await parentWorld(card)).toBe('dock-world');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  expect(await members()).toContain(cardId);                   // membership is content

  // same for the resize gutter straddling the panel's left border
  const rz = await page.locator('#dock-resizer').boundingBox();
  const hb2 = await card.locator('.card-header').boundingBox();
  await page.mouse.move(hb2.x + 24, hb2.y + 10);
  await page.mouse.down();
  await page.mouse.move(rz.x + rz.width / 2, rz.y + rz.height * 0.6, { steps: 8 });
  await page.mouse.up();
  expect(await parentWorld(card)).toBe('dock-world');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  expect(await members()).toContain(cardId);
});

// WHERE a member sits never decides whether it is one. The panel is a free
// surface with its own camera: pan it to reach empty space, drop a card there,
// and that card is legitimately far outside a rect it was never required to sit
// in. A reconcile used to prune members a region-size beyond the rect, meaning
// to tidy up after a reverted cross-window drag, and ejected real work instead —
// see the two tests below for the gestures that produced it.
test('a member parked far outside the rect stays a member across a reload', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 300);
  const cardId = await card.getAttribute('data-id');
  const frameId = await page.locator('.frame-node').getAttribute('data-id');
  await dockViaMenu(page);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  // park it several region-widths away, in both directions
  await page.addInitScript(([cardId, frameId]) => {
    const cur = localStorage.getItem('whiteboard:current');
    if (!cur) return;
    const key = 'whiteboard:board:' + cur;
    const b = JSON.parse(localStorage.getItem(key) || 'null');
    if (!b || !b.cards[frameId] || !b.cards[cardId]) return;
    const f = b.cards[frameId];
    b.cards[cardId].x = f.x - f.w * 3;
    b.cards[cardId].y = f.y + f.h * 4;
    localStorage.setItem(key, JSON.stringify(b));
  }, [cardId, frameId]);
  await page.reload();

  await expect(page.locator('#dock-panel')).toBeVisible();
  expect(await parentWorld(page.locator(`.node.card[data-id="${cardId}"]`))).toBe('dock-world');
  const stored = await page.evaluate((frameId) => {
    const cur = localStorage.getItem('whiteboard:current');
    return JSON.parse(localStorage.getItem('whiteboard:board:' + cur)).cards[frameId].dockMembers;
  }, frameId);
  expect(stored).toContain(cardId);
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

// A reconcile still drops ids that stopped being members at all — the node
// deleted on the other device, or pinned to the chrome — and that is an edit to
// SYNCED content, made on the pull path, outside commit(). The base and
// watermark filed alongside a pull describe what Drive holds, so they must be
// taken BEFORE the reconcile runs: taken after, they'd record the repair as
// already-synced, it would never push, and the next merge would read it as the
// other device re-adding the member — back in, dropped again, once per sync
// forever. The repair instead rides a version bump like any other edit.
test('a reconcile-time member drop is a versioned local edit, not a lie about Drive', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 360);
  const cardId = await card.getAttribute('data-id');
  const frameId = await page.locator('.frame-node').getAttribute('data-id');
  await dockViaMenu(page);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  // what "Drive" sends: the member still listed on the frame, but its own card
  // record deleted — the disagreement a per-field merge produces when it takes
  // one device's delete and the other's membership edit
  const pulled = await page.evaluate((cardId) => {
    const cur = localStorage.getItem('whiteboard:current');
    const b = JSON.parse(localStorage.getItem('whiteboard:board:' + cur));
    delete b.cards[cardId];
    b.version = 42;
    return b;
  }, cardId);
  await page.evaluate((content) => {
    window.__wb_applyPulledBoard(localStorage.getItem('whiteboard:current'), content, '77');
  }, pulled);

  // the repair ran locally…
  await expect(page.locator(`.node.card[data-id="${cardId}"]`)).toHaveCount(0);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  const state = await page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    const entry = JSON.parse(localStorage.getItem('whiteboard:library')).find((b) => b.id === cur);
    return {
      base: JSON.parse(localStorage.getItem('whiteboard:base:' + cur)),
      local: JSON.parse(localStorage.getItem('whiteboard:board:' + cur)),
      syncedLocalVersion: entry.syncedLocalVersion,
      driveVersion: entry.driveVersion,
    };
  });
  // …but the base still says what Drive actually holds, unrepaired at v42
  expect(state.base.cards[frameId].dockMembers).toContain(cardId);
  expect(state.base.version).toBe(42);
  expect(state.syncedLocalVersion).toBe(42);
  expect(state.driveVersion).toBe('77');
  // …and the repair is a real local edit past that watermark, so it will push
  expect(state.local.cards[frameId].dockMembers).not.toContain(cardId);
  expect(state.local.version).toBe(43);
});

// The bug this pair exists for, in the words it was reported in: "I drag a card
// into the frame, and then when I do anything else it gets ejected." The card
// lands in the panel, saves as a member, sits there visibly — and then the next
// undo (or the next Drive pull, same code path) hands it back to the canvas and
// rewrites the member list, so redo can't bring it back either.
//
// It hid for so long because it needed a real box to measure, and the panel is
// display:none while renderAll runs: a RELOAD always kept the member, and only
// mid-session reconciles ejected it. Same board, opposite answers, which reads
// as random rather than as a rule.
test('a card placed in the panel survives an undo of an unrelated edit', { tag: ['@dock', '@undo'] }, async ({ page }) => {
  await addFrame(page);
  await dockViaMenu(page);
  const card = await addCardAt(page, 170, 620);
  const cardId = await card.getAttribute('data-id');
  const frameId = await page.locator('.frame-node').getAttribute('data-id');

  // pan the panel down to reach empty space under the region — the ordinary way
  // to get room in a bespoke work area, and what puts a drop outside the rect
  const p = await page.locator('#dock-viewport').boundingBox();
  for (let i = 0; i < 8; i++) {
    await page.evaluate(([x, y]) => {
      document.getElementById('dock-viewport').dispatchEvent(new WheelEvent('wheel',
        { deltaY: 200, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }, [p.x + p.width / 2, p.y + p.height / 2]);
  }
  const hb = await card.locator('.card-header').boundingBox();
  await drag(page, { x: hb.x + 24, y: hb.y + hb.height / 2 },
                   { x: p.x + p.width / 2, y: p.y + p.height / 2 });
  expect(await parentWorld(card)).toBe('dock-world');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  // "anything else": one unrelated card, then undo it
  await addCardAt(page, 260, 200);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await page.keyboard.press('Control+z');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  expect(await parentWorld(card)).toBe('dock-world');
  const stored = await page.evaluate((fid) => {
    const cur = localStorage.getItem('whiteboard:current');
    return JSON.parse(localStorage.getItem('whiteboard:board:' + cur)).cards[fid].dockMembers;
  }, frameId);
  expect(stored).toContain(cardId);        // and the list itself wasn't rewritten
});

// The same reconcile reached down the other path, where the eject also EDITED
// SYNCED CONTENT and travelled to every device on the next push.
test('a card placed in the panel survives a Drive pull', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 360);
  const cardId = await card.getAttribute('data-id');
  const frameId = await page.locator('.frame-node').getAttribute('data-id');
  await dockViaMenu(page);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  // a pull that carries the member far outside the region — a per-field merge
  // taking one device's position edit and the other's membership edit
  const pulled = await page.evaluate((cid) => {
    const cur = localStorage.getItem('whiteboard:current');
    const b = JSON.parse(localStorage.getItem('whiteboard:board:' + cur));
    b.cards[cid].x = 4000;
    b.cards[cid].y = 4000;
    b.version = 42;
    return b;
  }, cardId);
  await page.evaluate((content) => {
    window.__wb_applyPulledBoard(localStorage.getItem('whiteboard:current'), content, '77');
  }, pulled);

  // it is somewhere odd in the panel — which Fit or a pan finds, and a drag
  // undoes — rather than silently handed back to the canvas
  expect(await parentWorld(card)).toBe('dock-world');
  const state = await page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    return {
      local: JSON.parse(localStorage.getItem('whiteboard:board:' + cur)),
      base: JSON.parse(localStorage.getItem('whiteboard:base:' + cur)),
    };
  });
  expect(state.local.cards[frameId].dockMembers).toContain(cardId);
  expect(state.local.version).toBe(42);          // nothing to repair, nothing to push
  expect(state.base.cards[frameId].dockMembers).toContain(cardId);
});

// …and the recovery has to have something left to recover FROM. The panel's
// arrangement (per-tab pan/zoom, width, active tab) is per-device chrome on the
// viewport key, and a viewport save rewrites that whole key — so while a stale
// snapshot leaves `dock` null, an ordinary canvas pan used to rewrite the key
// with no dock at all. The arrangement was gone before the pull that needed it
// arrived, and deriveDockTabs had nothing to prefer but defaults.
test('a pan during the sync race keeps the arrangement the pull has to recover', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 360);
  const cardId = await card.getAttribute('data-id');
  await dockViaMenu(page);
  const frameId = await page.locator('.frame-node').getAttribute('data-id');

  // give the tab a distinctive pan, then let the debounced save land. The pan
  // applies on a rAF, so poll for it — reading the transform straight back
  // captures the pre-pan fit and silently makes the assertion meaningless.
  const fitted = await dockTransform(page);
  const pv = await page.locator('#dock-viewport').boundingBox();
  await page.evaluate(([x, y]) => {
    document.getElementById('dock-viewport').dispatchEvent(new WheelEvent('wheel',
      { deltaX: 90, deltaY: 70, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, [pv.x + 100, pv.y + 100]);
  await expect.poll(() => dockTransform(page)).not.toBe(fitted);
  const panned = await dockTransform(page);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await page.waitForTimeout(500);

  const { boardKey, goodContent } = await page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    return { boardKey: 'whiteboard:board:' + cur, goodContent: JSON.parse(localStorage.getItem('whiteboard:board:' + cur)) };
  });
  await page.addInitScript(([boardKey, frameId]) => {
    const b = JSON.parse(localStorage.getItem(boardKey));
    delete b.cards[frameId];
    localStorage.setItem(boardKey, JSON.stringify(b));
  }, [boardKey, frameId]);
  await page.reload();
  await expect(page.locator('#dock-panel')).toBeHidden();     // dock is null: content lags Drive

  // an ordinary canvas pan while the panel is down — a viewport-only commit,
  // so it rewrites the very key the arrangement lives on
  await page.evaluate(() => {
    document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel',
      { deltaX: 130, deltaY: 40, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(600);
  const chrome = await page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    return JSON.parse(localStorage.getItem('whiteboard:viewport:' + cur)).dock;
  });
  expect(chrome).toBeTruthy();                                // arrangement not erased
  expect(chrome.tabs.map((t) => t.nodeId)).toContain(frameId);

  // the pull lands: the frame docks again AT THE ARRANGEMENT IT HAD
  await page.evaluate((content) => {
    window.__wb_applyPulledBoard(localStorage.getItem('whiteboard:current'), content);
  }, goodContent);
  await expect(page.locator('#dock-panel')).toBeVisible();
  expect(await parentWorld(page.locator(`.node.card[data-id="${cardId}"]`))).toBe('dock-world');
  expect(await dockTransform(page)).toBe(panned);
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


// ════════════════════════════════════════════════════════════════════════
//  ITEM TABS — a single card or embed docks as THE PANEL, not as something
//  floating in a second world. The node fills #dock-item (its attached button
//  tray across the bottom), so the width splitter resizes the item itself and
//  there is no camera to get lost in. It keeps its one element and its
//  untouched x/y record — only the render target changes, the same bargain a
//  pinned node makes with its chip — which is why it has no world presence for
//  arrows, marquee, pans, drags or drops to reach.
// ════════════════════════════════════════════════════════════════════════
async function addFreeButton(page) {
  const before = await page.locator('.btn-node').count();
  await page.click('#addButton');
  await expect(page.locator('#button-link-modal')).toBeVisible();
  await page.keyboard.press('Escape');       // a link isn't needed to dock
  await expect(page.locator('.btn-node')).toHaveCount(before + 1);
  const id = await page.locator('.btn-node').last().getAttribute('data-id');
  return page.locator(`.btn-node[data-id="${id}"]`);
}
async function addEmbed(page) {
  await page.click('#addFrame');
  await expect(page.locator('#frame-modal')).toBeVisible();
  await page.fill('#frame-url', EMBED_URL);
  await page.click('#frame-add');
  await expect(page.locator('#frame-modal')).toBeHidden();
  return page.locator('.node.iframe-node');
}
// Dock any node through its own context menu — the one entry point every
// dockable kind shares.
async function dockNodeVia(page, target) {
  await target.click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Dock to side panel' }).click();
  await expect(page.locator('#dock-panel')).toBeVisible();
}
const storedRecord = (page, id) => page.evaluate((nid) => {
  const cur = localStorage.getItem('whiteboard:current');
  const b = JSON.parse(localStorage.getItem('whiteboard:board:' + cur));
  return b.cards[nid] || b.iframes[nid];
}, id);
const setPanelWidth = (page, w) => page.evaluate((width) => {
  const r = document.getElementById('dock-resizer').getBoundingClientRect();
  const y = r.top + r.height / 2;
  const target = innerWidth - width;
  const send = (type, x) => document.getElementById('dock-resizer').dispatchEvent(
    new PointerEvent(type, { pointerId: 7, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  send('pointerdown', r.left + r.width / 2);
  window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, buttons: 1, clientX: target, clientY: y, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, clientX: target, clientY: y, bubbles: true }));
}, w);

test('a docked card becomes the panel: it fills #dock-item and the splitter resizes it', { tag: ['@dock', '@cards'] }, async ({ page }) => {
  const card = await addCardAt(page, 500, 300);
  const id = await card.getAttribute('data-id');
  await dockNodeVia(page, card.locator('.card-header'));

  // the node itself is the panel's content — not a member of a world
  expect(await parentWorld(card)).toBe('dock-item');
  await expect(page.locator('#dock-panel')).toHaveClass(/item-mode/);
  expect(await worldDisplay(page)).toBe('none');            // no second window here
  await expect(card).toBeVisible();
  await expect(card).not.toHaveClass(/frame-docked/);

  // it FILLS the panel viewport, both axes
  const vp = await page.locator('#dock-viewport').boundingBox();
  let bb = await card.boundingBox();
  expect(bb.width).toBeCloseTo(vp.width, 0);
  expect(bb.height).toBeCloseTo(vp.height, 0);

  // …and the width splitter resizes the ITEM, which is the whole point
  await setPanelWidth(page, 620);
  const vp2 = await page.locator('#dock-viewport').boundingBox();
  expect(vp2.width).toBeGreaterThan(vp.width + 100);
  bb = await card.boundingBox();
  expect(bb.width).toBeCloseTo(vp2.width, 0);

  // "docked" is still just the presence of dockMembers on its own record, and
  // an item tab's list is empty for its whole docked life
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  expect((await storedRecord(page, id)).dockMembers).toEqual([]);
});

test('a docked card keeps its button tray across the bottom of the panel', { tag: ['@dock', '@buttons'] }, async ({ page }) => {
  const card = await addCardAt(page, 500, 300);
  const btn = await addFreeButton(page);
  const cb = await card.boundingBox();
  const b0 = await btn.boundingBox();
  await drag(page, { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 },
                   { x: cb.x + cb.width / 2, y: cb.y + cb.height + 10 });
  await expect(btn).toHaveClass(/attached-bottom/);

  await dockNodeVia(page, card.locator('.card-header'));

  // the tray follows its root into the panel and lays out beneath it — by
  // flexbox, not by the derived world x/y the canvas uses
  expect(await parentWorld(btn)).toBe('dock-item-tray');
  await expect(btn).toBeVisible();
  const cbb = await card.boundingBox(), bbb = await btn.boundingBox();
  const vp = await page.locator('#dock-viewport').boundingBox();
  expect(bbb.y).toBeGreaterThan(cbb.y + cbb.height - 2);     // under the card
  expect(bbb.width).toBeCloseTo(vp.width, 0);                // full width of the panel
  expect(bbb.y + bbb.height).toBeCloseTo(vp.y + vp.height, 0);   // flush with the bottom

  // and the stored position was NOT rewritten from the panel's box
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  const rec = await storedRecord(page, await btn.getAttribute('data-id'));
  expect(rec.attachedTo).toBe(await card.getAttribute('data-id'));
  expect(rec.x).toBeGreaterThan(0);
});

test('an embed docks as the panel and stays docked across a reload', { tag: ['@dock', '@frames'] }, async ({ page }) => {
  const embed = await addEmbed(page);
  const id = await embed.getAttribute('data-id');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  const stored = await storedRecord(page, id);
  await dockNodeVia(page, embed.locator('.iframe-label'));

  expect(await parentWorld(embed)).toBe('dock-item');
  const vp = await page.locator('#dock-viewport').boundingBox();
  const bb = await embed.boundingBox();
  expect(bb.width).toBeCloseTo(vp.width, 0);
  expect(bb.height).toBeCloseTo(vp.height, 0);
  // the panel sizing it must not rewrite its stored box — that's synced
  // content, and the panel's width is per-device
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  const after = await storedRecord(page, id);
  expect([after.w, after.h]).toEqual([stored.w, stored.h]);
  expect(after.dockMembers).toEqual([]);

  await page.reload();
  await expect(page.locator('#dock-panel')).toBeVisible();
  expect(await parentWorld(page.locator(`.node.iframe-node[data-id="${id}"]`))).toBe('dock-item');
});

test('undocking an item restores its own size and lands it in view', { tag: ['@dock', '@nav'] }, async ({ page }) => {
  const embed = await addEmbed(page);
  const id = await embed.getAttribute('data-id');
  const before = await nodePos(embed);
  await dockNodeVia(page, embed.locator('.iframe-label'));

  await embed.locator('.dock-undock').click();   // the dock's control, in the item's own row
  await expect(page.locator('#dock-panel')).toBeHidden();
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  expect(await parentWorld(embed)).toBe('world');
  const after = await nodePos(embed);
  expect([after.w, after.h]).toEqual([before.w, before.h]);   // panel size didn't stick
  expect(await storedRecord(page, id)).not.toHaveProperty('dockMembers');
  // and it came back where the user can see it
  const bb = await embed.boundingBox();
  expect(bb.x).toBeGreaterThan(-1);
  expect(bb.y).toBeGreaterThan(-1);
});

test('an item tab has no world: no pan, no marquee, and its arrows hide', { tag: '@dock' }, async ({ page }) => {
  const a = await addCardAt(page, 480, 260);
  const b = await addCardAt(page, 820, 300);
  await a.hover();
  const port = a.locator('.port.right');
  const pb = await port.boundingBox();
  const tb = await b.boundingBox();
  await drag(page, { x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 },
                   { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 });
  await expect(page.locator('#connections .conn')).toHaveCount(1);

  await dockNodeVia(page, a.locator('.card-header'));
  // the arrow's record survives, but it has nowhere to point: an item is laid
  // out by the panel, so its stored x/y no longer say where it is
  await expect(page.locator('#connections .conn')).toHaveCount(1);
  await expect(page.locator('#connections .conn')).toBeHidden();
  await expect(page.locator('#dock-connections .conn')).toHaveCount(0);

  // the panel's camera is gone with it — a wheel over the panel doesn't pan it
  const t0 = await dockTransform(page);
  const vp = await page.locator('#dock-viewport').boundingBox();
  await page.evaluate(([x, y]) => {
    document.getElementById('dock-viewport').dispatchEvent(new WheelEvent('wheel',
      { deltaX: 90, deltaY: 70, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, [vp.x + 60, vp.y + 60]);
  expect(await dockTransform(page)).toBe(t0);
  // …and Fit, which only means something with a camera, is out of the header
  await expect(page.locator('#dockFitBtn')).toBeHidden();
});

test('an item tab takes no members: a card dropped on the panel stays on the canvas', { tag: '@dock' }, async ({ page }) => {
  const owner = await addCardAt(page, 500, 220);
  const ownerId = await owner.getAttribute('data-id');
  await dockNodeVia(page, owner.locator('.card-header'));

  const other = await addCardAt(page, 200, 620);
  const hb = await other.locator('.card-header').boundingBox();
  const panel = await page.locator('#dock-viewport').boundingBox();
  await drag(page, { x: hb.x + 24, y: hb.y + hb.height / 2 },
                   { x: panel.x + panel.width / 2, y: panel.y + panel.height / 2 });

  // the panel is the item, not a work surface: nothing joined it
  expect(await parentWorld(other)).toBe('world');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  expect((await storedRecord(page, ownerId)).dockMembers).toEqual([]);
});

test('a card tab and a frame tab share the rail, one container live at a time', { tag: '@dock' }, async ({ page }) => {
  await addFrame(page);
  const inside = await addCardAt(page, 640, 360);
  await dockViaMenu(page);
  await expect(page.locator('#dock-active-name')).toHaveText('Frame');

  const card = await addCardAt(page, 200, 620);              // outside the region
  await card.locator('.card-title').dblclick();
  await page.keyboard.type('Reference');
  await page.keyboard.press('Enter');
  await dockNodeVia(page, card.locator('.card-header'));

  await expect(page.locator('.dock-rail-tab')).toHaveCount(2);
  await expect(page.locator('#dock-active-name')).toHaveText('Reference');
  expect(await parentWorld(card)).toBe('dock-item');
  expect(await worldDisplay(page)).toBe('none');              // the region tab's world stands down
  await expect(inside).toBeHidden();

  // switching back: the world returns and the item stands down
  await page.locator('.dock-rail-tab', { hasText: 'Frame' }).click();
  await expect(page.locator('#dock-active-name')).toHaveText('Frame');
  await expect(page.locator('#dock-panel')).not.toHaveClass(/item-mode/);
  expect(await worldDisplay(page)).not.toBe('none');
  await expect(inside).toBeVisible();
  await expect(card).toBeHidden();                            // stowed, and taking no space
  expect(await parentWorld(card)).toBe('dock-item');
});

// An item brings its own title row, so the panel's header would be the SECOND
// one. It stands down instead and the dock's controls move into that row — one
// row, whichever kind of tab is showing.
test('an item tab has exactly one title row, carrying the dock controls', { tag: '@dock' }, async ({ page }) => {
  const card = await addCardAt(page, 500, 300);
  await card.locator('.card-title').dblclick();
  await page.keyboard.type('Sources');
  await page.keyboard.press('Enter');
  await dockNodeVia(page, card.locator('.card-header'));

  await expect(page.locator('#dock-header')).toBeHidden();
  await expect(card.locator('.card-header')).toBeVisible();
  await expect(card.locator('.card-title')).toHaveText('Sources');
  // the node's own buttons stay, and the dock's two join them
  await expect(card.locator('.copy-link')).toBeVisible();
  await expect(card.locator('.dock-min')).toBeVisible();
  await expect(card.locator('.dock-undock')).toBeVisible();

  // both work from there
  await card.locator('.dock-min').click();
  await expect(page.locator('#dock-panel')).toBeHidden();
  await page.locator('.dock-rail-tab').first().click();
  await expect(page.locator('#dock-panel')).toBeVisible();
  await card.locator('.dock-undock').click();
  await expect(page.locator('#dock-panel')).toBeHidden();

  // …and back on the canvas they hide themselves again — ancestry is the only
  // state involved, so nothing has to remember to clean them up
  expect(await parentWorld(card)).toBe('world');
  await expect(card.locator('.dock-min')).toBeHidden();
  await expect(card.locator('.dock-undock')).toBeHidden();
});

// The region tab's side of the same complaint: its frame's title tab is stowed
// off the canvas while docked, so the frame's own copy-link was unreachable.
// The panel header is that row for a region, and now carries it.
test('a region tab keeps one title row, with the frame own link button on it', { tag: '@dock' }, async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await addFrame(page);
  await dockViaMenu(page);
  await expect(page.locator('#dock-header')).toBeVisible();
  await expect(page.locator('#dockLinkBtn')).toBeVisible();
  await expect(page.locator('#dockFitBtn')).toBeVisible();
  await expect(page.locator('.frame-node')).toBeHidden();      // no second row
  // it copies a link to the frame, like the tab button on the canvas would
  const frameId = await page.locator('.frame-node').getAttribute('data-id');
  await page.locator('#dockLinkBtn').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('#node=' + frameId);
});

test('undo walks back over docking a card, and redo puts it back', { tag: ['@dock', '@undo'] }, async ({ page }) => {
  const card = await addCardAt(page, 500, 300);
  await dockNodeVia(page, card.locator('.card-header'));
  expect(await parentWorld(card)).toBe('dock-item');

  await page.keyboard.press('Control+z');
  await expect(page.locator('#dock-panel')).toBeHidden();
  expect(await parentWorld(card)).toBe('world');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('#dock-panel')).toBeVisible();
  expect(await parentWorld(card)).toBe('dock-item');
});

// ── "no world position" is ONE property ──────────────────────────────────
// An item's stored x/y are a parked canvas position, not where it is. Rather
// than telling each geometry consumer about docked items one at a time,
// nodeGeom returns null for them — the answer lazy hydration already taught
// every consumer to handle. The first two of these three were genuinely broken
// while the exemption was a pile of per-system special cases; the third was
// only ever LATENT, and the note on it says why it is still worth pinning.
test('a docked item drops out of Tab order and arrow-key navigation', { tag: ['@dock', '@a11y'] }, async ({ page }) => {
  const near = await addCardAt(page, 300, 300);
  const far = await addCardAt(page, 620, 300);
  const docked = await addCardAt(page, 460, 300);       // between them on the canvas
  const dockedId = await docked.getAttribute('data-id');
  await dockNodeVia(page, docked.locator('.card-header'));
  expect(await parentWorld(docked)).toBe('dock-item');

  // Tab cycles the canvas in reading order; the docked card is no longer part
  // of it, at its parked coordinates or anywhere else
  await page.mouse.click(60, 180);                       // canvas focus, nothing selected
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => {
      const el = document.querySelector('.node.selected');
      return el && el.dataset.id;
    }));
  }
  expect(seen).not.toContain(dockedId);

  // and Alt+Arrow (spatial nav) from the left card reaches the far one, not
  // the docked one parked between them
  await near.locator('.card-header').click();   // header, not body: keep focus on the canvas
  await expect(near).toHaveClass(/selected/);
  await page.keyboard.press('Alt+ArrowRight');
  await expect(far).toHaveClass(/selected/);
});

// Latent, not live: `frameContents` carries what sits FULLY inside the rect, and
// a docked item measures the panel (≈420×720 here), which is too big for an
// ordinary frame to contain — so the sweep was prevented by accident rather
// than on purpose. Narrow the panel, enlarge the frame, and the accident stops
// holding. Pinned here because the exemption shouldn't depend on a coincidence
// of sizes.
test('a "move items with frame" frame cannot sweep up a docked item', { tag: ['@dock', '@frames'] }, async ({ page }) => {
  // a card parked where a frame will later sit, then docked away
  const docked = await addCardAt(page, 640, 340);
  const dockedId = await docked.getAttribute('data-id');
  await dockNodeVia(page, docked.locator('.card-header'));
  expect(await parentWorld(docked)).toBe('dock-item');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  const before = await page.evaluate((id) => {
    const cur = localStorage.getItem('whiteboard:current');
    const c = JSON.parse(localStorage.getItem('whiteboard:board:' + cur)).cards[id];
    return { x: c.x, y: c.y };
  }, dockedId);

  // a frame over those same world coordinates, set to carry its contents
  await addFrame(page);
  await page.locator('.frame-node .frame-tab').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Move items with frame' }).click();
  const tab = await page.locator('.frame-node .frame-tab').boundingBox();
  await drag(page, { x: tab.x + 40, y: tab.y + tab.height / 2 },
                   { x: tab.x + 40 - 160, y: tab.y + tab.height / 2 + 90 });

  // the frame moved; the docked card's parked position did not travel with it
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  const after = await page.evaluate((id) => {
    const cur = localStorage.getItem('whiteboard:current');
    const c = JSON.parse(localStorage.getItem('whiteboard:board:' + cur)).cards[id];
    return { x: c.x, y: c.y };
  }, dockedId);
  expect(after).toEqual(before);
  expect(await parentWorld(docked)).toBe('dock-item');
});

test('an item offers no ports, and C reports why instead of throwing', { tag: '@dock' }, async ({ page }) => {
  const card = await addCardAt(page, 500, 300);
  const other = await addCardAt(page, 200, 620);
  await dockNodeVia(page, card.locator('.card-header'));

  // the gesture isn't offered: a connection drag has to leave the source's
  // border, and an item has none in world space
  await card.hover();
  await expect(card.locator('.port').first()).toBeHidden();

  // the keyboard route says so rather than crashing on the missing anchor
  await card.locator('.card-header').click();   // header, not body: C must reach the canvas
  await expect(card).toHaveClass(/selected/);
  await page.keyboard.press('c');
  await expect(page.locator('.visually-hidden[aria-live="polite"]')).toContainText(/docked/i);
  await expect(page.locator('.conn-temp')).toHaveCount(0);

  // an arrow already touching it survives, hidden, and comes back on undock
  await card.locator('.dock-undock').click();
  await expect(page.locator('#dock-panel')).toBeHidden();
  await other.hover();
  const pb = await other.locator('.port.right').boundingBox();
  const cb = await card.boundingBox();
  await drag(page, { x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 },
                   { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 });
  await expect(page.locator('#connections .conn')).toHaveCount(1);
  await dockNodeVia(page, card.locator('.card-header'));
  await expect(page.locator('#connections .conn')).toHaveCount(1);      // record intact
  await expect(page.locator('#connections .conn')).toBeHidden();        // no path to draw
  await card.locator('.dock-undock').click();
  await expect(page.locator('#connections .conn')).toBeVisible();       // and back
});
