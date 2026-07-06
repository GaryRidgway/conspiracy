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
  // The pan applies on the next animation frame (wheel events are rAF-coalesced).
  await expect
    .poll(() => page.evaluate(() => document.getElementById('world').style.transform))
    .toContain('translate(0px, -200px)');                  // it panned instead
});

// ── 2b. Panning must feel snappy with heavy embeds on the board. Live
//      cross-origin iframes reposition a frame behind the transform (they
//      render out-of-process), so during an active pan we blank the live doc
//      to its node box and restore it once motion settles. ──
test('panning promotes #world to a GPU layer and never blanks the live doc', async ({ page }) => {
  await page.click('#addFrame');
  await page.fill('#frame-url', 'http://localhost:8123/tests/fixtures/embed.html');
  await page.click('#frame-add');
  const frame = page.locator('.iframe-node.loaded .iframe-frame');
  await expect(frame).toBeVisible();                         // loaded & visible at rest

  await page.evaluate(() => document.getElementById('viewport').dispatchEvent(
    new WheelEvent('wheel', { deltaY: 180, clientX: 600, clientY: 400, bubbles: true, cancelable: true })));
  expect(await page.evaluate(() => document.body.classList.contains('panning'))).toBe(true);
  expect(await page.evaluate(() => document.getElementById('world').style.willChange)).toBe('transform');
  await expect(frame).toBeVisible();                         // live doc stays on screen

  await expect(page.locator('body.panning')).toHaveCount(0, { timeout: 1000 });  // settles
  expect(await page.evaluate(() => document.getElementById('world').style.willChange)).toBe('auto');
});

// ── 2c. The dotted grid must track the world transform under zoom (same
//      spacing + cursor anchoring as the cards), not drift on its own. ──
test('the dot grid stays phase-aligned with the world under zoom', async ({ page }) => {
  const phaseGap = () => page.evaluate(() => {
    const wm = document.getElementById('world').style.transform
      .match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/);
    const gm = document.getElementById('grid').style.transform
      .match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    const tx = parseFloat(wm[1]), zoom = parseFloat(wm[3]), gtx = parseFloat(gm[1]);
    const tile = 28 * zoom, INSET = 160;
    const mod = (v) => (((v % tile) + tile) % tile);
    // grid's on-screen phase must equal the world's (x mod tile)
    const a = mod(-INSET + gtx), b = mod(tx);
    return Math.min(Math.abs(a - b), tile - Math.abs(a - b));   // circular distance
  });
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 4; i++) v.dispatchEvent(new WheelEvent('wheel',
      { deltaY: -200, clientX: 640, clientY: 400, ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(await phaseGap()).toBeLessThan(0.5);
});

// ── 2d. The floating edit toolbar is fixed-positioned; it must re-anchor to
//      its card as the board pans, not stay stuck on screen. ──
test('the edit toolbar stays anchored to its card when the board is panned', async ({ page }) => {
  await addCardAt(page, 500, 350);
  await page.locator('.node.card .card-body').first().click();   // focus body → toolbar
  const bar = page.locator('#text-toolbar');
  await expect(bar).toBeVisible();
  const before = await bar.evaluate((el) => parseFloat(el.style.top));
  await page.evaluate(() => document.getElementById('viewport').dispatchEvent(
    new WheelEvent('wheel', { deltaY: 220, clientX: 600, clientY: 400, bubbles: true, cancelable: true })));
  // the card moved on screen, so the toolbar's top must move with it (~ the pan delta)
  await expect.poll(() => bar.evaluate((el) => parseFloat(el.style.top))).toBeLessThan(before - 100);
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

// ── 10a. Viewport is a per-device preference: it persists locally across a
//        reload, but is never written into the (synced) board content. ──
test('viewport persists locally across reload but stays out of board content', async ({ page }) => {
  await addCardAt(page, 400, 300);
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    v.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: 600, clientY: 400, ctrlKey: true, bubbles: true, cancelable: true }));
    v.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, deltaX: 80, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
  });
  // wait out the viewport-save debounce
  await expect.poll(() => page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    return localStorage.getItem('whiteboard:viewport:' + cur) || '';
  })).toContain('zoom');
  // content must not carry the viewport
  const content = await page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    return localStorage.getItem('whiteboard:board:' + cur);
  });
  expect(content).not.toContain('viewport');

  const before = await page.evaluate(() => document.getElementById('world').style.transform);
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.getElementById('world').style.transform)).toBe(before);
});

