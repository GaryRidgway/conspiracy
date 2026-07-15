// ════════════════════════════════════════════════════════════════════════
//  PIN DOCK
//  Right-click a button → "Pin beside toolbar": the button leaves the canvas
//  and becomes a chip in #pin-dock, riding the viewport for quick navigation.
//  `pinned` is shared board content (it syncs), the record's x/y is never
//  touched while pinned, and a kind that falls off PINNABLE_KINDS self-heals
//  back onto the canvas at its original spot.
// ════════════════════════════════════════════════════════════════════════
import { test, expect } from '@playwright/test';

const within = (b, w, h) => b && b.x + b.width > 0 && b.y + b.height > 0 && b.x < w && b.y < h;

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
const panAway = (page) => page.evaluate(() => {
  const v = document.getElementById('viewport');
  for (let i = 0; i < 8; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaX: 500, deltaY: 500, bubbles: true, cancelable: true }));
});

// mutate the stored board and reload (init script: the app re-saves its
// in-memory board on pagehide, which would clobber a plain pre-reload write)
async function seedBoard(page, mutate) {
  await page.addInitScript((fn) => {
    const cur = localStorage.getItem('whiteboard:current');
    if (!cur) return;
    const key = 'whiteboard:board:' + cur;
    const b = JSON.parse(localStorage.getItem(key) || 'null');
    if (!b || b.__seeded) return;
    b.__seeded = true;
    // eslint-disable-next-line no-new-func
    new Function('b', fn)(b);
    b.version++;
    localStorage.setItem(key, JSON.stringify(b));
  }, mutate);
  await page.reload();
}

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
});
test.afterEach(() => expect(errors, 'no uncaught page errors').toEqual([]));

test('pin a button: it leaves the canvas, the chip navigates, and it all survives reload', async ({ page }) => {
  // a target card, and a button linked to it
  const card = await addCardAt(page, 450, 350);
  await page.click('#addButton');
  const modal = page.locator('#button-link-modal');
  await expect(modal).toBeVisible();
  await modal.locator('.np-item').first().click();          // only the card exists
  await expect(modal).toBeHidden();

  await page.locator('.btn-node').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Pin beside toolbar' }).click();

  const chip = page.locator('#pin-dock .pin-chip');
  await expect(page.locator('.btn-node')).toHaveCount(0);   // gone from the canvas
  await expect(chip).toHaveCount(1);

  // the chip is chrome: select-all must not include the pinned button
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.locator('.node.selected')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // wander off, then ride the chip back to the card
  await panAway(page);
  await expect.poll(async () => within(await card.boundingBox(), page.viewportSize().width, page.viewportSize().height)).toBe(false);
  await chip.click();
  const vp = page.viewportSize();
  expect(within(await card.boundingBox(), vp.width, vp.height)).toBe(true);
  await expect(card).toHaveClass(/selected/);

  // pinned state is board content: it survives a reload
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await page.reload();
  await expect(page.locator('#pin-dock .pin-chip')).toHaveCount(1);
  await expect(page.locator('.btn-node')).toHaveCount(0);

  // unpin via the chip's context menu: back onto the canvas, mid-view
  await page.locator('#pin-dock .pin-chip').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Unpin' }).click();
  await expect(page.locator('#pin-dock')).toBeHidden();
  const btn = page.locator('.btn-node');
  await expect(btn).toHaveCount(1);
  expect(within(await btn.boundingBox(), vp.width, vp.height)).toBe(true);
});

test('arrows to a pinned button hide, and return on unpin', async ({ page }) => {
  await addCardAt(page, 400, 300);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await seedBoard(page, `
    const cardId = Object.keys(b.cards)[0];
    b.cards.pin_btn = { kind: 'button', x: 700, y: 320, title: 'Jump',
                        action: { type: 'node', target: cardId } };
    b.connections.cn_pin = { from: cardId, to: 'pin_btn' };
  `);

  const line = page.locator('#connections .conn .line');
  await expect.poll(() => line.evaluate((el) => el.getAttribute('d') || '')).toMatch(/^M/);

  await page.locator('.btn-node').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Pin beside toolbar' }).click();
  await expect(page.locator('#connections .conn')).toBeHidden();   // endpoint left the canvas

  await page.locator('#pin-dock .pin-chip').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Unpin' }).click();
  await expect(page.locator('#connections .conn')).toBeVisible();  // both ends exist again
});

test('a pinned record whose kind is not pinnable heals: canvas at original x/y, flag stripped', async ({ page }) => {
  // frames are not in PINNABLE_KINDS — this stands in for "the allowlist
  // shrank after something was pinned"
  await addCardAt(page, 400, 300);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await seedBoard(page, `
    b.cards.stale_pin = { kind: 'frame', x: 120, y: 140, w: 300, h: 200,
                          title: 'Was pinned', pinned: 12345 };
  `);

  // renders as a normal canvas node at its stored coordinates…
  const frame = page.locator('.frame-node');
  await expect(frame).toHaveCount(1);
  await expect(page.locator('#pin-dock')).toBeHidden();
  expect(await frame.evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) })))
    .toEqual({ x: 120, y: 140 });

  // …and the stale flag is removed from the stored data
  await expect.poll(() => page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    const b = JSON.parse(localStorage.getItem('whiteboard:board:' + cur));
    return b.cards.stale_pin.pinned === undefined;
  })).toBe(true);
});

test('the canvas context menu offers every palette node type', async ({ page }) => {
  await page.mouse.click(600, 400, { button: 'right' });
  const menu = page.locator('#context-menu');
  await expect(menu).toBeVisible();
  for (const label of ['Add card here', 'Add frame here', 'Add embed here', 'Add button here']) {
    await expect(menu.locator('.ctx-item', { hasText: label })).toBeVisible();
  }
  // the new entry actually works: it creates a button (which prompts for its link)
  await menu.locator('.ctx-item', { hasText: 'Add button here' }).click();
  await expect(page.locator('#button-link-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.btn-node')).toHaveCount(1);
});
