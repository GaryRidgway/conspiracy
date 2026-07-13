// ════════════════════════════════════════════════════════════════════════
//  TOUCH SUITE
//  Synthetic touch pointer events (pointerType: 'touch') drive the same
//  handlers a real iPad does — Playwright can't produce multi-finger
//  hardware touches, so we dispatch PointerEvents directly. pointerdown
//  targets the element under the point (like a real hit test); moves and
//  lifts go to window, where every drag in the app listens.
// ════════════════════════════════════════════════════════════════════════
import { test, expect } from '@playwright/test';

const touch = (page, type, id, x, y) => page.evaluate(([type, id, x, y]) => {
  const target = type === 'pointerdown' ? document.elementFromPoint(x, y) : window;
  target.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: 'touch', isPrimary: id === 1,
    clientX: x, clientY: y, bubbles: true, cancelable: true,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
  }));
}, [type, id, x, y]);

const worldTransform = (page) => page.evaluate(() => document.getElementById('world').style.transform);
const worldScale = async (page) => {
  const m = (await worldTransform(page)).match(/scale\(([^)]+)\)/);
  return m ? parseFloat(m[1]) : 1;
};
// model position — boundingBox is polluted by the :active scale transition
const nodePos = (loc) => loc.evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}
async function addCardAt(page, x, y) {
  const before = await page.locator('.node.card').count();
  await page.click('#addCard');
  await expect(page.locator('.node.card')).toHaveCount(before + 1);
  await page.keyboard.press('Escape');
  const node = page.locator('.node.card').last();
  const bb = await node.boundingBox();
  const hb = await node.locator('.card-header').boundingBox();
  const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  const gx = hb.x + 24, gy = hb.y + hb.height / 2;
  await drag(page, { x: gx, y: gy }, { x: gx + (x - cx), y: gy + (y - cy) });
  return node;
}

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
});
test.afterEach(() => expect(errors, 'no uncaught page errors').toEqual([]));

// ── One finger on empty canvas pans; it never draws the marquee, never
//    zooms, and a motionless tap deselects (the mouse's box-select roles). ──
test('one-finger drag pans the canvas; a bare tap deselects', async ({ page }) => {
  const node = await addCardAt(page, 500, 300);
  await expect(node).toHaveClass(/selected/);
  const zoomBefore = await worldScale(page);

  await touch(page, 'pointerdown', 1, 300, 600);
  await touch(page, 'pointermove', 1, 380, 540);
  await touch(page, 'pointermove', 1, 450, 480);
  expect(await page.locator('#selection-box').isHidden()).toBe(true);   // no marquee
  await touch(page, 'pointerup', 1, 450, 480);

  expect(await worldTransform(page)).toContain('translate(150px, -120px)');
  expect(await worldScale(page)).toBeCloseTo(zoomBefore, 5);

  // motionless tap on empty space clears the selection
  await touch(page, 'pointerdown', 1, 300, 600);
  await touch(page, 'pointerup', 1, 300, 600);
  await expect(node).not.toHaveClass(/selected/);
});

// ── Two fingers pinch-zoom about their midpoint, anywhere on the board. ──
test('two-finger pinch zooms about the midpoint; survivor finger keeps panning', async ({ page }) => {
  await addCardAt(page, 600, 400);
  expect(await worldScale(page)).toBeCloseTo(1, 5);

  // fingers 200px apart around (600, 400), spread to 400px → 2×
  await touch(page, 'pointerdown', 1, 500, 400);
  await touch(page, 'pointerdown', 2, 700, 400);
  await touch(page, 'pointermove', 1, 450, 400);
  await touch(page, 'pointermove', 2, 750, 400);
  await touch(page, 'pointermove', 1, 400, 400);
  await touch(page, 'pointermove', 2, 800, 400);
  expect(await worldScale(page)).toBeCloseTo(2, 3);

  // the world point that sat under the midpoint stays under it: with the
  // start view at translate(0,0) scale(1), w0 = (600,400), so at 2× the
  // viewport lands at (600 - 1200, 400 - 800)
  expect(await worldTransform(page)).toContain('translate(-600px, -400px)');

  // lift one finger — the survivor pans from where it stands
  await touch(page, 'pointerup', 2, 800, 400);
  await touch(page, 'pointermove', 1, 460, 430);
  await touch(page, 'pointerup', 1, 460, 430);
  expect(await worldTransform(page)).toContain('translate(-540px, -370px)');
  expect(await worldScale(page)).toBeCloseTo(2, 3);
});