// ── 10b. No lost work when leaving: hiding/closing the tab flushes the pending
//        debounced save immediately, so a quick edit-then-leave still persists. ──
test('leaving the tab flushes a pending edit without waiting for the debounce', async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  const id = await node.getAttribute('data-id');
  // Simulate the tab being hidden; the flush must persist synchronously.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // No polling — the card must already be in storage right after the event.
  const stored = await page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    return localStorage.getItem('whiteboard:board:' + cur) || '';
  });
  expect(stored).toContain(id);
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
test('right-click opens a context menu on the canvas and on a node', async ({ page }) => {
  const menu = page.locator('#context-menu');

  // On empty canvas: add/select options, no node-specific actions.
  await page.mouse.click(500, 350, { button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.getByText('Add card here')).toBeVisible();
  await expect(menu.getByText('Select all')).toBeVisible();
  // clicking an item runs it and closes the menu
  await menu.getByText('Add card here').click();
  await expect(menu).toBeHidden();
  await expect(page.locator('.node.card')).toHaveCount(1);
  await page.keyboard.press('Escape');                 // leave the new card's rename

  // On a node: duplicate/copy/cut/delete.
  await page.locator('.node.card').first().click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.getByText('Duplicate')).toBeVisible();
  await expect(menu.getByText('Delete card')).toBeVisible();
  await menu.getByText('Duplicate').click();
  await expect(menu).toBeHidden();
  await expect(page.locator('.node.card')).toHaveCount(2);

  // Escape dismisses without acting
  await page.mouse.click(500, 350, { button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

// Color coding: pick a color from the node context menu → it tints the node
// (heading + border via .colored / --node-color) and persists across a reload.
test('color-code a node from the context menu; it tints and persists', async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  await page.keyboard.press('Escape');                       // leave the title rename
  await node.click({ button: 'right' });
  const menu = page.locator('#context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.ctx-swatch')).toHaveCount(8);  // "none" + 7 colors

  await menu.locator('.ctx-swatch[title="Green"]').click();
  await expect(menu).toBeHidden();
  await expect(node).toHaveClass(/colored/);
  expect(await node.evaluate((el) => el.style.getPropertyValue('--node-color'))).toBe('#5AD19A');

  await expect.poll(() => page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    return localStorage.getItem('whiteboard:board:' + cur) || '';
  })).toContain('"color":"green"');
  await page.reload();
  await expect(page.locator('.node.card').first()).toHaveClass(/colored/);
});

// Clearing the color ("none") removes the tint.
test('choosing "no color" clears a node color', async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  await page.keyboard.press('Escape');
  const menu = page.locator('#context-menu');
  await node.click({ button: 'right' });
  await menu.locator('.ctx-swatch[title="Blue"]').click();
  await expect(node).toHaveClass(/colored/);
  await node.click({ button: 'right' });
  await menu.locator('.ctx-swatch-none').click();
  await expect(node).not.toHaveClass(/colored/);
});

// A connection fades between its two endpoints' colors; the arrowhead takes the
// destination color.
test('a connection fades between its two nodes\' colors', async ({ page }) => {
  const a0 = await addCardAt(page, 300, 300);
  const aid = await a0.getAttribute('data-id');
  const b0 = await addCardAt(page, 760, 320);
  const bid = await b0.getAttribute('data-id');
  const A = page.locator(`.node.card[data-id="${aid}"]`);
  const B = page.locator(`.node.card[data-id="${bid}"]`);

  await A.click({ button: 'right' });
  await page.locator('#context-menu .ctx-swatch[title="Red"]').click();
  await B.click({ button: 'right' });
  await page.locator('#context-menu .ctx-swatch[title="Blue"]').click();

  await A.hover();                                            // reveal ports
  const port = await A.locator('.port.right').boundingBox();
  const bb = await B.boundingBox();
  await drag(page, { x: port.x + port.width / 2, y: port.y + port.height / 2 },
                   { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 });

  const conn = page.locator('#connections g.conn');
  await expect(conn).toHaveCount(1);
  const stops = conn.locator('linearGradient stop');
  await expect(stops).toHaveCount(7);                                    // multi-stop spectrum
  await expect(stops.first()).toHaveAttribute('stop-color', '#F87171');  // exact source (red)
  await expect(stops.last()).toHaveAttribute('stop-color', '#6BA6FF');   // exact target (blue)
  // a middle stop rotates through the wheel (hsl), not a grayed RGB midpoint
  const mid = await stops.nth(3).getAttribute('stop-color');
  expect(mid.startsWith('hsl(')).toBe(true);
  await expect(conn.locator('marker path')).toHaveAttribute('fill', '#6BA6FF');  // arrow = target
});

// Connect two cards and return the exact screen point of the curve's middle
// (the label anchor / dblclick target).
async function connectTwoCards(page) {
  // pin by data-id — addCardAt returns a live `.last()` locator that would
  // re-resolve to the second card once it exists
  const aid = await (await addCardAt(page, 300, 300)).getAttribute('data-id');
  const bid = await (await addCardAt(page, 760, 320)).getAttribute('data-id');
  const A = page.locator(`.node.card[data-id="${aid}"]`);
  const B = page.locator(`.node.card[data-id="${bid}"]`);
  await A.hover();
  const port = await A.locator('.port.right').boundingBox();
  const bb = await B.boundingBox();
  await drag(page, { x: port.x + port.width / 2, y: port.y + port.height / 2 },
                   { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 });
  await expect(page.locator('#connections g.conn')).toHaveCount(1);
  return page.evaluate(() => {
    const line = document.querySelector('#connections g.conn .line');
    const p = line.getPointAtLength(line.getTotalLength() / 2);
    const m = line.getScreenCTM();
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  });
}

