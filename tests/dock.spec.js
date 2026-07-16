// ════════════════════════════════════════════════════════════════════════
//  DOCKED FRAME WINDOW
//  Right-click a frame → "Dock to side panel": the frame's region becomes a
//  second window (#dock-panel) into the same world. Exclusive model — while
//  docked, the region's nodes live in #dock-world (the canvas shows only the
//  frame's collapsed tab), so every node still has exactly one element.
//  Both windows share world coordinates; membership is geometric and
//  recomputed at every commit, which is what makes cross-window drags work.
//  Dock state is per-device view preference (rides the viewport key).
// ════════════════════════════════════════════════════════════════════════
import { test, expect } from '@playwright/test';

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}
// find the NEW card by diffing ids — never .last(): dock members live in
// #dock-world, which comes after #world in the document, so document-order
// locators grab a panel member instead of the just-created card
async function addCardAt(page, x, y) {
  const ids = () => page.evaluate(() => [...document.querySelectorAll('.node.card')].map((e) => e.dataset.id));
  const before = await ids();
  await page.click('#addCard');
  await page.keyboard.press('Escape');
  const id = (await ids()).find((i) => !before.includes(i));
  const node = page.locator(`.node.card[data-id="${id}"]`);
  const bb = await node.boundingBox();
  const hb = await node.locator('.card-header').boundingBox();
  const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  const gx = hb.x + 24, gy = hb.y + hb.height / 2;
  await drag(page, { x: gx, y: gy }, { x: gx + (x - cx), y: gy + (y - cy) });
  return node;
}
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
const nodePos = (loc) => loc.evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
});
test.afterEach(() => expect(errors, 'no uncaught page errors').toEqual([]));

