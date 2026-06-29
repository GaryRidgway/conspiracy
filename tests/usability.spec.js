// ════════════════════════════════════════════════════════════════════════
//  USABILITY SUITE
//  Encodes the most common, most-complained-about usability problems with
//  comparable infinite-canvas / whiteboard tools (Miro, FigJam, Excalidraw,
//  Microsoft/Zoom Whiteboard), and asserts our app avoids them.
//
//  PASSING test  = that usability concern is handled.
//  test.fixme(…) = a known gap / backlog item (the body is the spec for it);
//                  remove `.fixme` when we implement it.
//
//  Sourced from real user complaints — see the chat notes / commit message.
// ════════════════════════════════════════════════════════════════════════
import { test, expect } from '@playwright/test';

const within = (b, w, h) => b && b.x + b.width > 0 && b.y + b.height > 0 && b.x < w && b.y < h;
const worldScale = (page) => page.evaluate(() => {
  const m = document.getElementById('world').style.transform.match(/scale\(([^)]+)\)/);
  return m ? parseFloat(m[1]) : 1;
});
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}
async function addCardAt(page, x, y) {
  const before = await page.locator('.node.card').count();
  await page.click('#addCard');            // appears at view centre, title editing
  await expect(page.locator('.node.card')).toHaveCount(before + 1);
  await page.keyboard.press('Escape');     // leave the auto title-edit
  const node = page.locator('.node.card').last();
  // reposition so its centre sits at screen (x, y)
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

// ── 1. Getting lost on the infinite canvas (Miro/Excalidraw: "easily get
//      lost", "no way to show all elements") — Fit must recover. ──
test('recover from getting lost: Fit brings off-screen content into view', async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  // scroll far away so the card leaves the viewport
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 8; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaX: 400, deltaY: 400, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
  });
  await page.click('#fitContent');
  const vp = page.viewportSize();
  const box = await node.boundingBox();
  expect(within(box, vp.width, vp.height)).toBe(true);
});

// ── 2. Accidental zoom (Zoom Whiteboard backlash: scroll-wheel hijacked to
//      zoom). Plain scroll must PAN, never change zoom. ──
test('plain scroll/trackpad pans and never changes zoom', async ({ page }) => {
  const before = await worldScale(page);
  await page.evaluate(() => {
    document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel', {
      deltaY: 200, deltaX: 0, clientX: 600, clientY: 400, bubbles: true, cancelable: true,
    }));
  });
  expect(await worldScale(page)).toBeCloseTo(before, 5);   // zoom untouched
  const t = await page.evaluate(() => document.getElementById('world').style.transform);
  expect(t).toContain('translate(0px, -200px)');           // it panned instead
});

// ── 3. Zoom should stay sane (Miro "400% isn't infinite", "everything
//      blurred"). Clamp, and always offer a way back to 100%. ──
test('zoom stays within a sane range and Reset returns home', async ({ page }) => {
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 60; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, clientX: 600, clientY: 400, ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(await worldScale(page)).toBeLessThanOrEqual(4 + 1e-9);
  await page.click('#resetView');
  expect(await worldScale(page)).toBeCloseTo(1, 5);
  const t = await page.evaluate(() => document.getElementById('world').style.transform);
  expect(t).toContain('translate(0px, 0px)');
});

// ── 4. Discoverability of "how do I add something" (empty-state "what do I
//      do"). The always-visible tool palette is the single obvious entry. ──
test('creating a node is discoverable (tool palette button)', async ({ page }) => {
  await expect(page.locator('#tools #addCard')).toBeVisible();
  await expect(page.locator('#hint')).toBeVisible();       // persistent guidance
  await page.click('#addCard');
  await expect(page.locator('.node.card')).toHaveCount(1);
});

// ── 5. Accidental deletion + weak undo (Microsoft Whiteboard: "can't undo a
//      deleted sticky", "lost months"). Deletion must be recoverable. ──
test('a deleted node is recoverable via undo', async ({ page }) => {
  await addCardAt(page, 450, 350);
  await page.mouse.click(60, 200);                          // deselect
  const hb = await page.locator('.card-header').boundingBox();
  await page.mouse.click(hb.x + hb.width * 0.5, hb.y + hb.height / 2);  // select
  await page.keyboard.press('Delete');
  await expect(page.locator('.node.card')).toHaveCount(0);
  await page.click('#undoBtn');                             // visible undo affordance
  await expect(page.locator('.node.card')).toHaveCount(1);
});