// Connections can say WHY two items are linked: double-click the line, type,
// and the label survives a reload.
test('a connection can be labeled by double-clicking it, and the label persists', async ({ page }) => {
  const mid = await connectTwoCards(page);
  await page.mouse.dblclick(mid.x, mid.y);
  const label = page.locator('.conn-label');
  await expect(label).toBeVisible();
  // the empty pill must open AT the curve's midpoint, not at a stale position
  const bb = await label.boundingBox();
  expect(Math.abs(bb.x + bb.width / 2 - mid.x)).toBeLessThan(20);
  expect(Math.abs(bb.y + bb.height / 2 - mid.y)).toBeLessThan(20);
  await page.keyboard.type('paid off by');
  await page.keyboard.press('Enter');
  await expect(label).toHaveText('paid off by');

  await page.reload();
  await expect(page.locator('.conn-label')).toHaveText('paid off by');
});

// Committing an empty label removes it; deleting the connection removes the pill.
test('an emptied connection label disappears, and deleting the connection removes it', async ({ page }) => {
  const mid = await connectTwoCards(page);
  await page.mouse.dblclick(mid.x, mid.y);
  await page.keyboard.type('temp');
  await page.keyboard.press('Enter');
  const label = page.locator('.conn-label');
  await expect(label).toHaveText('temp');

  // empty it → pill hides, no label in the stored content
  await label.dblclick();
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Enter');
  await expect(label).toBeHidden();

  // re-label, then delete the connection → pill fully removed
  await page.mouse.dblclick(mid.x, mid.y);
  await page.keyboard.type('again');
  await page.keyboard.press('Enter');
  await label.click();                        // selects the connection
  await page.keyboard.press('Delete');
  await expect(page.locator('#connections g.conn')).toHaveCount(0);
  await expect(page.locator('.conn-label')).toHaveCount(0);
});

// Color coding pays off as a filter: the legend lists only colors in use, and
// clicking a dot spotlights matching items while dimming the rest (view-only —
// nothing is written to the board).
test('clicking a legend dot spotlights that color and dims the rest', async ({ page }) => {
  const legend = page.locator('#color-filter');
  await expect(legend).toBeHidden();                       // no colors in use yet

  const aid = await (await addCardAt(page, 300, 300)).getAttribute('data-id');
  const bid = await (await addCardAt(page, 760, 320)).getAttribute('data-id');
  const A = page.locator(`.node.card[data-id="${aid}"]`);
  const B = page.locator(`.node.card[data-id="${bid}"]`);
  await A.click({ button: 'right' });
  await page.locator('#context-menu .ctx-swatch[title="Red"]').click();
  await B.click({ button: 'right' });
  await page.locator('#context-menu .ctx-swatch[title="Blue"]').click();

  await expect(legend).toBeVisible();
  await expect(legend.locator('.cf-dot')).toHaveCount(2);  // only colors in use

  // the legend hangs below the tools palette, never colliding with it
  const toolsBox = await page.locator('#tools').boundingBox();
  const legendBox = await legend.boundingBox();
  expect(legendBox.y).toBeGreaterThanOrEqual(toolsBox.y + toolsBox.height);

  // let the debounced local save land so the stored version is current
  await expect(page.locator('#saveState')).toHaveText('saved');
  const storedVersion = () => page.evaluate(() =>
    JSON.parse(localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current'))).version);
  const versionBefore = await storedVersion();

  await legend.locator('.cf-dot[title="Show only Red"]').click();
  await expect(A).not.toHaveClass(/filtered-out/);
  await expect(B).toHaveClass(/filtered-out/);

  // view-only: filtering must not bump the content version
  expect(await storedVersion()).toBe(versionBefore);

  // WCAG 2.2 AA (SC 2.5.8): every legend control is at least a 24×24 target
  for (const ctl of await legend.locator('.cf-dot, .cf-clear').all()) {
    const b = await ctl.boundingBox();
    expect(b.width).toBeGreaterThanOrEqual(24);
    expect(b.height).toBeGreaterThanOrEqual(24);
  }

  await legend.locator('.cf-clear').click();
  await expect(B).not.toHaveClass(/filtered-out/);

  // removing the last red item retires the dot (and any active filter on it)
  await legend.locator('.cf-dot[title="Show only Red"]').click();
  await A.locator('.card-header').click();   // header selects without entering text edit
  await page.keyboard.press('Delete');
  await expect(legend.locator('.cf-dot')).toHaveCount(1);
  await expect(B).not.toHaveClass(/filtered-out/);
});

// Quick jump (⌘K): finding an item by its text flies the viewport to it —
// the other half of "getting lost on the infinite canvas".
test('quick jump finds a card by its text and flies the viewport to it', async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  await node.locator('.card-title').dblclick();
  await page.keyboard.type('smoking gun');
  await page.keyboard.press('Enter');

  // scroll far away so the card leaves the viewport
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 8; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaX: 500, deltaY: 500, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => within(await node.boundingBox(), page.viewportSize().width, page.viewportSize().height)).toBe(false);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#jump')).toBeVisible();
  await page.keyboard.type('smoking');
  await expect(page.locator('#jump-list .np-item')).toHaveCount(1);
  await page.keyboard.press('Enter');

  await expect(page.locator('#jump')).toBeHidden();
  const vp = page.viewportSize();
  expect(within(await node.boundingBox(), vp.width, vp.height)).toBe(true);
  await expect(node).toHaveClass(/selected/);   // found node is selected + flashed
});