// ── A second finger takes the view over cleanly: the one-finger card drag
//    ends where it was (no jitter between fingers), then the pinch zooms. ──
test('second finger during a card drag hands off to pinch without jitter', async ({ page }) => {
  const node = await addCardAt(page, 400, 300);
  const hb = await node.locator('.card-header').boundingBox();
  const start = await nodePos(node);

  await touch(page, 'pointerdown', 1, hb.x + 24, hb.y + hb.height / 2);
  await touch(page, 'pointermove', 1, hb.x + 74, hb.y + hb.height / 2 + 40);
  const midDrag = await nodePos(node);
  expect(midDrag.x - start.x).toBe(50);
  expect(midDrag.y - start.y).toBe(40);

  // finger 2 lands: drag must freeze; subsequent finger-1 motion zooms/pans
  // the VIEW instead of steering the card
  await touch(page, 'pointerdown', 2, 700, 600);
  await touch(page, 'pointermove', 1, hb.x - 100, hb.y + 200);
  await touch(page, 'pointermove', 2, 820, 700);
  const after = await nodePos(node);
  expect(after).toEqual(midDrag);                       // card model froze
  expect(await worldScale(page)).not.toBeCloseTo(1, 3); // the view moved instead

  await touch(page, 'pointerup', 1, hb.x - 100, hb.y + 200);
  await touch(page, 'pointerup', 2, 820, 700);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
});

// ── Long-press replaces right-click: on a node it opens that node's menu,
//    and the finger lift must not click-through to whatever is under it. ──
test('long-press on a card opens its context menu', async ({ page }) => {
  const node = await addCardAt(page, 500, 300);
  const hb = await node.locator('.card-header').boundingBox();

  await touch(page, 'pointerdown', 1, hb.x + 24, hb.y + hb.height / 2);
  await expect(page.locator('#context-menu')).not.toBeVisible();
  await page.waitForTimeout(650);                        // > LONG_PRESS_MS
  await expect(page.locator('#context-menu')).toBeVisible();
  await expect(page.locator('.ctx-item', { hasText: 'Duplicate' })).toBeVisible();

  // lifting the finger keeps the menu open (the synthetic click is squelched)
  await touch(page, 'pointerup', 1, hb.x + 24, hb.y + hb.height / 2);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.locator('#context-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#context-menu')).not.toBeVisible();
});

// ── Long-press on empty canvas: drag = marquee (box-select), release in
//    place = the canvas menu. Both roles the mouse gets for free. ──
test('long-press on canvas arms the marquee; releasing in place opens the canvas menu', async ({ page }) => {
  const a = await addCardAt(page, 450, 250);
  const b = await addCardAt(page, 650, 380);

  // press-hold on empty space below the cards, then sweep across both
  await touch(page, 'pointerdown', 1, 300, 150);
  await page.waitForTimeout(650);
  await expect(page.locator('#selection-box')).toBeVisible();   // the marquee cue
  await touch(page, 'pointermove', 1, 600, 400);
  await touch(page, 'pointermove', 1, 800, 500);
  await touch(page, 'pointerup', 1, 800, 500);
  await expect(a).toHaveClass(/selected/);
  await expect(b).toHaveClass(/selected/);
  await expect(page.locator('#context-menu')).not.toBeVisible();

  // press-hold-release without moving: canvas context menu at the point
  await touch(page, 'pointerdown', 1, 250, 550);
  await page.waitForTimeout(650);
  await touch(page, 'pointerup', 1, 250, 550);
  await expect(page.locator('#context-menu')).toBeVisible();
  await expect(page.locator('.ctx-item', { hasText: 'Add card here' })).toBeVisible();
  await page.keyboard.press('Escape');
});

// ── Touch drives the existing node drag: position sticks and persists. ──
test('one-finger card drag moves the card and commits', async ({ page }) => {
  const node = await addCardAt(page, 400, 300);
  const id = await node.getAttribute('data-id');
  const hb = await node.locator('.card-header').boundingBox();
  const start = await nodePos(node);

  await touch(page, 'pointerdown', 1, hb.x + 24, hb.y + hb.height / 2);
  await touch(page, 'pointermove', 1, hb.x + 24 + 60, hb.y + hb.height / 2 + 45);
  await touch(page, 'pointerup', 1, hb.x + 24 + 60, hb.y + hb.height / 2 + 45);

  const after = await nodePos(node);
  expect(after.x - start.x).toBe(60);
  expect(after.y - start.y).toBe(45);

  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await page.reload();
  const again = page.locator(`.node.card[data-id="${id}"]`);
  expect(await nodePos(again)).toEqual(after);
});