// ── 6. "Why is it rocket science to select/move an object" (Miro). Selection
//      must give clear visual feedback. ──
test('selection is visually obvious', async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  await page.mouse.click(60, 200);                          // deselect
  await expect(page.locator('.node.card.selected')).toHaveCount(0);
  const hb = await node.locator('.card-header').boundingBox();
  await page.mouse.click(hb.x + hb.width * 0.5, hb.y + hb.height / 2);
  await expect(page.locator('.node.card.selected')).toHaveCount(1);
});

// ── 7. Escape is a safe, predictable "get me out" — never destructive. ──
test('Escape clears selection without deleting anything', async ({ page }) => {
  await addCardAt(page, 450, 350);
  const hb = await page.locator('.card-header').boundingBox();
  await page.mouse.click(hb.x + hb.width * 0.5, hb.y + hb.height / 2);
  await expect(page.locator('.node.card.selected')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.node.card.selected')).toHaveCount(0);
  await expect(page.locator('.node.card')).toHaveCount(1);  // still there
});

// ── 8. "Menus that don't close properly" (Miro). Menus dismiss on Escape and
//      on outside-click. ──
test('open menus dismiss on Escape and outside-click', async ({ page }) => {
  await page.click('#boardMenuBtn');
  await expect(page.locator('#board-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#board-menu')).toBeHidden();

  await page.click('#boardMenuBtn');
  await expect(page.locator('#board-menu')).toBeVisible();
  await page.mouse.click(600, 400);                         // click the canvas
  await expect(page.locator('#board-menu')).toBeHidden();
});

// ── 9. Orientation always available (counter to "lost"): a live zoom readout. ──
test('a live zoom readout is always shown', async ({ page }) => {
  await expect(page.locator('#zoomReset')).toHaveText('100%');
  await page.evaluate(() => document.getElementById('viewport').dispatchEvent(
    new WheelEvent('wheel', { deltaY: -400, clientX: 600, clientY: 400, ctrlKey: true, bubbles: true, cancelable: true })));
  await expect(page.locator('#zoomReset')).not.toHaveText('100%');
});

// ── 10. No lost work: a reload restores the board. ──
test('work is not lost across a reload', async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  const id = await node.getAttribute('data-id');
  // wait for the debounced save to actually persist this card
  await expect.poll(() => page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    return localStorage.getItem('whiteboard:board:' + cur) || '';
  })).toContain(id);
  await page.reload();
  await expect(page.locator('.node.card')).toHaveCount(1);
});

// ════════════════════════════════════════════════════════════════════════
//  BACKLOG — known gaps vs. what users expect from Miro/FigJam/Excalidraw.
//  These run as `fixme` (skipped, not failing). Drop `.fixme` as we build each.
// ════════════════════════════════════════════════════════════════════════

// Box-select is the #1 "where did this go / why is this hard" complaint
// (Miro: "select multiple by drawing a box… why has this disappeared").
test('box-select: dragging on empty canvas rubber-bands a selection', async ({ page }) => {
  await addCardAt(page, 300, 300);
  await addCardAt(page, 560, 320);
  await page.mouse.click(60, 180);                            // deselect
  await expect(page.locator('.node.card.selected')).toHaveCount(0);
  await drag(page, { x: 180, y: 200 }, { x: 780, y: 520 });   // lasso around both
  await expect(page.locator('.node.card.selected')).toHaveCount(2);
});

// Multi-select + move together (Miro/FigJam standard).
test('multiple selected nodes move together', async ({ page }) => {
  await addCardAt(page, 300, 300);
  await addCardAt(page, 560, 320);
  await page.mouse.click(60, 180);
  await drag(page, { x: 180, y: 200 }, { x: 780, y: 520 });   // select both
  await expect(page.locator('.node.card.selected')).toHaveCount(2);

  const cards = page.locator('.node.card');
  const a0 = parseInt(await cards.nth(0).evaluate((el) => el.style.left), 10);
  const b0 = parseInt(await cards.nth(1).evaluate((el) => el.style.left), 10);
  const hb = await cards.nth(0).locator('.card-header').boundingBox();
  await drag(page, { x: hb.x + hb.width * 0.5, y: hb.y + hb.height / 2 },
                   { x: hb.x + hb.width * 0.5 + 120, y: hb.y + hb.height / 2 + 60 });
  const a1 = parseInt(await cards.nth(0).evaluate((el) => el.style.left), 10);
  const b1 = parseInt(await cards.nth(1).evaluate((el) => el.style.left), 10);
  expect(a1 - a0).toBe(120);   // both moved by the same delta
  expect(b1 - b0).toBe(120);
});