// The Find button opens the same palette, and Escape closes it.
test('Find button opens quick jump; Escape closes it', async ({ page }) => {
  await addCardAt(page, 450, 350);
  await page.click('#findBtn');
  await expect(page.locator('#jump')).toBeVisible();
  await expect(page.locator('#jump-list .np-item')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#jump')).toBeHidden();
});

// Paste a screenshot on the canvas → it becomes a card holding the image as a
// data URI (downscaled, no remote fetch), which persists like any card.
async function pasteImage(page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 60; canvas.height = 40;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F87171'; ctx.fillRect(0, 0, 60, 40);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
}

test('pasting an image on the canvas creates an image card that persists', async ({ page }) => {
  await pasteImage(page);
  const img = page.locator('.node.card .card-body img');
  await expect(img).toHaveCount(1);
  const src = await img.getAttribute('src');
  expect(src.startsWith('data:image/')).toBe(true);

  await expect(page.locator('#saveState')).toHaveText('saved');
  await page.reload();
  await expect(page.locator('.node.card .card-body img')).toHaveCount(1);
});

// Pasting while editing a card drops the image inline; remote <img> tags are
// stripped by the sanitizer (data URIs only — no tracking pixels).
test('image pastes inline into a card being edited; remote images are stripped', async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  await node.locator('.card-body').click();
  await page.keyboard.type('evidence: ');
  await pasteImage(page);
  await expect(node.locator('.card-body img')).toHaveCount(1);
  await expect(node.locator('.card-body')).toContainText('evidence:');
  await expect(page.locator('#saveState')).toHaveText('saved');   // debounced save landed

  // a remote image sneaked into the stored body must not survive a re-render
  await page.evaluate(() => {
    const id = document.querySelector('.node.card').dataset.id;
    const key = 'whiteboard:board:' + localStorage.getItem('whiteboard:current');
    const content = JSON.parse(localStorage.getItem(key));
    content.cards[id].body += '<img src="https://evil.example/pixel.png">';
    localStorage.setItem(key, JSON.stringify(content));
  });
  await page.reload();
  const srcs = await page.locator('.card-body img').evaluateAll((els) => els.map((el) => el.getAttribute('src')));
  expect(srcs.length).toBe(1);                       // remote img dropped
  expect(srcs[0].startsWith('data:image/')).toBe(true);
});

// SECURITY: board content is untrusted (a shared Drive board or imported JSON
// is authored by someone else). An <iframe src="javascript:…"> executes in
// THIS page's origin (the frame has no sandbox), which would be stored XSS
// with access to every board and the Drive token. Such a src must never reach
// the element — the frame loads blank instead.
test('security: a javascript: iframe src from stored content never loads', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('whiteboard', JSON.stringify({
      schema: 1, version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      cards: {}, connections: {},
      iframes: { f_x: { x: 60, y: 60, w: 480, h: 320, src: 'javascript:window.__pwned=1', logicalWidth: 1440 } },
    }));
  });
  await page.reload();
  await expect(page.locator('.node.iframe-node')).toHaveCount(1);
  await page.click('#fitContent');                    // force it into loadable range
  // src is blanked, and the payload never ran
  const src = await page.locator('.node.iframe-node iframe').getAttribute('src');
  expect(src === '' || src === null).toBe(true);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

