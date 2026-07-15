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
// pin by data-id: docking REPARENTS elements, which reorders the document —
// a .last() locator would re-resolve to a different card after the move
async function addCardAt(page, x, y) {
  const before = await page.locator('.node.card').count();
  await page.click('#addCard');
  await expect(page.locator('.node.card')).toHaveCount(before + 1);
  await page.keyboard.press('Escape');
  const id = await page.locator('.node.card').last().getAttribute('data-id');
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

  await expect(page.locator('#dock-title')).toHaveText('Frame');
  expect(await parentWorld(inside)).toBe('dock-world');      // region node → panel
  expect(await parentWorld(outside)).toBe('world');          // the rest stays put
  await expect(page.locator('.frame-node')).toHaveClass(/frame-docked/);

  // the member is visible inside the panel's bounds
  const panel = await page.locator('#dock-panel').boundingBox();
  const bb = await inside.boundingBox();
  expect(bb.x).toBeGreaterThan(panel.x);

  await page.locator('.frame-node .frame-tab').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Undock from side panel' }).click();
  await expect(page.locator('#dock-panel')).toBeHidden();
  expect(await parentWorld(inside)).toBe('world');
  await expect(page.locator('.frame-node')).not.toHaveClass(/frame-docked/);
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

  // drop it over the panel's centre (which is showing the frame region)
  const hb = await card.locator('.card-header').boundingBox();
  const panel = await page.locator('#dock-viewport').boundingBox();
  await drag(page, { x: hb.x + 24, y: hb.y + hb.height / 2 },
                   { x: panel.x + panel.width / 2, y: panel.y + panel.height / 2 });

  expect(await parentWorld(card)).toBe('dock-world');        // crossed the boundary
  // its world coordinates are now inside the frame's rect
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  const rec = await page.evaluate(() => {
    const b = JSON.parse(localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current')));
    const frame = Object.values(b.cards).find((c) => c.kind === 'frame');
    const card = Object.entries(b.cards).find(([, c]) => !c.kind);
    return { frame, card: card[1] };
  });
  expect(rec.card.x).toBeGreaterThan(rec.frame.x);
  expect(rec.card.x).toBeLessThan(rec.frame.x + rec.frame.w);

  // and back out: drop over empty canvas → it leaves the region
  const hb2 = await card.locator('.card-header').boundingBox();
  await drag(page, { x: hb2.x + 24, y: hb2.y + hb2.height / 2 }, { x: 200, y: 620 });
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

  await page.locator('.frame-node .frame-tab').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Undock' }).click();
  await expect(page.locator('#connections .conn')).toHaveCount(2);
  await expect(page.locator('#connections .conn').first()).toBeVisible();
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
