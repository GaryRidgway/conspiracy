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