// SECURITY: same untrusted-scheme concern for a button's URL action — a
// javascript:/data: target must not be handed to window.open().
test('security: a button with a javascript: URL action does not navigate', async ({ page }) => {
  let opened = null;
  await page.exposeFunction('__recordOpen', (u) => { opened = u; });
  await page.addInitScript(() => { window.open = (u) => { window.__recordOpen(u); return null; }; });
  await page.evaluate(() => {
    localStorage.setItem('whiteboard', JSON.stringify({
      schema: 1, version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      cards: { b_x: { kind: 'button', x: 200, y: 200, title: 'Evil', action: { type: 'url', target: 'javascript:window.__pwned=1' } } },
      connections: {}, iframes: {},
    }));
  });
  await page.reload();
  await page.locator('.btn-node').click();
  expect(opened).toBeNull();                           // window.open was never called
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

// Button nodes: click to fly to a board item — the link is set in the modal
// that opens on creation (and later via right-click → Change link…).
test('a button linked to a board item flies the viewport there on click', async ({ page }) => {
  const card = await addCardAt(page, 450, 350);
  await card.locator('.card-title').dblclick();
  await page.keyboard.type('Target Dossier');
  await page.keyboard.press('Enter');

  // pan far away, then create the button at the (new) view center
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 8; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaX: 500, deltaY: 500, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => within(await card.boundingBox(), page.viewportSize().width, page.viewportSize().height)).toBe(false);

  await page.click('#addButton');
  const modal = page.locator('#button-link-modal');
  await expect(modal).toBeVisible();                       // creation prompts for the link
  await page.keyboard.type('dossier');
  await expect(modal.locator('.np-item')).toHaveCount(1);
  await modal.locator('.np-item').click();
  await expect(modal).toBeHidden();

  const btn = page.locator('.btn-node');
  await expect(btn).toHaveText(/Button/);
  await btn.click();
  const vp = page.viewportSize();
  expect(within(await card.boundingBox(), vp.width, vp.height)).toBe(true);
  await expect(card).toHaveClass(/selected/);

  // rename via the context menu, and everything survives a reload
  await page.click('#fitContent');           // the fly-to left the button off-screen
  await btn.click({ button: 'right' });
  await expect(page.locator('#context-menu')).toContainText('Change link…');
  await page.locator('#context-menu .ctx-item', { hasText: 'Rename' }).click();
  await page.keyboard.type('Go to dossier');
  await page.keyboard.press('Enter');
  await expect(btn).toHaveText('Go to dossier');
  await expect(page.locator('#saveState')).toHaveText('saved');
  await page.reload();
  await expect(page.locator('.btn-node')).toHaveText('Go to dossier');
});

// A URL button opens the link in a new tab (noopener), like body links do.
test('a button linked to a URL opens it in a new tab on click', async ({ page }) => {
  await page.click('#addButton');
  const modal = page.locator('#button-link-modal');
  await expect(modal).toBeVisible();
  const target = new URL('tests/fixtures/embed.html', page.url()).href;
  await page.fill('#bl-input', target);
  await expect(page.locator('#bl-use-url')).toBeEnabled();
  await page.click('#bl-use-url');
  await expect(modal).toBeHidden();

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('.btn-node').click(),
  ]);
  expect(popup.url()).toContain('embed.html');
});

// Frames: a named region of the board, linkable like any node, sitting behind
// content with a click-through interior.
test('a frame is a named, linkable region whose interior stays click-through', async ({ page }) => {
  await page.click('#addFrameNode');
  await page.keyboard.type('Evidence wall');
  await page.keyboard.press('Enter');
  const frame = page.locator('.frame-node');
  await expect(frame.locator('.frame-name')).toHaveText('Evidence wall');

  // interior is click-through: a card can be created and selected inside it
  const card = await addCardAt(page, 640, 360);
  await expect(card).toBeVisible();

  // pan far away, then fly back to the frame by name via quick jump
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 8; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaX: 500, deltaY: 500, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('evidence wall');
  await expect(page.locator('#jump-list .np-item')).toHaveCount(1);
  await page.keyboard.press('Enter');
  const vp = page.viewportSize();
  expect(within(await frame.boundingBox(), vp.width, vp.height)).toBe(true);

  await expect(page.locator('#saveState')).toHaveText('saved');
  await page.reload();
  await expect(page.locator('.frame-node .frame-name')).toHaveText('Evidence wall');
});

// The context-menu toggle: a frame set to "move items with frame" carries
// everything fully inside it when dragged; toggled off, it moves alone.
test('the move-items-with-frame toggle carries contents only while enabled', async ({ page }) => {
  await page.click('#addFrameNode');
  await page.keyboard.press('Escape');                     // keep default name
  const frame = page.locator('.frame-node');
  const card = await addCardAt(page, 640, 360);            // fully inside the frame
  const tab = frame.locator('.frame-tab');

  // enable the toggle
  await tab.click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Move items with frame' }).click();

  const cardBefore = await card.boundingBox();
  let t = await tab.boundingBox();
  await drag(page, { x: t.x + t.width / 2, y: t.y + t.height / 2 },
                   { x: t.x + t.width / 2 + 150, y: t.y + t.height / 2 + 100 });
  const cardAfter = await card.boundingBox();
  expect(Math.round(cardAfter.x - cardBefore.x)).toBe(150);  // card came along
  expect(Math.round(cardAfter.y - cardBefore.y)).toBe(100);

  // disable (the item now shows a checkmark) and drag again: card stays put
  await tab.click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: '✓ Move items with frame' }).click();
  t = await tab.boundingBox();
  await drag(page, { x: t.x + t.width / 2, y: t.y + t.height / 2 },
                   { x: t.x + t.width / 2 - 150, y: t.y + t.height / 2 - 100 });
  const cardFinal = await card.boundingBox();
  expect(Math.round(cardFinal.x)).toBe(Math.round(cardAfter.x));
  expect(Math.round(cardFinal.y)).toBe(Math.round(cardAfter.y));
});