// Shift-click adds/removes individual nodes from the selection.
test('shift-click toggles a node in the selection', async ({ page }) => {
  await addCardAt(page, 300, 300);
  await addCardAt(page, 560, 320);
  await page.mouse.click(60, 180);
  const cards = page.locator('.node.card');
  const h0 = await cards.nth(0).locator('.card-header').boundingBox();
  const h1 = await cards.nth(1).locator('.card-header').boundingBox();
  await page.mouse.click(h0.x + h0.width * 0.5, h0.y + h0.height / 2);
  await page.keyboard.down('Shift');
  await page.mouse.click(h1.x + h1.width * 0.5, h1.y + h1.height / 2);     // shift-add
  await expect(page.locator('.node.card.selected')).toHaveCount(2);
  await page.mouse.click(h1.x + h1.width * 0.5, h1.y + h1.height / 2);     // shift-remove
  await page.keyboard.up('Shift');
  await expect(page.locator('.node.card.selected')).toHaveCount(1);
});

// Duplicate (Miro/FigJam: ⌘/Ctrl+D).
test('duplicate a node with Cmd/Ctrl+D', async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  const hb = await node.locator('.card-header').boundingBox();
  await page.mouse.click(hb.x + hb.width * 0.5, hb.y + hb.height / 2);
  await page.keyboard.press('ControlOrMeta+d');
  await expect(page.locator('.node.card')).toHaveCount(2);
  // the copy is offset and becomes the new selection
  await expect(page.locator('.node.card.selected')).toHaveCount(1);
});

test('duplicating a multi-selection copies the group and is one undo step', async ({ page }) => {
  await addCardAt(page, 300, 300);
  await addCardAt(page, 560, 320);
  await page.mouse.click(60, 180);
  await drag(page, { x: 180, y: 200 }, { x: 780, y: 520 });   // select both
  await expect(page.locator('.node.card.selected')).toHaveCount(2);

  await page.keyboard.press('ControlOrMeta+d');
  await expect(page.locator('.node.card')).toHaveCount(4);
  await expect(page.locator('.node.card.selected')).toHaveCount(2);   // copies selected

  await page.keyboard.press('ControlOrMeta+z');                       // single undo
  await expect(page.locator('.node.card')).toHaveCount(2);
});

// Copy / paste nodes (universal expectation).
test('copy and paste a node', async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  const hb = await node.locator('.card-header').boundingBox();
  await page.mouse.click(hb.x + hb.width * 0.5, hb.y + hb.height / 2);   // select
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.node.card')).toHaveCount(2);
  await expect(page.locator('.node.card.selected')).toHaveCount(1);     // paste selected
  await page.keyboard.press('ControlOrMeta+v');                         // paste again cascades
  await expect(page.locator('.node.card')).toHaveCount(3);
});

// Right-click context menu (Miro/FigJam: add-here / duplicate / delete).
test.fixme('right-click opens a context menu on the canvas and on a node', async ({ page }) => {
  await page.mouse.click(500, 350, { button: 'right' });
  await expect(page.locator('#context-menu')).toBeVisible();
});

// Empty-state guidance centered on a blank board (NN/g: orient the user).
test.fixme('a blank board shows a centered "double-click to add a card" prompt', async ({ page }) => {
  await expect(page.locator('#empty-hint')).toBeVisible();
});

// Select-all to grab/move everything (Miro "quick select all to move").
test('Cmd/Ctrl+A selects every node', async ({ page }) => {
  await addCardAt(page, 300, 300);
  await addCardAt(page, 520, 320);
  await page.mouse.click(60, 180);                 // deselect + drop any edit focus
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.locator('.node.card.selected')).toHaveCount(2);
});

// Keyboard zoom-to-fit (fast recovery; common shortcut Shift+1).
test.fixme('Shift+1 zooms to fit all content', async ({ page }) => {
  // mirrors the Fit button as a keyboard shortcut
});