test('docking a frame moves its contents into the panel; undocking returns them', async ({ page }) => {
  await addFrame(page);
  const inside = await addCardAt(page, 640, 360);            // inside the region
  const outside = await addCardAt(page, 150, 640);           // canvas-only
  await dockViaMenu(page);

  await expect(page.locator('#dock-tabs .dock-tab-btn')).toHaveText(/Frame/);
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

test('the panel pans and zooms independently of the main canvas', async ({ page }) => {
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

test('dragging a card from the canvas into the panel re-homes it into the region', async ({ page }) => {
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
  // its CENTER now sits inside the frame's rect (membership rule — the box
  // itself may overhang an edge)
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  const rec = await page.evaluate(() => {
    const b = JSON.parse(localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current')));
    const frame = Object.values(b.cards).find((c) => c.kind === 'frame');
    const [id, card] = Object.entries(b.cards).find(([, c]) => !c.kind);
    const el = document.querySelector(`.node.card[data-id="${id}"]`);
    return { frame, cx: card.x + el.offsetWidth / 2, cy: card.y + el.offsetHeight / 2 };
  });
  expect(rec.cx).toBeGreaterThan(rec.frame.x);
  expect(rec.cx).toBeLessThan(rec.frame.x + rec.frame.w);
  expect(rec.cy).toBeGreaterThan(rec.frame.y);
  expect(rec.cy).toBeLessThan(rec.frame.y + rec.frame.h);

  // and back out: drop over empty canvas → it leaves the region. Grab a
  // VISIBLE part of the header — the card may overhang the panel's edge,
  // and the overhang is clipped (unhittable).
  const hb2 = await card.locator('.card-header').boundingBox();
  const panel2 = await page.locator('#dock-viewport').boundingBox();
  const gx = Math.max(hb2.x + 24, panel2.x + 12);
  await drag(page, { x: gx, y: hb2.y + hb2.height / 2 }, { x: 200, y: 620 });
  expect(await parentWorld(card)).toBe('world');
});

test('arrows: inside the panel they draw in its own layer; spanning arrows hide until undock', async ({ page }) => {
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

test('multiple frames dock as tabs: switching stows one region and shows the other', async ({ page }) => {
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

  const tabs = page.locator('#dock-tabs .dock-tab-btn');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveClass(/active/);            // newest tab is active
  await expect(cardB).toBeVisible();                          // Beta's card shows
  await expect(cardA).toBeHidden();                           // Alpha's card is stowed
  expect(await parentWorld(cardA)).toBe('dock-world');        // …but still off-canvas

  await tabs.nth(0).click();                                  // switch to Alpha
  await expect(cardA).toBeVisible();
  await expect(cardB).toBeHidden();

  // close Beta's tab: its region returns to the canvas, Alpha stays docked
  await tabs.nth(1).locator('.dock-tab-close').click();
  await expect(page.locator('#dock-tabs .dock-tab-btn')).toHaveCount(1);
  expect(await parentWorld(cardB)).toBe('world');
  expect(await parentWorld(cardA)).toBe('dock-world');

  // both-tab arrangement survives reload
  await page.locator('.frame-node:not(.frame-docked) .frame-tab').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Dock to side panel' }).click();
  await expect(page.locator('#dock-tabs .dock-tab-btn')).toHaveCount(2);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.locator('#dock-tabs .dock-tab-btn')).toHaveCount(2);
});

test('a member dragged to the region\'s edge keeps its drop position (no snap-away)', async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 300);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await dockViaMenu(page);

  // drag the card up so it OVERHANGS the region's top edge (center still
  // inside): it must stay in the panel and not jump on release
  const target = await page.evaluate(() => {
    const b = JSON.parse(localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current')));
    const fr = Object.values(b.cards).find((c) => c.kind === 'frame');
    const m = document.getElementById('dock-world').style.transform
      .match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/);
    const r = document.getElementById('dock-viewport').getBoundingClientRect();
    const zoom = parseFloat(m[3]);
    // screen-y where a card top should land so ~40% of it pokes above the edge
    const el = document.querySelector('.node.card');
    return r.top + parseFloat(m[2]) + fr.y * zoom - el.offsetHeight * 0.4 * zoom;
  });
  const hb = await card.locator('.card-header').boundingBox();
  const bb = await card.boundingBox();
  await page.mouse.move(hb.x + 24, hb.y + 10);
  await page.mouse.down();
  await page.mouse.move(hb.x + 24, hb.y + 10 - (bb.y - target), { steps: 8 });
  const preDrop = await nodePos(card);
  await page.mouse.up();
  const postDrop = await nodePos(card);
  expect(Math.abs(postDrop.y - preDrop.y)).toBeLessThan(2);   // no snap-away on release
  expect(await parentWorld(card)).toBe('dock-world');         // still a member
});

test('minimize flies the region off screen to an edge tab; restore brings it back', async ({ page }) => {
  await addFrame(page);
  const card = await addCardAt(page, 640, 360);
  await dockViaMenu(page);

  await page.click('#dockMinBtn');
  await expect(page.locator('#dock-panel')).toBeHidden();
  await expect(page.locator('#dock-tab')).toBeVisible();
  await expect(page.locator('#dock-tab')).toHaveText('Frame');
  await expect(card).toBeHidden();                           // stowed with the panel

  await page.click('#dock-tab');
  await expect(page.locator('#dock-panel')).toBeVisible();
  await expect(card).toBeVisible();
});

test('the docked window survives a reload (per-device view state)', async ({ page }) => {
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

test('canvas tools ignore the panel: marquee and Fit act on canvas nodes only', async ({ page }) => {
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

test('"Add card here" from inside the panel creates the card in the region', async ({ page }) => {
  await addFrame(page);
  await dockViaMenu(page);

  // right-click near the panel's top: that point maps ABOVE the frame rect
  // (the fit view has vertical margin), so creation must clamp into the rect
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

test('buttons navigate across windows: each window pans only for its own targets', async ({ page }) => {
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

test('jumping to a node in the panel pans the panel, not the canvas', async ({ page }) => {
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