// Empty-state guidance centered on a blank board (NN/g: orient the user).
test('a blank board shows a centered empty-state prompt that clears once a node exists', async ({ page }) => {
  await expect(page.locator('#empty-hint')).toBeVisible();
  await addCardAt(page, 300, 300);
  await expect(page.locator('#empty-hint')).toBeHidden();
});

// A long heading should widen the card (no clipped/ellipsised title), while a
// long body must NOT — the title alone drives width.
test('a long heading widens the card; a long body does not', async ({ page }) => {
  const widthOf = (loc) => loc.evaluate((el) => el.getBoundingClientRect().width);

  // short title → default width
  await page.click('#addCard');
  await page.keyboard.press('Escape');
  const plain = page.locator('.node.card').last();
  expect(await widthOf(plain)).toBeLessThanOrEqual(245);

  // long title → grows past the default
  await page.click('#addCard');
  await page.keyboard.type('A really quite long heading that should not be cut off');
  await page.keyboard.press('Escape');
  const wide = page.locator('.node.card').last();
  const wideW = await widthOf(wide);
  expect(wideW).toBeGreaterThan(280);
  // title is fully visible — not clipped by ellipsis
  const title = wide.locator('.card-title');
  const clipped = await title.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(clipped).toBe(false);

  // short title + long body → stays at default (body never drives width)
  await page.click('#addCard');
  await page.keyboard.press('Escape');
  const card = page.locator('.node.card').last();
  await card.locator('.card-body').click();
  await page.keyboard.type('This is a long note with plenty of words that should simply wrap onto multiple lines instead of stretching the card wider and wider.');
  await page.keyboard.press('Escape');
  expect(await widthOf(card)).toBeLessThanOrEqual(245);
});

// Drive opt-in lives in the board menu and must not pull in Google's scripts
// (or touch the network) until the user actually clicks Connect.
test('Drive bar is present and loads no Google scripts until Connect', async ({ page }) => {
  await page.click('#boardMenuBtn');
  await expect(page.locator('#drive-bar')).toBeVisible();
  await expect(page.locator('#driveConnectBtn')).toBeVisible();
  // nothing Google-hosted should have loaded just by booting + opening the menu
  expect(await page.locator('script[src*="google"]').count()).toBe(0);
});

// ── Three-way merge (per-node) — the core "don't clobber unedited things" logic.
//    Exercised directly via the pure window.__wb_mergeBoards hook (no OAuth). ──
function card(x, y, title, body) { return { x, y, title: title || '', body: body || '' }; }
async function merge(page, base, local, remote) {
  return page.evaluate(([b, l, r]) => window.__wb_mergeBoards(b, l, r), [base, local, remote]);
}
const boardOf = (cards) => ({ schema: 1, version: 1, viewport: { x: 0, y: 0, zoom: 1 }, cards, iframes: {}, connections: {} });

test('merge: edits to different nodes both survive', async ({ page }) => {
  const base = boardOf({ a: card(0, 0, 'A'), b: card(10, 10, 'B') });
  const local = boardOf({ a: card(0, 0, 'A EDITED'), b: card(10, 10, 'B') });   // this device edited A
  const remote = boardOf({ a: card(0, 0, 'A'), b: card(99, 99, 'B') });          // other device moved B
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(0);
  expect(merged.cards.a.title).toBe('A EDITED');   // local edit kept
  expect(merged.cards.b.x).toBe(99);               // remote edit kept
});

test('merge: same node, different fields — both edits kept', async ({ page }) => {
  const base = boardOf({ a: card(0, 0, 'A', 'body') });
  const local = boardOf({ a: card(50, 60, 'A', 'body') });          // moved it
  const remote = boardOf({ a: card(0, 0, 'A', 'new body') });        // edited its body
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(0);
  expect(merged.cards.a.x).toBe(50);            // local position
  expect(merged.cards.a.body).toBe('new body'); // remote body
});

test('merge: same field on both sides is a conflict, local wins', async ({ page }) => {
  const base = boardOf({ a: card(0, 0, 'A', 'orig') });
  const local = boardOf({ a: card(0, 0, 'A', 'mine') });
  const remote = boardOf({ a: card(0, 0, 'A', 'theirs') });
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(1);
  expect(merged.cards.a.body).toBe('mine');
});

test('merge: node added on one side appears; node deleted on one side goes away', async ({ page }) => {
  const base = boardOf({ a: card(0, 0, 'A') });
  const local = boardOf({ a: card(0, 0, 'A'), c: card(5, 5, 'C') });  // added C
  const remote = boardOf({});                                          // deleted A
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(0);
  expect(merged.cards.c).toBeTruthy();      // add survives
  expect(merged.cards.a).toBeFalsy();       // delete survives
});

test('merge: delete on one side vs edit on the other keeps the edit', async ({ page }) => {
  const base = boardOf({ a: card(0, 0, 'A', 'orig') });
  const local = boardOf({});                                  // deleted A
  const remote = boardOf({ a: card(0, 0, 'A', 'edited') });   // edited A
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(1);
  expect(merged.cards.a.body).toBe('edited');   // don't lose the edit
});

// Button nodes nest an object (action: {type, target}) inside a record. Each
// merge side comes from a separate JSON parse, so equality must be by value —
// reference compare would flag every configured button as edited on both sides.
test('merge: untouched button with a nested action is not a conflict', async ({ page }) => {
  const btn = () => ({ x: 0, y: 0, title: 'Go', kind: 'button', action: { type: 'url', target: 'https://a.example' } });
  const base = boardOf({ b1: btn() });
  const local = boardOf({ b1: btn() });                      // untouched here
  const remote = boardOf({ b1: btn(), c: card(5, 5, 'C') }); // other device added a card
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(0);
  expect(merged.cards.b1.action).toEqual({ type: 'url', target: 'https://a.example' });
  expect(merged.cards.c).toBeTruthy();
});

test('merge: remote changing a button link wins when this device did not touch it', async ({ page }) => {
  const btn = (target) => ({ x: 0, y: 0, title: 'Go', kind: 'button', action: { type: 'url', target } });
  const base = boardOf({ b1: btn('https://old.example') });
  const local = boardOf({ b1: btn('https://old.example') });   // untouched here
  const remote = boardOf({ b1: btn('https://new.example') });  // relinked there
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(0);
  expect(merged.cards.b1.action.target).toBe('https://new.example');
});

// Removing a field (e.g. deleting a connection label, unsetting a button link)
// must survive a merge as a removal — not resurrect, not leave a phantom key.
test('merge: a field deleted on one side stays deleted', async ({ page }) => {
  const base = boardOf({});
  base.connections = { k: { from: 'a', to: 'b', label: 'old' } };
  const local = boardOf({});
  local.connections = { k: { from: 'a', to: 'b' } };            // label removed here
  const remote = boardOf({});
  remote.connections = { k: { from: 'a', to: 'b', label: 'old' } };
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(0);
  expect('label' in merged.connections.k).toBe(false);          // gone, not undefined
});

// The Drive conflict prompt exists but stays hidden for normal (device-board) use.
test('Drive conflict modal is present and hidden by default', async ({ page }) => {
  await expect(page.locator('#conflict-modal')).toBeHidden();
  await expect(page.locator('#conflict-keep-local')).toHaveCount(1);
  await expect(page.locator('#conflict-keep-drive')).toHaveCount(1);
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
test('Shift+1 zooms to fit all content', async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  await page.mouse.click(60, 180);                 // drop edit focus so the shortcut fires
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 8; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaX: 400, deltaY: 400, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press('Shift+1');
  const vp = page.viewportSize();
  const box = await node.boundingBox();
  expect(within(box, vp.width, vp.height)).toBe(true);
});

// ── Keyboard & assistive-tech accessibility ──────────────────────────────
// The canvas must be operable without a mouse: Tab cycles items, arrows move
// them, Enter opens them, F6 reaches the chrome, and focus is always visible.

test('keyboard: arrow keys nudge the selected node, Shift for fine steps', async ({ page }) => {
  await addCardAt(page, 400, 300);
  await page.mouse.click(60, 180);            // canvas focus, nothing selected
  await page.keyboard.press('Tab');           // select the card
  const sel = page.locator('.node.card.selected');
  await expect(sel).toHaveCount(1);
  const x0 = await sel.evaluate((el) => parseFloat(el.style.left));
  const y0 = await sel.evaluate((el) => parseFloat(el.style.top));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await sel.evaluate((el) => parseFloat(el.style.left))).toBe(x0 + 20);  // 2 × 10px
  expect(await sel.evaluate((el) => parseFloat(el.style.top))).toBe(y0 + 1);    // fine step
});

test('keyboard: a burst of nudges undoes as a single step', async ({ page }) => {
  const node = await addCardAt(page, 400, 300);
  const id = await node.getAttribute('data-id');
  const card = page.locator(`.node[data-id="${id}"]`);
  await page.mouse.click(60, 180);
  await page.keyboard.press('Tab');
  const x0 = await card.evaluate((el) => parseFloat(el.style.left));
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(700);             // close the coalesce window
  await page.keyboard.press('ControlOrMeta+z');
  expect(await card.evaluate((el) => parseFloat(el.style.left))).toBe(x0);
});

test('keyboard: Enter starts editing the selected card', async ({ page }) => {
  await addCardAt(page, 400, 300);
  await page.mouse.click(60, 180);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('.node.card .card-body')).toBeFocused();
  await page.keyboard.type('typed by keyboard');
  await page.keyboard.press('Escape');
  await expect(page.locator('.node.card .card-body')).toContainText('typed by keyboard');
});

test('keyboard: F6 cycles focus through toolbar, palette, and zoom bar', async ({ page }) => {
  await page.keyboard.press('F6');
  expect(await page.evaluate(() => !!document.activeElement.closest('#toolbar'))).toBe(true);
  await page.keyboard.press('F6');
  expect(await page.evaluate(() => !!document.activeElement.closest('#tools'))).toBe(true);
  await page.keyboard.press('F6');
  expect(await page.evaluate(() => !!document.activeElement.closest('#zoombar'))).toBe(true);
  // once focus is in the chrome, Tab traverses it natively instead of cycling nodes
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('#zoombar'))).toBe(true);
});

test('keyboard focus is visible on chrome buttons (WCAG 2.4.7)', async ({ page }) => {
  await page.keyboard.press('F6');
  const style = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return { outline: s.outlineStyle, width: s.outlineWidth };
  });
  expect(style.outline).not.toBe('none');
  expect(parseFloat(style.width)).toBeGreaterThan(0);
});

test('modal focus management: Escape closes the embed modal, focus returns to its trigger', async ({ page }) => {
  await page.click('#addFrame');
  await expect(page.locator('#frame-modal')).toBeVisible();
  await expect(page.locator('#frame-url')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#frame-modal')).toBeHidden();
  await expect(page.locator('#addFrame')).toBeFocused();
});

test('keyboard: Escape closes the button link modal', async ({ page }) => {
  await page.click('#addButton');             // new button opens its link modal
  await expect(page.locator('#button-link-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#button-link-modal')).toBeHidden();
});

test('screen readers: Tab selection is announced via a polite live region', async ({ page }) => {
  await addCardAt(page, 400, 300);
  await page.mouse.click(60, 180);
  await page.keyboard.press('Tab');
  await expect(page.locator('.visually-hidden[aria-live="polite"]')).toContainText('1 of 1');
});

test('reduced motion: the locate flash is a static ring that still clears', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await addCardAt(page, 400, 300);
  await page.mouse.click(60, 180);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#jump')).toBeVisible();
  await page.keyboard.press('Enter');                       // jump to the first (only) item
  await expect(page.locator('.node.flash')).toHaveCount(1); // static highlight applied
  await expect(page.locator('.node.flash')).toHaveCount(0, { timeout: 3000 }); // cleared by timer
});

test('keyboard: C aims a connection at the nearest node and Enter creates it', async ({ page }) => {
  await addCardAt(page, 300, 300);
  await addCardAt(page, 760, 320);
  await page.mouse.click(60, 180);
  await page.keyboard.press('Tab');                    // select the first card
  await page.keyboard.press('c');                      // start aiming
  await expect(page.locator('.node.drop-target')).toHaveCount(1);   // target highlighted
  await expect(page.locator('#connections .conn-temp')).toHaveCount(1); // preview arrow
  await page.keyboard.press('Enter');
  await expect(page.locator('#connections g.conn')).toHaveCount(1);
  await expect(page.locator('.node.drop-target')).toHaveCount(0);   // aim state cleaned up
});

test('keyboard: Escape cancels an aimed connection without creating one', async ({ page }) => {
  await addCardAt(page, 300, 300);
  await addCardAt(page, 760, 320);
  await page.mouse.click(60, 180);
  await page.keyboard.press('Tab');
  await page.keyboard.press('c');
  await expect(page.locator('.node.drop-target')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.node.drop-target')).toHaveCount(0);
  await expect(page.locator('#connections g.conn')).toHaveCount(0);
  await expect(page.locator('#connections .conn-temp')).toHaveCount(0);
});

test('keyboard: the board menu list is arrow-navigable and Enter switches boards', async ({ page }) => {
  await page.click('#boardMenuBtn');
  await page.click('#newBoardBtn');                    // now on "Board 2"
  await expect(page.locator('#board-name')).toHaveText('Board 2');
  await page.click('#boardMenuBtn');                   // reopen the menu
  await page.keyboard.press('ArrowDown');              // into the list
  expect(await page.evaluate(() => document.activeElement.classList.contains('board-row'))).toBe(true);
  await page.keyboard.press('ArrowDown');              // second row = the original board
  await page.keyboard.press('Enter');
  await expect(page.locator('#board-name')).not.toHaveText('Board 2');
  await expect(page.locator('#board-menu')).toBeHidden();
});

test('modals trap Tab: focus cycles inside the embed dialog', async ({ page }) => {
  await page.click('#addFrame');
  await expect(page.locator('#frame-modal')).toBeVisible();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('#frame-modal'))).toBe(true);
  }
  await page.keyboard.press('Escape');
});
