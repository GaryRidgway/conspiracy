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
import { readFile } from 'node:fs/promises';
import { drag, addCardAt, worldScale, nodePos, boardOf, cardRecordAt, merge, installErrorGuard } from './helpers.js';

const within = (b, w, h) => b && b.x + b.width > 0 && b.y + b.height > 0 && b.x < w && b.y < h;

installErrorGuard(test);

// ── 1. Getting lost on the infinite canvas (Miro/Excalidraw: "easily get
//      lost", "no way to show all elements") — Fit must recover. ──
test('recover from getting lost: Fit brings off-screen content into view', { tag: '@nav' }, async ({ page }) => {
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

// The other half of Fit: Shift+2 frames just the selection. Unlike Fit it may
// zoom IN — "show me this" is the opposite request from "show me everything", and
// it's the only way to close in on one item without working the zoom control.
test('Shift+2 fits the selection, and zooms in to do it', { tag: '@nav' }, async ({ page }) => {
  const near = await addCardAt(page, 300, 250);
  const far = await addCardAt(page, 2400, 1800);           // spreads the board out
  await page.click('#fitContent');
  const zoomedOut = await worldScale(page);
  expect(zoomedOut).toBeLessThan(1);                        // both cards fit, so it pulled back

  // nothing selected is a no-op, not a jump to the origin. (Two Escapes: focus
  // is still on the Fit button, and the first one steps out of the chrome.)
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(far).not.toHaveClass(/selected/);
  await page.keyboard.press('Shift+2');
  expect(await worldScale(page)).toBe(zoomedOut);

  await far.locator('.card-header').click();
  await expect(far).toHaveClass(/selected/);
  await page.keyboard.press('Shift+2');

  const vp = page.viewportSize();
  await expect.poll(async () => await worldScale(page)).toBeGreaterThan(zoomedOut);
  expect(within(await far.boundingBox(), vp.width, vp.height)).toBe(true);
  // it framed the SELECTION, not everything — the other card is off screen now
  expect(within(await near.boundingBox(), vp.width, vp.height)).toBe(false);
});

// ── 2. Accidental zoom (Zoom Whiteboard backlash: scroll-wheel hijacked to
//      zoom). Plain scroll must PAN, never change zoom. ──
test('plain scroll/trackpad pans and never changes zoom', { tag: '@canvas' }, async ({ page }) => {
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
test('panning promotes #world to a GPU layer and never blanks the live doc', { tag: '@canvas' }, async ({ page }) => {
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
test('the dot grid stays phase-aligned with the world under zoom', { tag: '@canvas' }, async ({ page }) => {
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
test('the edit toolbar stays anchored to its card when the board is panned', { tag: '@canvas' }, async ({ page }) => {
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
test('zoom stays within a sane range and Reset returns home', { tag: '@canvas' }, async ({ page }) => {
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
test('creating a node is discoverable (tool palette button)', { tag: '@chrome' }, async ({ page }) => {
  await expect(page.locator('#tools #addCard')).toBeVisible();
  await expect(page.locator('#helpBtn')).toBeVisible();    // guidance one click away
  await page.click('#addCard');
  await expect(page.locator('.node.card')).toHaveCount(1);
});

// The old always-on hint strip became a ? panel: ? toggles it, Escape and
// clicking elsewhere close it, and it never opens while typing in a field.
test('help: ? toggles the shortcuts panel; Escape and outside clicks close it', { tag: '@chrome' }, async ({ page }) => {
  await page.keyboard.press('?');
  await expect(page.locator('#help-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#help-panel')).toBeHidden();

  await page.click('#helpBtn');
  await expect(page.locator('#help-panel')).toBeVisible();
  await page.mouse.click(400, 500);                        // empty canvas
  await expect(page.locator('#help-panel')).toBeHidden();

  // typing ? inside a card body stays a character, not a shortcut
  const card = await addCardAt(page, 500, 300);
  await card.locator('.card-body').click();
  await page.keyboard.press('?');
  await expect(page.locator('#help-panel')).toBeHidden();
  await expect(card.locator('.card-body')).toHaveText('?');
});

// The suite's storageState pre-seeds fly-to OFF (see playwright.config.js);
// these tests are about the setting itself, so they start from a clean
// profile where the app's own default (ON) shows.
test.describe('settings and fly-to', { tag: ['@nav', '@chrome'] }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('settings: cog opens the panel and the fly-to preference persists', async ({ page }) => {
    await page.click('#settingsBtn');
    await expect(page.locator('#settings-panel')).toBeVisible();
    // the two dropdowns share the corner — opening one closes the other
    await page.click('#helpBtn');
    await expect(page.locator('#help-panel')).toBeVisible();
    await expect(page.locator('#settings-panel')).toBeHidden();
    await page.click('#settingsBtn');
    await expect(page.locator('#settings-panel')).toBeVisible();
    await expect(page.locator('#help-panel')).toBeHidden();

    await expect(page.locator('#setFlyTo')).toBeChecked();   // on by default
    await page.uncheck('#setFlyTo');                          // focuses the checkbox
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-panel')).toBeHidden();
    await expect(page.locator('#settingsBtn')).toBeFocused();   // not dumped on <body>

    await page.reload();
    await page.click('#settingsBtn');
    await expect(page.locator('#setFlyTo')).not.toBeChecked();
  });

  test('fly-to setting: deep-link navigation glides to the same destination', async ({ page }) => {
    const aid = await (await addCardAt(page, 260, 300)).getAttribute('data-id');
    const bid = await (await addCardAt(page, 950, 550)).getAttribute('data-id');

    // jump via deep link, sampling the world transform each frame for 900ms of
    // wall time (past the longest flight) — headless rAF can run unthrottled,
    // so a frame COUNT can elapse before the animation does
    const flight = (id) => page.evaluate((nid) => new Promise((res) => {
      const el = document.getElementById('world');
      const seen = [];
      const start = performance.now();
      const tick = () => {
        seen.push(el.style.transform);
        if (performance.now() - start < 900) requestAnimationFrame(tick); else res(seen);
      };
      location.hash = '#node=' + nid;
      requestAnimationFrame(tick);
    }), id);
    const nums = (t) => t.match(/-?[\d.]+/g).map(Number);
    const near = (a, b) => nums(a).every((v, i) => Math.abs(v - nums(b)[i]) < 1);

    // setting off: a cut — the camera is at B within a frame or two
    await page.click('#settingsBtn');
    await page.uncheck('#setFlyTo');
    await page.keyboard.press('Escape');
    const cut = await flight(bid);
    const finalB = cut[cut.length - 1];
    expect(new Set(cut).size).toBeLessThanOrEqual(3);

    await flight(aid);                     // reposition at A
    await page.click('#settingsBtn');
    await page.check('#setFlyTo');
    await page.keyboard.press('Escape');

    const glide = await flight(bid);
    expect(new Set(glide).size).toBeGreaterThanOrEqual(6);   // eased in-between frames
    expect(glide[glide.length - 1]).toBe(glide[glide.length - 2]);   // …that settle
    expect(near(glide[glide.length - 1], finalB)).toBe(true);        // on the same landing spot
  });
});

// Connection handles reveal only near the cursor's side of the node, so a
// hover doesn't light all four dots up as permanent-looking chrome.
test('connection dots reveal only near their side of the node', { tag: '@connections' }, async ({ page }) => {
  const id = await (await addCardAt(page, 450, 320)).getAttribute('data-id');
  const node = page.locator(`.node.card[data-id="${id}"]`);
  const bb = await node.boundingBox();

  // mid-card: the left/right handles (~120px away) stay dark
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await expect(node.locator('.port.left')).not.toHaveClass(/near/);
  await expect(node.locator('.port.right')).not.toHaveClass(/near/);

  // near the left edge: that handle lights, the far one stays dark
  await page.mouse.move(bb.x + 8, bb.y + bb.height / 2);
  await expect(node.locator('.port.left')).toHaveClass(/near/);
  await expect(node.locator('.port.left')).toHaveCSS('opacity', '0.95');
  await expect(node.locator('.port.right')).not.toHaveClass(/near/);

  // leaving the node clears everything
  await page.mouse.move(bb.x - 80, bb.y + bb.height / 2);
  await expect(node.locator('.port.left')).not.toHaveClass(/near/);
});

// ── 5. Accidental deletion + weak undo (Microsoft Whiteboard: "can't undo a
//      deleted sticky", "lost months"). Deletion must be recoverable. ──
test('a deleted node is recoverable via undo', { tag: '@undo' }, async ({ page }) => {
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
test('selection is visually obvious', { tag: '@select' }, async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  await page.mouse.click(60, 200);                          // deselect
  await expect(page.locator('.node.card.selected')).toHaveCount(0);
  const hb = await node.locator('.card-header').boundingBox();
  await page.mouse.click(hb.x + hb.width * 0.5, hb.y + hb.height / 2);
  await expect(page.locator('.node.card.selected')).toHaveCount(1);
});

// ── 7. Escape is a safe, predictable "get me out" — never destructive. ──
test('Escape clears selection without deleting anything', { tag: '@select' }, async ({ page }) => {
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
test('open menus dismiss on Escape and outside-click', { tag: '@chrome' }, async ({ page }) => {
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
test('a live zoom readout is always shown', { tag: '@chrome' }, async ({ page }) => {
  await expect(page.locator('#zoomReset')).toHaveText('100%');
  await page.evaluate(() => document.getElementById('viewport').dispatchEvent(
    new WheelEvent('wheel', { deltaY: -400, clientX: 600, clientY: 400, ctrlKey: true, bubbles: true, cancelable: true })));
  await expect(page.locator('#zoomReset')).not.toHaveText('100%');
});

// ── 10. No lost work: a reload restores the board. ──
test('work is not lost across a reload', { tag: '@boards' }, async ({ page }) => {
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
test('viewport persists locally across reload but stays out of board content', { tag: '@boards' }, async ({ page }) => {
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
test('leaving the tab flushes a pending edit without waiting for the debounce', { tag: '@boards' }, async ({ page }) => {
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
test('box-select: dragging on empty canvas rubber-bands a selection', { tag: '@select' }, async ({ page }) => {
  await addCardAt(page, 300, 300);
  await addCardAt(page, 560, 320);
  await page.mouse.click(60, 180);                            // deselect
  await expect(page.locator('.node.card.selected')).toHaveCount(0);
  await drag(page, { x: 180, y: 200 }, { x: 780, y: 520 });   // lasso around both
  await expect(page.locator('.node.card.selected')).toHaveCount(2);
});

// Multi-select + move together (Miro/FigJam standard).
test('multiple selected nodes move together', { tag: '@select' }, async ({ page }) => {
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
test('shift-click toggles a node in the selection', { tag: '@select' }, async ({ page }) => {
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
test('duplicate a node with Cmd/Ctrl+D', { tag: '@select' }, async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  const hb = await node.locator('.card-header').boundingBox();
  await page.mouse.click(hb.x + hb.width * 0.5, hb.y + hb.height / 2);
  await page.keyboard.press('ControlOrMeta+d');
  await expect(page.locator('.node.card')).toHaveCount(2);
  // the copy is offset and becomes the new selection
  await expect(page.locator('.node.card.selected')).toHaveCount(1);
});

test('duplicating a multi-selection copies the group and is one undo step', { tag: ['@select', '@undo'] }, async ({ page }) => {
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
test('copy and paste a node', { tag: '@select' }, async ({ page }) => {
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

// A paste lands where the CURSOR is, not next to the original. Offsetting from
// the original meant copying something, panning away, and pasting put the copy
// back where it came from — off screen, indistinguishable from nothing having
// happened. Repeat pastes from one spot still cascade so they don't stack.
test('paste lands under the cursor, however far from the original', { tag: '@select' }, async ({ page }) => {
  const node = await addCardAt(page, 450, 350);
  const hb = await node.locator('.card-header').boundingBox();
  await page.mouse.click(hb.x + hb.width * 0.5, hb.y + hb.height / 2);
  await page.keyboard.press('ControlOrMeta+c');
  const origin = await nodePos(node);

  // pan a long way off, so "near the original" and "near the cursor" are nowhere
  // close to each other
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 8; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaX: 400, deltaY: 300, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await node.boundingBox()) === null
    || !within(await node.boundingBox(), page.viewportSize().width, page.viewportSize().height)).toBe(true);

  await page.mouse.move(700, 500);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.node.card')).toHaveCount(2);
  const copy = page.locator('.node.card.selected');
  const box = await copy.boundingBox();
  expect(Math.abs(box.x - 700)).toBeLessThan(3);       // top-left at the cursor
  expect(Math.abs(box.y - 500)).toBeLessThan(3);
  const pasted = await nodePos(copy);
  expect(Math.abs(pasted.x - origin.x)).toBeGreaterThan(1000);   // nowhere near the original

  // a second ⌘V from the same spot cascades rather than stacking exactly
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.node.card')).toHaveCount(3);
  const third = await nodePos(page.locator('.node.card.selected'));
  expect(third.x - pasted.x).toBeCloseTo(24, 0);
  expect(third.y - pasted.y).toBeCloseTo(24, 0);

  // …and moving the cursor starts over from there, no accumulated drift
  await page.mouse.move(500, 300);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.node.card')).toHaveCount(4);
  const fourth = await page.locator('.node.card.selected').boundingBox();
  expect(Math.abs(fourth.x - 500)).toBeLessThan(3);
  expect(Math.abs(fourth.y - 300)).toBeLessThan(3);
});

// Right-click context menu (Miro/FigJam: add-here / duplicate / delete).
test('right-click opens a context menu on the canvas and on a node', { tag: '@chrome' }, async ({ page }) => {
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
test('color-code a node from the context menu; it tints and persists', { tag: '@cards' }, async ({ page }) => {
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
test('choosing "no color" clears a node color', { tag: '@cards' }, async ({ page }) => {
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
test('a connection fades between its two nodes\' colors', { tag: '@connections' }, async ({ page }) => {
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

// Regression: drawConnection caches the gradient's stop colors (they can only
// change when an endpoint's color does, never per drag-frame). Recoloring a
// node AFTER the connection exists must invalidate that cache — the test
// above colors both nodes first, so it would never catch the cache staying
// stale on the live gradient.
test('recoloring a node updates an existing connection\'s gradient', { tag: '@connections' }, async ({ page }) => {
  const aid = await (await addCardAt(page, 300, 300)).getAttribute('data-id');
  const bid = await (await addCardAt(page, 760, 320)).getAttribute('data-id');
  const A = page.locator(`.node.card[data-id="${aid}"]`);
  const B = page.locator(`.node.card[data-id="${bid}"]`);
  await A.hover();
  const port = await A.locator('.port.right').boundingBox();
  const bb = await B.boundingBox();
  await drag(page, { x: port.x + port.width / 2, y: port.y + port.height / 2 },
                   { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 });
  const conn = page.locator('#connections g.conn');
  await expect(conn).toHaveCount(1);
  const stops = conn.locator('linearGradient stop');
  const neutral = await stops.first().getAttribute('stop-color');   // both ends uncolored

  await A.click({ button: 'right' });
  await page.locator('#context-menu .ctx-swatch[title="Red"]').click();
  await expect(stops.first()).toHaveAttribute('stop-color', '#F87171');
  expect(neutral).not.toBe('#F87171');

  await B.click({ button: 'right' });
  await page.locator('#context-menu .ctx-swatch[title="Blue"]').click();
  await expect(stops.last()).toHaveAttribute('stop-color', '#6BA6FF');
  await expect(conn.locator('marker path')).toHaveAttribute('fill', '#6BA6FF');   // arrowhead re-tints too
});

// Connect two cards and return the exact screen point of the curve's middle
// (the label anchor / dblclick target).
async function connectTwoCards(page) {
  // addCardAt returns a data-id-pinned locator, so A/B stay put as more nodes appear
  const A = await addCardAt(page, 300, 300);
  const B = await addCardAt(page, 760, 320);
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
test('a connection can be labeled by double-clicking it, and the label persists', { tag: '@connections' }, async ({ page }) => {
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
test('an emptied connection label disappears, and deleting the connection removes it', { tag: '@connections' }, async ({ page }) => {
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
test('clicking a legend dot spotlights that color and dims the rest', { tag: '@cards' }, async ({ page }) => {
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
test('quick jump finds a card by its text and flies the viewport to it', { tag: '@nav' }, async ({ page }) => {
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
test('Find button opens quick jump; Escape closes it', { tag: '@nav' }, async ({ page }) => {
  await addCardAt(page, 450, 350);
  await page.click('#findBtn');
  await expect(page.locator('#jump')).toBeVisible();
  await expect(page.locator('#jump-list .np-item')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#jump')).toBeHidden();
});

// Regression: the three type-ahead popups (⌘K jump, node-picker, button-link
// modal) move a highlight with a `.sel` class, which is invisible to a screen
// reader without role=listbox/option + aria-activedescendant on the input.
test('quick jump exposes listbox semantics and tracks the highlight via aria-activedescendant', { tag: '@nav' }, async ({ page }) => {
  await addCardAt(page, 450, 350);
  await addCardAt(page, 700, 350);
  await page.keyboard.press('ControlOrMeta+k');
  const list = page.locator('#jump-list');
  const input = page.locator('#jump-input');
  await expect(list).toHaveAttribute('role', 'listbox');
  const items = list.locator('.np-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute('role', 'option');
  await expect(items.nth(0)).toHaveAttribute('aria-selected', 'true');   // auto-highlighted
  await expect(items.nth(1)).toHaveAttribute('aria-selected', 'false');
  const firstId = await items.nth(0).getAttribute('id');
  await expect(input).toHaveAttribute('aria-activedescendant', firstId);

  await page.keyboard.press('ArrowDown');
  await expect(items.nth(0)).toHaveAttribute('aria-selected', 'false');
  await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true');
  const secondId = await items.nth(1).getAttribute('id');
  await expect(input).toHaveAttribute('aria-activedescendant', secondId);
});

// Node-picker and the button-link modal only ever picked the FIRST search hit
// on Enter — no arrow-key highlight existed at all. Both now share the same
// arrow-driven highlight as quick jump, so Enter follows the highlight.
test('arrow keys move the highlight in the node-link picker, and Enter follows it', { tag: '@nav' }, async ({ page }) => {
  const a = await addCardAt(page, 250, 300);
  const idA = await a.getAttribute('data-id');
  const b = await addCardAt(page, 550, 300);
  await b.locator('.card-title').dblclick();
  await page.keyboard.type('Match One');
  await page.keyboard.press('Enter');
  const c = await addCardAt(page, 850, 300);
  await c.locator('.card-title').dblclick();
  await page.keyboard.type('Match Two');
  await page.keyboard.press('Enter');
  const idC = await c.getAttribute('data-id');

  const bodyA = page.locator(`.node[data-id="${idA}"] .card-body`);
  await bodyA.click();
  await page.click('#tt-link');
  await page.locator('#np-filter').fill('Match');
  await expect(page.locator('#node-picker .np-item')).toHaveCount(2);

  await page.keyboard.press('ArrowDown');   // off the auto-highlighted first hit (Match One)…
  await page.keyboard.press('Enter');       // …and onto the second (Match Two)
  const chip = bodyA.locator('a.node-link');
  await expect(chip).toHaveAttribute('data-node', idC);
});

// The Remove row must never fire on a bare Enter (that would silently unlink
// on a stray keystroke) but an explicit arrow press should still reach it.
test('the node-picker Remove row is skipped by a bare Enter but reachable by arrowing to it', { tag: '@nav' }, async ({ page }) => {
  const a = await addCardAt(page, 300, 300);
  const idA = await a.getAttribute('data-id');
  const b = await addCardAt(page, 700, 300);
  const idB = await b.getAttribute('data-id');
  const bodyA = page.locator(`.node[data-id="${idA}"] .card-body`);
  await bodyA.click();
  await page.click('#tt-link');
  await page.locator(`#node-picker .np-item[data-id="${idB}"]`).click();
  const chip = bodyA.locator('a.node-link');
  await expect(chip).toHaveCount(1);

  // reopen on the existing link: it's now editing, and Remove sits on top
  await page.evaluate(() => {
    const el = document.querySelector('a.node-link');
    const r = document.createRange();
    r.selectNode(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.click('#tt-link');
  await expect(page.locator('#node-picker .np-remove')).toBeVisible();

  // bare Enter must still re-target to the top real hit, not remove the link
  await page.keyboard.press('Enter');
  await expect(bodyA.locator('a.node-link')).toHaveCount(1);

  // reopen and this time arrow up onto Remove explicitly, then Enter
  await page.evaluate(() => {
    const el = document.querySelector('a.node-link');
    const r = document.createRange();
    r.selectNode(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.click('#tt-link');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#node-picker .np-remove')).toHaveClass(/sel/);
  await page.keyboard.press('Enter');
  await expect(bodyA.locator('a.node-link')).toHaveCount(0);
});

// The button-link modal never had arrow-key navigation either — Enter always
// took the DOM-first item. Same shared fix applies there.
test('arrow keys move the highlight in the button-link modal, and Enter follows it', { tag: '@buttons' }, async ({ page }) => {
  const b = await addCardAt(page, 450, 300);
  await b.locator('.card-title').dblclick();
  await page.keyboard.type('Match One');
  await page.keyboard.press('Enter');
  const c = await addCardAt(page, 750, 300);
  await c.locator('.card-title').dblclick();
  await page.keyboard.type('Match Two');
  await page.keyboard.press('Enter');
  const idC = await c.getAttribute('data-id');

  await page.click('#addButton');
  const modal = page.locator('#button-link-modal');
  await expect(modal).toBeVisible();
  await page.keyboard.type('Match');
  await expect(modal.locator('.np-item')).toHaveCount(2);

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(modal).toBeHidden();
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  const stored = await page.evaluate(() => {
    const cur = localStorage.getItem('whiteboard:current');
    const b = JSON.parse(localStorage.getItem('whiteboard:board:' + cur));
    return b.cards[Object.keys(b.cards).find((k) => b.cards[k].kind === 'button')].action;
  });
  expect(stored).toEqual({ type: 'node', target: idC });
});

// Paste a screenshot on the canvas → it becomes an image NODE referencing the
// bytes (downscaled into the asset store, no remote fetch), which persists like
// any card. The bytes never enter the board JSON — see the IMAGE ASSETS banner.
async function pasteImage(page, w = 60, h = 40) {
  await page.evaluate(async ([w, h]) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F87171'; ctx.fillRect(0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [w, h]);
}

test('pasting an image on the canvas creates an image node that persists', { tag: '@cards' }, async ({ page }) => {
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  await expect(node).toHaveCount(1);
  const img = node.locator('.image-src');
  await expect.poll(() => img.getAttribute('src')).toMatch(/^blob:/);   // resolved from the store

  await expect(page.locator('#saveState')).toHaveText('saved');
  const stored = await page.evaluate(() =>
    localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current')));
  expect(stored).toMatch(/"asset":"a_[a-z0-9]+"/);   // a reference on the record
  expect(stored).not.toContain('data:image/');       // the whole point: no base64 in localStorage
  // the display box came from the image's own pixels (60×40), not a fixed default
  const rec = await imageRecord(page);
  expect(rec.kind).toBe('image');
  expect(rec.w / rec.h).toBeCloseTo(60 / 40, 1);

  await page.reload();
  await expect(page.locator('.node.image-node')).toHaveCount(1);
  await expect.poll(() => page.locator('.image-src').getAttribute('src')).toMatch(/^blob:/);  // from IndexedDB
});

// Copying a board node must not disable image paste. The internal clipboard is
// sticky for the whole session, so a guard keyed on "is the clipboard full?"
// silently killed every image paste after the first ⌘C — the guard has to be
// scoped to the one ⌘V that actually pasted nodes.
test('copying a node does not stop images from pasting', { tag: '@cards' }, async ({ page }) => {
  await pasteImage(page);
  const nodes = page.locator('.node.image-node');
  await expect(nodes).toHaveCount(1);

  await nodes.click();
  await page.keyboard.press('Meta+c');
  await pasteImage(page);
  await expect(nodes).toHaveCount(2);

  // ...and the guard still does its job: ⌘V pastes the copied node, and the
  // screenshot still sitting on the OS clipboard does not ride along with it.
  await page.keyboard.press('Meta+v');
  await expect(nodes).toHaveCount(3);          // the pasted copy, nothing more
});

// A pasted screenshot lands under the cursor (not the viewport centre) — the
// node's client-space top-left should match where the mouse last was.
test('pasted image lands under the cursor', { tag: '@cards' }, async ({ page }) => {
  await page.mouse.move(210, 460);
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  await expect(node).toHaveCount(1);
  const box = await node.boundingBox();
  expect(Math.abs(box.x - 210)).toBeLessThan(3);
  expect(Math.abs(box.y - 460)).toBeLessThan(3);
});

// Pasting while editing a card drops the image inline; remote <img> tags are
// stripped by the sanitizer (data URIs only — no tracking pixels).
test('image pastes inline into a card being edited; remote images are stripped', { tag: '@cards' }, async ({ page }) => {
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
  const imgs = await page.locator('.card-body img').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-asset')));
  expect(imgs.length).toBe(1);                       // remote img dropped
  expect(imgs[0]).toMatch(/^a_[a-z0-9]+$/);          // the pasted one survives, as a reference
});

// ── Image assets: the bytes live in IndexedDB, the record holds a reference ──

// A 4×3 solid PNG, built in the page so it's a genuinely valid encoding.
const makeDataUri = (page) => page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 3;
  const x = c.getContext('2d');
  x.fillStyle = '#6BA6FF'; x.fillRect(0, 0, 4, 3);
  return c.toDataURL('image/png');
});
const storedBoard = (page) => page.evaluate(() =>
  localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current')));
// The stored record of the board's one image node.
const imageRecord = (page) => page.evaluate(() => {
  const b = JSON.parse(localStorage.getItem(
    'whiteboard:board:' + localStorage.getItem('whiteboard:current')));
  return Object.values(b.cards).find((c) => c.kind === 'image');
});
// Read one asset record straight out of IndexedDB, bypassing the app.
const assetExists = (page, id) => page.evaluate((aid) => new Promise((res) => {
  const req = indexedDB.open('whiteboard', 1);
  req.onsuccess = () => {
    const g = req.result.transaction('assets', 'readonly').objectStore('assets').get(aid);
    g.onsuccess = () => res(!!g.result);
    g.onerror = () => res(false);
  };
  req.onerror = () => res(false);
}), id);

// The rendered image carries a blob: URL, and that URL must never reach a
// record — otherwise the sanitizer's data:-only src rule would be a fiction and
// a reload would show a dead reference to a previous page's object URL.
test('a blob URL from a rendered image never reaches storage', { tag: '@cards' }, async ({ page }) => {
  // the inline path is the one at risk: a card body round-trips through
  // sanitizeHtml on every keystroke, blob src and all
  const node = await addCardAt(page, 400, 300);
  const body = node.locator('.card-body');
  await body.click();
  await pasteImage(page);
  await expect.poll(() => body.locator('img').getAttribute('src')).toMatch(/^blob:/);
  await page.keyboard.type('caption');
  await expect(page.locator('#saveState')).toHaveText('saved');
  const stored = await storedBoard(page);
  expect(stored).toContain('data-asset=');
  expect(stored).not.toContain('blob:');
  expect(stored).not.toContain('data:image/');
});

// A board written before the asset store existed holds base64 in its JSON.
// Opening it moves the bytes out and rewrites the reference, without the user
// doing anything — and the image keeps rendering throughout.
test('a legacy inline image migrates out of the board JSON on open', { tag: '@boards' }, async ({ page }) => {
  const uri = await makeDataUri(page);
  await page.evaluate((u) => {
    const key = 'whiteboard:board:' + localStorage.getItem('whiteboard:current');
    const content = JSON.parse(localStorage.getItem(key));
    content.cards['c_legacyimg'] = { x: 120, y: 140, title: 'shot', body: '<img src="' + u + '">' };
    localStorage.setItem(key, JSON.stringify(content));
  }, uri);
  await page.reload();

  await expect.poll(() => storedBoard(page)).toContain('data-asset=');
  const stored = await storedBoard(page);
  expect(stored).not.toContain('data:image/');       // the base64 is gone from localStorage
  const img = page.locator('.node.card[data-id="c_legacyimg"] .card-body img');
  await expect(img).toHaveCount(1);
  // the intrinsic size was recovered on the way through, so the box is right
  await expect(img).toHaveAttribute('width', '4');
  await expect(img).toHaveAttribute('height', '3');
  await expect.poll(() => img.getAttribute('src')).toMatch(/^blob:/);
});

// An export has to be self-contained — it's opened on a machine with no store
// of ours — so it inlines the bytes again, and importing one unpacks them.
test('export inlines image bytes; importing one puts them back in the store', { tag: '@boards' }, async ({ page }) => {
  await pasteImage(page);                                  // → an image node
  const card = await addCardAt(page, 620, 380);
  await card.locator('.card-body').click();
  await pasteImage(page);                                  // → inline in a card body
  await expect(page.locator('#saveState')).toHaveText('saved');

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  const recs = Object.values(exported.cards);
  // both reference forms travel with the file — bytes on the node's own record,
  // bytes back in the src of the body's <img>
  const node = recs.find((c) => c.kind === 'image');
  expect(node.assetData).toMatch(/^data:image\//);
  const bodies = recs.map((c) => c.body || '').join('');
  expect(bodies).toContain('data:image/');
  expect(bodies).not.toContain('data-asset=');

  // Import into a machine that has never seen these bytes: the ids in the file
  // are the exporter's, so the import has to decode assetData rather than trust
  // a reference into a store it doesn't have.
  node.asset = 'a_theirdevice01';
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setInputFiles('#importFile', {
    name: 'board.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(page.locator('.node.card .card-body img')).toHaveCount(1);
  await expect(page.locator('.node.image-node')).toHaveCount(1);
  await expect.poll(() => storedBoard(page)).toContain('data-asset=');
  const stored = await storedBoard(page);
  expect(stored).not.toContain('data:image/');       // unpacked into the store, not the JSON
  expect(stored).not.toContain('a_theirdevice01');   // re-keyed to bytes that are actually here
  await expect.poll(() => page.locator('.image-src').getAttribute('src')).toMatch(/^blob:/);
});

// An asset no board refers to any more is dead weight in a store whose whole
// purpose is headroom. Reaped at boot — the only point where undo history
// can't still be holding a reference.
//
// BOTH spellings of a reference have to count: an image node's `asset` field and
// `data-asset` inside a card body. A GC that knew only the HTML form would reap
// every image node's picture at the next boot.
//
// The records are seeded before the bytes on purpose. Boot's GC runs on an idle
// callback, which under load can fire after the test has started seeding — with
// the references already in place, whenever it runs is fine.
test('the boot GC reaps unreferenced assets and keeps referenced ones', { tag: '@boards' }, async ({ page }) => {
  await page.evaluate(() => {
    const key = 'whiteboard:board:' + localStorage.getItem('whiteboard:current');
    const content = JSON.parse(localStorage.getItem(key));
    content.cards['c_imgnode'] = { kind: 'image', x: 200, y: 160, w: 80, h: 60, asset: 'a_onanode01' };
    content.cards['c_imgbody'] = { x: 460, y: 160, title: '',
      body: '<img data-asset="a_inabody01" width="4" height="3">' };
    localStorage.setItem(key, JSON.stringify(content));
  });
  await page.evaluate(() => new Promise((res, rej) => {
    const req = indexedDB.open('whiteboard', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const t = req.result.transaction('assets', 'readwrite');
      const s = t.objectStore('assets');
      // added:0 puts all three outside the grace window that protects a fresh paste
      for (const id of ['a_orphan01', 'a_onanode01', 'a_inabody01']) {
        s.put({ id, blob: new Blob(['x'], { type: 'image/png' }), w: 4, h: 3, added: 0 });
      }
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    };
    req.onerror = () => rej(req.error);
  }));
  await page.reload();
  // the orphan going is what proves the GC ran at all in this boot
  await expect.poll(() => assetExists(page, 'a_orphan01'), { timeout: 15000 }).toBe(false);
  expect(await assetExists(page, 'a_onanode01')).toBe(true);
  expect(await assetExists(page, 'a_inabody01')).toBe(true);
});

// The bytes can be absent legitimately — a Drive board opened on a second
// device before its assets arrive, or an evicted store. That has to read as a
// placeholder holding the image's box, not as a collapsed empty card.
test('a reference with no bytes renders a sized placeholder', { tag: '@cards' }, async ({ page }) => {
  await page.evaluate(() => {
    const key = 'whiteboard:board:' + localStorage.getItem('whiteboard:current');
    const content = JSON.parse(localStorage.getItem(key));
    content.cards['c_ghostimg'] = { x: 120, y: 140, title: 'shot',
      body: '<img data-asset="a_nothere01" width="120" height="80">' };
    localStorage.setItem(key, JSON.stringify(content));
  });
  await page.reload();
  const img = page.locator('.node.card[data-id="c_ghostimg"] .card-body img');
  await expect(img).toHaveClass(/asset-missing/);
  const box = await img.boundingBox();
  expect(box.width).toBeCloseTo(120, 0);
  expect(box.height).toBeGreaterThan(31);       // reserves a box instead of collapsing
});

// ── Image nodes: a picture as a node of its own (kind:'image' on cards) ──

// Corner drags hold the proportions the user can see; edge drags are the
// deliberate stretch. Between them that's any dimensions, with nothing to learn.
test('an image node resizes proportionally from a corner and freely from an edge', { tag: '@cards' }, async ({ page }) => {
  await pasteImage(page);                          // a 60×40 source
  const node = page.locator('.node.image-node');
  await expect(node).toHaveCount(1);
  const saved = page.locator('#saveState');
  await expect(saved).toHaveText('saved');
  const start = await imageRecord(page);
  expect([start.w, start.h]).toEqual([60, 40]);    // box came from the image's own pixels

  // pull the SE corner sideways only: the height has to follow anyway
  let box = await node.boundingBox();
  await drag(page, { x: box.x + box.width, y: box.y + box.height },
    { x: box.x + box.width + 60, y: box.y + box.height });
  await expect(saved).toHaveText('saved');
  const corner = await imageRecord(page);
  expect(corner.w).toBeCloseTo(120, 0);
  expect(corner.w / corner.h).toBeCloseTo(60 / 40, 1);

  // the same pull on the east edge changes width alone. Grab it away from the
  // midpoint — the connection port owns that spot.
  box = await node.boundingBox();
  await drag(page, { x: box.x + box.width, y: box.y + 20 },
    { x: box.x + box.width - 60, y: box.y + 20 });
  await expect(saved).toHaveText('saved');
  const edge = await imageRecord(page);
  expect(edge.w).toBeCloseTo(60, 0);
  expect(edge.h).toBeCloseTo(corner.h, 0);         // stretched, not scaled

  await page.reload();
  await expect.poll(async () => (await imageRecord(page)).w).toBeCloseTo(60, 0);
});

// An image node has no header, so the picture itself is the drag surface —
// otherwise the node would be unmovable.
test('an image node drags by the picture', { tag: '@cards' }, async ({ page }) => {
  await page.mouse.move(300, 300);
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  const before = await nodePos(node);
  const box = await node.boundingBox();
  await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2 + 140, y: box.y + box.height / 2 + 90 });
  const after = await nodePos(node);
  expect(after.x - before.x).toBeCloseTo(140, 0);
  expect(after.y - before.y).toBeCloseTo(90, 0);
});

// The bytes can be absent legitimately (a board synced ahead of its images, an
// evicted store). The node's stored box holds the layout regardless.
test('an image node with no bytes here renders a sized placeholder', { tag: '@cards' }, async ({ page }) => {
  await page.evaluate(() => {
    const key = 'whiteboard:board:' + localStorage.getItem('whiteboard:current');
    const content = JSON.parse(localStorage.getItem(key));
    content.cards['c_ghostnode'] = { kind: 'image', x: 150, y: 150, w: 140, h: 90, asset: 'a_nothere02' };
    localStorage.setItem(key, JSON.stringify(content));
  });
  await page.reload();
  const node = page.locator('.node.image-node[data-id="c_ghostnode"]');
  await expect(node).toHaveClass(/asset-missing/);
  const box = await node.boundingBox();
  expect(box.width).toBeCloseTo(140, 0);
  expect(box.height).toBeCloseTo(90, 0);
});

// The palette's Image tool: pictures from disk, not just the clipboard. Centred
// on the point you asked for, and multiples cascade instead of stacking.
test('the Image tool adds pictures from a file', { tag: '@cards' }, async ({ page }) => {
  const png = Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 80; c.height = 80;
    const x = c.getContext('2d');
    x.fillStyle = '#5AD19A'; x.fillRect(0, 0, 80, 80);
    return c.toDataURL('image/png').split(',')[1];
  }), 'base64');

  const chooser = page.waitForEvent('filechooser');
  await page.click('#addImage');
  await (await chooser).setFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: png },
    { name: 'two.png', mimeType: 'image/png', buffer: png },
  ]);

  const nodes = page.locator('.node.image-node');
  await expect(nodes).toHaveCount(2);
  await expect.poll(() => nodes.first().locator('.image-src').getAttribute('src')).toMatch(/^blob:/);
  const [a, b] = await Promise.all([nodePos(nodes.nth(0)), nodePos(nodes.nth(1))]);
  expect(b.x - a.x).toBeCloseTo(28, 0);            // cascaded, not stacked
  expect(b.y - a.y).toBeCloseTo(28, 0);
  await expect(page.locator('#saveState')).toHaveText('saved');
});

// Depth traces the visible picture, not the node's rectangle — and the ONLY
// thing keeping that true is that the shadow sits one element out from the mask.
// Filters paint before clipping, so a drop-shadow on the clipped element itself
// is clipped away to nothing; collapsing these two divs would silently leave
// every image with no shadow at all, which no screenshot-free test would notice.
test('an image casts its shadow outside its mask, not around its box', { tag: '@cards' }, async ({ page }) => {
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  await expect(node).toHaveCount(1);

  await node.click({ button: 'right' });
  await page.locator('#context-menu .ctx-shape[data-shape="circle"]').click();
  await expect(node).toHaveAttribute('data-shape', 'circle');
  // Deselect and let the ring finish fading — mid-transition it still computes
  // to a shadow, so this has to be the retrying assertion, not a snapshot read.
  await page.mouse.click(600, 500);
  await expect(node).toHaveCSS('box-shadow', 'none');      // no rectangle behind the circle

  const geom = await node.evaluate((el) => {
    const shade = el.querySelector('.image-shade');
    const clip = el.querySelector('.image-clip');
    return {
      shadow: getComputedStyle(shade).filter,
      nested: shade.contains(clip) && shade !== clip,
      clipFilter: getComputedStyle(clip).filter,          // must stay none, or the clip eats it
      masked: getComputedStyle(clip).clipPath,
    };
  });
  expect(geom.shadow).toMatch(/drop-shadow/);
  expect(geom.nested).toBe(true);
  expect(geom.clipFilter).toBe('none');
  expect(geom.masked).not.toBe('none');
});

// Shapes are a MASK: the box and the bytes are untouched, so Rectangle brings
// the whole picture back. The record carries only a key — the geometry is CSS,
// shared with the menu's preview chips.
test('an image can be masked to a circle, and back again', { tag: '@cards' }, async ({ page }) => {
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  await expect(node).toHaveCount(1);
  const saved = page.locator('#saveState');
  await expect(saved).toHaveText('saved');
  const before = await imageRecord(page);

  await node.click({ button: 'right' });
  // the chip standing for the current shape is the one marked active
  await expect(page.locator('#context-menu .ctx-shape[data-shape="rect"]')).toHaveClass(/active/);
  await page.locator('#context-menu .ctx-shape[data-shape="circle"]').click();

  await expect(node).toHaveAttribute('data-shape', 'circle');
  const clip = () => node.locator('.image-clip').evaluate((el) => getComputedStyle(el).clipPath);
  expect(await clip()).not.toBe('none');
  await expect(saved).toHaveText('saved');
  const circled = await imageRecord(page);
  expect(circled.shape).toBe('circle');
  expect([circled.w, circled.h, circled.asset]).toEqual([before.w, before.h, before.asset]);

  await page.reload();
  await expect(page.locator('.node.image-node')).toHaveAttribute('data-shape', 'circle');

  // back to Rectangle: the field goes away rather than storing a default
  await page.locator('.node.image-node').click({ button: 'right' });
  await page.locator('#context-menu .ctx-shape[data-shape="rect"]').click();
  await expect(page.locator('.node.image-node')).toHaveAttribute('data-shape', 'rect');
  await expect(saved).toHaveText('saved');
  expect('shape' in await imageRecord(page)).toBe(false);
});

// Retiring a shape needs no migration, because imageShape() only trusts keys
// still in IMAGE_SHAPES — a board that kept a stored `star` shows the whole
// picture rather than an unmasked-but-still-flagged node or a broken clip-path.
test('a retired shape key falls back to the whole picture', { tag: '@cards' }, async ({ page }) => {
  await pasteImage(page);
  await expect(page.locator('.node.image-node')).toHaveCount(1);
  await expect(page.locator('#saveState')).toHaveText('saved');

  await expect(page.locator('.node.image-node')).toHaveAttribute('data-shape', 'rect');
  await page.locator('.node.image-node').click({ button: 'right' });
  await expect(page.locator('#context-menu .ctx-shape')).toHaveCount(6);          // no star
  await expect(page.locator('#context-menu .ctx-shape[data-shape="star"]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // a board written by a build that still had it
  await page.evaluate(() => {
    const key = 'whiteboard:board:' + localStorage.getItem('whiteboard:current');
    const b = JSON.parse(localStorage.getItem(key));
    for (const c of Object.values(b.cards)) if (c.kind === 'image') c.shape = 'star';
    localStorage.setItem(key, JSON.stringify(b));
  });
  await page.reload();
  const node = page.locator('.node.image-node');
  await expect(node).toHaveAttribute('data-shape', 'rect');
  expect(await node.locator('.image-clip').evaluate((el) => getComputedStyle(el).clipPath)).toBe('none');
});

// Crop is non-destructive: a source rect over untouched bytes. The invariant
// that makes it feel right is that a handle drag moves the WINDOW while the
// picture holds still — which is checkable, because the bright window and the
// dimmed ghost are then the same picture in the same place.
test('cropping an image moves the window, not the picture', { tag: '@cards' }, async ({ page }) => {
  await page.mouse.move(320, 300);
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  await expect(node).toHaveCount(1);
  const saved = page.locator('#saveState');
  await expect(saved).toHaveText('saved');
  const before = await imageRecord(page);

  await node.dblclick();
  await expect(node).toHaveClass(/cropping/);
  const ghost = node.locator('.crop-ghost');
  await expect(ghost).toBeVisible();

  // pull the west edge in: the window's left edge moves, the picture does not
  let box = await node.boundingBox();
  await drag(page, { x: box.x, y: box.y + box.height / 2 },
    { x: box.x + 20, y: box.y + box.height / 2 });
  await expect(saved).toHaveText('saved');

  const cropped = await imageRecord(page);
  expect(cropped.crop.x).toBeGreaterThan(0.2);
  expect(cropped.crop.w).toBeLessThan(0.8);
  expect(cropped.crop.h).toBe(1);                    // only the one edge moved
  expect(cropped.asset).toBe(before.asset);          // the bytes are never touched
  expect(cropped.w).toBeCloseTo(before.w - 20, 0);   // the box shrank by the drag
  // the picture in the window and the picture in the ghost are the same picture
  // in the same place — i.e. it did not slide under the cursor
  const [shown, whole] = await Promise.all([node.locator('.image-src').boundingBox(), ghost.boundingBox()]);
  expect(shown.x).toBeCloseTo(whole.x, 0);
  expect(shown.y).toBeCloseTo(whole.y, 0);
  expect(shown.width).toBeCloseTo(whole.width, 0);

  // Escape leaves the mode, keeping the edit (it was never provisional)
  await page.keyboard.press('Escape');
  await expect(node).not.toHaveClass(/cropping/);
  await expect(node.locator('.crop-ghost')).toHaveCount(0);
  await expect(saved).toHaveText('saved');
  await page.reload();
  const after = await imageRecord(page);
  expect(after.crop).toEqual(cropped.crop);
});

// Dragging inside the window is the other half: there the picture slides and the
// node stays exactly where it sits on the board.
test('panning inside a crop slides the picture, not the node', { tag: '@cards' }, async ({ page }) => {
  await page.mouse.move(360, 320);
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  await expect(node).toHaveCount(1);
  const saved = page.locator('#saveState');
  await expect(saved).toHaveText('saved');

  // crop in from the east first, so there's room left to pan into
  await node.dblclick();
  let box = await node.boundingBox();
  await drag(page, { x: box.x + box.width, y: box.y + box.height / 2 },
    { x: box.x + box.width - 24, y: box.y + box.height / 2 });
  await expect(saved).toHaveText('saved');
  const cropped = await imageRecord(page);
  const where = await nodePos(node);

  box = await node.boundingBox();
  await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2 - 12, y: box.y + box.height / 2 });
  await expect(saved).toHaveText('saved');

  const panned = await imageRecord(page);
  expect(panned.crop.x).toBeGreaterThan(cropped.crop.x);   // looking further right
  expect(panned.crop.w).toBeCloseTo(cropped.crop.w, 3);    // same amount of picture
  const stillThere = await nodePos(node);
  expect([stillThere.x, stillThere.y, stillThere.w]).toEqual([where.x, where.y, where.w]);
});

// A crop rect is free by default, so the modifier CONSTRAINS it (the opposite of
// its job on an ordinary resize, where the proportions are already held). It
// locks to whatever makes the current mask regular — here, a true circle.
test('a modifier held while cropping keeps a circle round', { tag: '@cards' }, async ({ page }) => {
  await page.mouse.move(300, 280);
  await pasteImage(page);                          // a 60×40 source: not square
  const node = page.locator('.node.image-node');
  const saved = page.locator('#saveState');
  await expect(node).toHaveCount(1);
  await expect(saved).toHaveText('saved');
  await node.click({ button: 'right' });
  await page.locator('#context-menu .ctx-shape[data-shape="circle"]').click();
  await expect(saved).toHaveText('saved');

  await node.dblclick();
  let box = await node.boundingBox();
  await page.keyboard.down('Shift');
  // A SHORT pull, deliberately: holding the lock on a 60×40 window snaps it to
  // the biggest circle that fits (40×40) before the drag is worth anything, so a
  // drag measured from the free 60 has to cover 20px before it moves a pixel.
  // 10px used to land on exactly the same box as 10px the other way.
  await drag(page, { x: box.x + box.width, y: box.y + box.height },
    { x: box.x + box.width - 10, y: box.y + box.height });   // pull x only
  await page.keyboard.up('Shift');
  await expect(saved).toHaveText('saved');

  let rec = await imageRecord(page);
  expect(rec.w).toBeCloseTo(30, 0);                // 40 snapped-to-round, less the 10
  expect(rec.h).toBe(rec.w);                       // square box ⇒ the circle is round
  // and it is a crop, not a scale: the window shrank into the same picture
  expect(rec.crop.w).toBeCloseTo(30 / 60, 2);
  expect(rec.crop.h).toBeCloseTo(30 / 40, 2);

  // Dragging back out past the picture's edge must hold the ratio rather than
  // clamp one side flat — Ctrl stands in for Shift here, they're interchangeable.
  box = await node.boundingBox();
  await page.keyboard.down('Control');
  await drag(page, { x: box.x + box.width, y: box.y + box.height },
    { x: box.x + box.width + 400, y: box.y + box.height + 400 });
  await page.keyboard.up('Control');
  await expect(saved).toHaveText('saved');
  rec = await imageRecord(page);
  expect(rec.h).toBe(rec.w);                       // still square at the boundary
  expect(rec.h).toBeLessThanOrEqual(40);           // and still inside the picture
});

// Holding the modifier must never make a handle DEAD that works without it.
// It could: the ratio is driven by whichever axis the pointer moved most, and if
// that axis is flush against the picture the uniform scale-back that keeps the
// ratio lands on exactly the starting size — so the drag did nothing, and the
// other axis's movement went with it. That killed the four mixed diagonals
// (push one edge out, pull the other in) on any square crop, and only with the
// modifier down, which is a maddening thing to report and an easy one to
// reintroduce. Needs a SQUARE source: with a 60×40 box a ratio-1 lock has to
// resize anyway on the first move, which hides it.
test('a blocked axis does not make the modifier eat the whole crop drag', { tag: '@cards' }, async ({ page }) => {
  await page.mouse.move(400, 300);
  await pasteImage(page, 120, 120);
  const node = page.locator('.node.image-node');
  const saved = page.locator('#saveState');
  await expect(node).toHaveCount(1);
  await expect(saved).toHaveText('saved');
  await node.click({ button: 'right' });
  await page.locator('#context-menu .ctx-shape[data-shape="circle"]').click();
  await expect(saved).toHaveText('saved');

  // Each of these pushes one edge OUT (blocked — the window already shows the
  // whole picture) while pulling the other IN, which has room. The in-half must
  // win rather than the pair cancelling.
  const MIXED = { nw: [-20, 20], ne: [20, 20], sw: [-20, -20], se: [20, -20] };
  for (const [dir, [dx, dy]] of Object.entries(MIXED)) {
    await page.locator('.node.image-node .image-bar .card-delete').click();   // start clean
    await expect(node).toHaveCount(0);
    await page.mouse.move(400, 300);
    await pasteImage(page, 120, 120);
    await expect(node).toHaveCount(1);
    await expect(saved).toHaveText('saved');
    await node.dblclick();
    await expect(node).toHaveClass(/cropping/);
    const before = await imageRecord(page);
    expect(before.w).toBe(before.h);                    // square, so the lock bites

    const hb = await node.locator(`.image-handle[data-dir="${dir}"]`).boundingBox();
    const from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
    await page.keyboard.down('Shift');
    await drag(page, from, { x: from.x + dx, y: from.y + dy });
    await page.keyboard.up('Shift');
    await expect(saved).toHaveText('saved');

    const after = await imageRecord(page);
    expect(after.w, `${dir} must not be a dead handle`).toBeLessThan(before.w);
    expect(after.h).toBe(after.w);                      // and still a true circle
    await page.keyboard.press('Escape');
  }
});

// The flip side: a push with nowhere to go stays put, and stays put the SAME way
// with the modifier as without it. That bound is the crop model — the window can
// never show more than the picture — so it must not quietly become a resize.
test('pushing a crop handle past the picture is bounded, modifier or not', { tag: '@cards' }, async ({ page }) => {
  for (const mod of [false, true]) {
    await page.mouse.move(400, 300);
    await pasteImage(page, 120, 120);
    const node = page.locator('.node.image-node');
    const saved = page.locator('#saveState');
    await expect(node).toHaveCount(1);
    await expect(saved).toHaveText('saved');
    await node.dblclick();
    await expect(node).toHaveClass(/cropping/);
    const before = await imageRecord(page);

    // SE outward on both axes: nothing left to reveal in either direction
    const hb = await node.locator('.image-handle[data-dir="se"]').boundingBox();
    const from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
    if (mod) await page.keyboard.down('Shift');
    await drag(page, from, { x: from.x + 40, y: from.y + 40 });
    if (mod) await page.keyboard.up('Shift');
    await expect(saved).toHaveText('saved');

    const after = await imageRecord(page);
    expect([after.w, after.h], `modifier=${mod}`).toEqual([before.w, before.h]);
    expect(after.crop).toBeUndefined();                 // still the whole picture
    await page.keyboard.press('Escape');
    await node.locator('.image-bar .card-delete').click();
    await expect(node).toHaveCount(0);
  }
});

// A locked drag can only ever land on sizes ON its ratio, so measuring the
// pointer from the free starting rect makes the whole walk to that ratio free —
// and invisible. Hold the square lock on a 240×120 crop window and the box has
// to become 120×120, so the first 120px of horizontal drag lands on 120×120
// whichever way it goes: that handle is numb for half the picture's width while
// the vertical one, already on ratio, tracks the pointer from the first pixel.
// One axis live and one dead is the report this came from, and it only shows on a
// window that isn't already on the locked ratio — which is most of them.
test('a locked crop drag answers both axes alike, from the first pixel', { tag: '@cards' }, async ({ page }) => {
  const node = page.locator('.node.image-node');
  const saved = page.locator('#saveState');
  const size = {};
  for (const [name, dx, dy] of [['x', -20, 0], ['y', 0, -20], ['out', 40, 40]]) {
    if (await node.count()) {
      await page.keyboard.press('Escape');
      await node.locator('.image-bar .card-delete').click();
      await expect(node).toHaveCount(0);
    }
    await page.mouse.move(500, 400);
    await pasteImage(page, 240, 120);                // landscape: NOT on the square lock
    await expect(node).toHaveCount(1);
    await expect(saved).toHaveText('saved');
    await node.dblclick();
    await expect(node).toHaveClass(/cropping/);
    expect(await imageRecord(page)).toMatchObject({ w: 240, h: 120 });

    const hb = await node.locator('.image-handle[data-dir="se"]').boundingBox();
    const from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
    await page.keyboard.down('Shift');
    await drag(page, from, { x: from.x + dx, y: from.y + dy });
    await page.keyboard.up('Shift');
    await expect(saved).toHaveText('saved');

    const rec = await imageRecord(page);
    expect(rec.h, name).toBe(rec.w);                 // square whichever edge was pulled
    size[name] = rec.w;
  }
  expect(size.x, 'the long edge must not be the numb one').toBe(size.y);
  expect(size.x).toBe(100);                          // the 120 square that fits, less the 20
  // Outward still stops at the picture, and stops on the BIGGEST square that
  // fits rather than something smaller — the other half of the same complaint.
  expect(size.out).toBe(120);
});

// "Regular" is not 1:1 for every shape: these polygons are percentages of the
// box, and an equilateral triangle is only √3/2 as tall as it is wide.
test('the crop modifier locks a triangle to equilateral, not to square', { tag: '@cards' }, async ({ page }) => {
  await page.mouse.move(320, 260);
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  const saved = page.locator('#saveState');
  await expect(node).toHaveCount(1);
  await expect(saved).toHaveText('saved');
  await node.click({ button: 'right' });
  await page.locator('#context-menu .ctx-shape[data-shape="triangle"]').click();
  await expect(saved).toHaveText('saved');

  await node.dblclick();
  const box = await node.boundingBox();
  await page.keyboard.down('Shift');
  await drag(page, { x: box.x + box.width, y: box.y + box.height },
    { x: box.x + box.width - 24, y: box.y + box.height });
  await page.keyboard.up('Shift');
  await expect(saved).toHaveText('saved');

  const rec = await imageRecord(page);
  expect(rec.w / rec.h).toBeCloseTo(2 / Math.sqrt(3), 1);
  expect(rec.w).not.toBe(rec.h);

  // …including at the very bottom of the range. The size floor is a MINIMUM per
  // axis, so applying it to each side on its own squares off exactly the ratio
  // being held: pull this to the limit and the triangle would come out isoceles.
  const box2 = await node.boundingBox();
  await page.keyboard.down('Shift');
  await drag(page, { x: box2.x + box2.width, y: box2.y + box2.height },
    { x: box2.x + box2.width - 400, y: box2.y + box2.height - 400 });
  await page.keyboard.up('Shift');
  await expect(saved).toHaveText('saved');
  const floored = await imageRecord(page);
  expect(floored.w / floored.h).toBeCloseTo(2 / Math.sqrt(3), 1);
  expect(Math.min(floored.w, floored.h)).toBe(24);   // and it did reach the floor
});

// The dimmed surround is the picture, so dragging it pans. It used to take no
// pointer events, which left an invisible hole exactly where you reach for MORE
// of the image: the press fell through to the canvas, which exited crop mode and
// started a box-select instead.
test('dragging the dimmed part of a crop pans it instead of dropping the mode', { tag: '@cards' }, async ({ page }) => {
  await page.mouse.move(360, 300);
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  const saved = page.locator('#saveState');
  await expect(node).toHaveCount(1);
  await expect(saved).toHaveText('saved');

  // shrink the window from the east, leaving dimmed picture to its right
  await node.dblclick();
  const box = await node.boundingBox();
  await drag(page, { x: box.x + box.width, y: box.y + box.height / 2 },
    { x: box.x + box.width - 26, y: box.y + box.height / 2 });
  await expect(saved).toHaveText('saved');
  const cropped = await imageRecord(page);
  const where = await nodePos(node);

  // press in the dimmed strip beyond the window's right edge and drag
  const win = await node.boundingBox();
  await drag(page, { x: win.x + win.width + 12, y: win.y + win.height / 2 },
    { x: win.x + win.width + 2, y: win.y + win.height / 2 });
  await expect(saved).toHaveText('saved');

  await expect(node).toHaveClass(/cropping/);                 // mode survived
  await expect(page.locator('#selection-box')).toBeHidden();  // no marquee started
  const panned = await imageRecord(page);
  expect(panned.crop.x).toBeGreaterThan(cropped.crop.x);      // it panned
  expect(panned.crop.w).toBeCloseTo(cropped.crop.w, 3);
  expect(await nodePos(node)).toEqual(where);                 // and never moved the node
});

// Every hook in a crop drag reads the mode per frame, so anything that dropped
// the mode mid-drag turned that same drag into a resize under the user's hand.
// A gesture owns the mode until it ends.
test('a crop drag stays a crop even if the mode is dropped mid-gesture', { tag: '@cards' }, async ({ page }) => {
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  const saved = page.locator('#saveState');
  await expect(node).toHaveCount(1);
  await expect(saved).toHaveText('saved');
  const before = await imageRecord(page);

  await node.dblclick();
  const box = await node.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, y, { steps: 4 });
  await page.keyboard.press('Escape');                        // would have ended the mode
  await page.mouse.move(box.x + box.width - 20, y, { steps: 4 });
  await page.mouse.up();
  await expect(saved).toHaveText('saved');

  const after = await imageRecord(page);
  expect(after.crop.w).toBeCloseTo((before.w - 20) / before.w, 2);   // cropped the whole way
  expect(after.w).toBeCloseTo(before.w - 20, 0);
  await page.keyboard.press('Escape');                        // and Escape works once it ends
  await expect(node).not.toHaveClass(/cropping/);
});

// Overshooting the picture must not drag the edge you AREN'T holding. Bounding
// the size against the whole picture instead of the room from the anchored edge
// let the box grow past that anchor and get shoved back inside, so the opposite
// edge travelled out with the cursor and walked home as it came back — which
// reads as the crop snapping to where it started, unfixable without releasing.
test('overshooting a crop keeps the anchored edge still and stays draggable', { tag: '@cards' }, async ({ page }) => {
  await page.mouse.move(340, 300);
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  const saved = page.locator('#saveState');
  await expect(node).toHaveCount(1);
  await expect(saved).toHaveText('saved');

  // grow it first, so there's room to crop from both sides and still clear the
  // minimum box size
  let box = await node.boundingBox();
  await drag(page, { x: box.x + box.width, y: box.y + box.height },
    { x: box.x + box.width + 180, y: box.y + box.height + 180 });
  await expect(saved).toHaveText('saved');

  // crop in from the west, then the east: the window now sits inside the picture
  await node.dblclick();
  box = await node.boundingBox();
  await drag(page, { x: box.x, y: box.y + box.height / 2 },
    { x: box.x + 60, y: box.y + box.height / 2 });
  box = await node.boundingBox();
  await drag(page, { x: box.x + box.width, y: box.y + box.height / 2 },
    { x: box.x + box.width - 40, y: box.y + box.height / 2 });
  await expect(saved).toHaveText('saved');
  const start = await nodePos(node);

  // One gesture: pull the east edge far past the picture, then come back inside.
  box = await node.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 400, y, { steps: 6 });
  const out = await nodePos(node);
  expect(out.x).toBe(start.x);                      // the west edge never asked to move
  expect(out.w).toBeGreaterThan(start.w);           // grew as far as the picture allows
  expect(out.w).toBeLessThan(start.w + 400);        // and no further

  await page.mouse.move(box.x + box.width - 30, y, { steps: 6 });
  const back = await nodePos(node);
  expect(back.x).toBe(start.x);                     // still anchored
  expect(back.w).toBeCloseTo(start.w - 30, 0);      // and tracking the cursor again
  await page.mouse.up();
  await expect(saved).toHaveText('saved');
  expect((await imageRecord(page)).w).toBeCloseTo(start.w - 30, 0);
});

// The same round trip for the two gestures the test above doesn't cover: a LOCKED
// handle, whose ratio baseline is re-derived from the live modifier state on every
// frame, and the pan, which moves the ghost instead of the box. Both saturate
// against a clamp while the pointer is away, so the question is whether coming
// back is lossless — every crop gesture recomputes absolutely from an origin
// pinned at the press, and nothing may re-base on a clamped value. Returning to
// the exact press point must restore the box exactly, or a detour costs the user
// an offset they can only clear by releasing and starting over.
test('a crop gesture that leaves the picture and comes back does not drift', { tag: '@cards' }, async ({ page }) => {
  const node = page.locator('.node.image-node');
  const saved = page.locator('#saveState');
  const ghostOff = () => node.locator('.crop-layer').evaluate((el) =>
    `${Math.round(parseFloat(el.style.left))},${Math.round(parseFloat(el.style.top))}`);

  for (const grab of ['handle', 'pan']) {
    if (await node.count()) {
      await page.keyboard.press('Escape');
      await node.locator('.image-bar .card-delete').click();
      await expect(node).toHaveCount(0);
    }
    await page.mouse.move(400, 300);
    await pasteImage(page, 240, 120);
    await expect(node).toHaveCount(1);
    await expect(saved).toHaveText('saved');
    await node.dblclick();
    await expect(node).toHaveClass(/cropping/);
    // Inset the window first: a full-extent one has nothing to pan and nothing to
    // grow into, so a no-op would pass this test without testing anything.
    for (const [dir, dx, dy] of [['nw', 20, 12], ['se', -20, -12]]) {
      const b = await node.locator(`.image-handle[data-dir="${dir}"]`).boundingBox();
      await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 },
        { x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 + dy });
    }
    await expect(saved).toHaveText('saved');

    let from;
    if (grab === 'handle') {
      const hb = await node.locator('.image-handle[data-dir="se"]').boundingBox();
      from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
      await page.keyboard.down('Shift');
    } else {
      const bb = await node.boundingBox();
      from = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    }
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 1, from.y + 1, { steps: 2 });   // let the lock bite
    await page.mouse.move(from.x, from.y, { steps: 2 });
    const start = [await nodePos(node), await ghostOff()];

    await page.mouse.move(from.x + 400, from.y + 400, { steps: 8 });
    const out = [await nodePos(node), await ghostOff()];
    expect(out, `${grab}: the detour has to actually move something`).not.toEqual(start);

    await page.mouse.move(from.x, from.y, { steps: 8 });
    expect(await nodePos(node), `${grab}: box drifted`).toEqual(start[0]);
    expect(await ghostOff(), `${grab}: picture drifted`).toEqual(start[1]);
    await page.mouse.up();
    if (grab === 'handle') await page.keyboard.up('Shift');
    await expect(saved).toHaveText('saved');
  }
});

// The shape is what you're framing, so it has to be visible while you frame it.
test('a shape mask stays visible while cropping', { tag: '@cards' }, async ({ page }) => {
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  await expect(node).toHaveCount(1);
  await expect(page.locator('#saveState')).toHaveText('saved');
  await node.click({ button: 'right' });
  await page.locator('#context-menu .ctx-shape[data-shape="circle"]').click();

  const clip = () => node.locator('.image-clip').evaluate((el) => getComputedStyle(el).clipPath);
  const masked = await clip();
  expect(masked).not.toBe('none');
  await node.dblclick();
  await expect(node).toHaveClass(/cropping/);
  expect(await clip()).toBe(masked);        // still the circle, mid-crop
});

// Enter puts a keyboard user into crop mode, so the arrows have to crop there —
// otherwise the only thing they could do in the mode is leave it. (And nudging
// the node would slide the box out from under the ghost the crop measures
// against, quietly corrupting the framing.)
test('keyboard: Enter crops an image and the arrows pan it', { tag: '@a11y' }, async ({ page }) => {
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  const saved = page.locator('#saveState');
  await expect(node).toHaveCount(1);
  await expect(saved).toHaveText('saved');

  // crop in from the east with the pointer, so there's room to pan into
  await node.dblclick();
  const box = await node.boundingBox();
  await drag(page, { x: box.x + box.width, y: box.y + box.height / 2 },
    { x: box.x + box.width - 24, y: box.y + box.height / 2 });
  await page.keyboard.press('Escape');
  await expect(saved).toHaveText('saved');
  const cropped = await imageRecord(page);
  const where = await nodePos(node);

  await page.keyboard.press('Enter');
  await expect(node).toHaveClass(/cropping/);
  await page.keyboard.press('ArrowRight');
  await expect(saved).toHaveText('saved');
  const panned = await imageRecord(page);
  expect(panned.crop.x).toBeGreaterThan(cropped.crop.x);      // looking further right
  expect(panned.crop.w).toBeCloseTo(cropped.crop.w, 3);
  expect(await nodePos(node)).toEqual(where);                 // the node itself never moved

  await page.keyboard.press('Enter');                         // reads as "apply"
  await expect(node).not.toHaveClass(/cropping/);
});

// Resizing a cropped image scales the framing rather than re-cropping it, and
// Reset crop takes the field back out rather than storing a full-image default.
test('a cropped image scales its framing, and the crop can be reset', { tag: '@cards' }, async ({ page }) => {
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  const saved = page.locator('#saveState');
  await expect(node).toHaveCount(1);
  await expect(saved).toHaveText('saved');

  await node.dblclick();
  let box = await node.boundingBox();
  await drag(page, { x: box.x + box.width, y: box.y + box.height },
    { x: box.x + box.width - 18, y: box.y + box.height - 12 });
  await page.keyboard.press('Escape');
  await expect(saved).toHaveText('saved');
  const cropped = await imageRecord(page);
  expect(cropped.crop.w).toBeLessThan(1);

  // out of crop mode, a corner drag is an ordinary proportional resize
  box = await node.boundingBox();
  await drag(page, { x: box.x + box.width, y: box.y + box.height },
    { x: box.x + box.width + 80, y: box.y + box.height + 80 });
  await expect(saved).toHaveText('saved');
  const scaled = await imageRecord(page);
  expect(scaled.w).toBeGreaterThan(cropped.w + 40);
  expect(scaled.crop).toEqual(cropped.crop);          // scaled the framing, not re-cropped

  await node.click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Reset crop' }).click();
  await expect(saved).toHaveText('saved');
  const reset = await imageRecord(page);
  expect('crop' in reset).toBe(false);
  expect(reset.asset).toBe(scaled.asset);
});

// An image node is a card underneath, so everything cards get for free has to
// actually work on it: connections, undo, and a reload.
test('an image node connects, undoes and reloads like any card', { tag: '@connections' }, async ({ page }) => {
  await page.mouse.move(300, 260);
  await pasteImage(page);
  const node = page.locator('.node.image-node');
  await expect(node).toHaveCount(1);
  const card = await addCardAt(page, 700, 300);

  const box = await node.boundingBox();
  const target = await card.boundingBox();
  await node.hover();
  await drag(page, { x: box.x + box.width, y: box.y + box.height / 2 },
    { x: target.x + target.width / 2, y: target.y + target.height / 2 });
  await expect(page.locator('#connections .conn')).toHaveCount(1);

  await page.keyboard.press('Control+z');
  await expect(page.locator('#connections .conn')).toHaveCount(0);
  await expect(node).toHaveCount(1);               // the image survives its arrow's undo

  await page.reload();
  await expect(page.locator('.node.image-node')).toHaveCount(1);
});

// A table pasted from GitHub/docs keeps its structure: the sanitizer lets
// table tags (and cell spans) through, and it survives an edit + save cycle
// instead of collapsing into a run of text.
test('pasted table structure survives sanitization and edits', { tag: '@cards' }, async ({ page }) => {
  // seed via the legacy key before boot — mutating the live board key races
  // with the app's unload flush, which rewrites the board from memory
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('whiteboard', JSON.stringify({
      schema: 1, version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      connections: {},
      cards: { c_t: { x: 120, y: 120, title: 'tabled', body:
        '<table onclick="x()"><thead><tr><th>Col A</th><th style="color:red" colspan="2">Col B</th></tr></thead>' +
        '<tbody><tr><td>1</td><td rowspan="junk">2</td><td>3</td></tr></tbody></table>' } },
    }));
  });
  await page.reload();

  const body = page.locator('.node.card .card-body');
  await expect(body.locator('table')).toHaveCount(1);
  await expect(body.locator('th')).toHaveCount(2);
  await expect(body.locator('td')).toHaveCount(3);
  await expect(body.locator('th[colspan="2"]')).toHaveCount(1);
  // event handlers, inline styles, and malformed spans are all stripped
  expect(await body.innerHTML()).not.toMatch(/onclick|style=|rowspan/);

  // editing the card (which re-saves through the sanitizer) keeps the table
  await body.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await page.keyboard.press('Escape');
  await expect(page.locator('#saveState')).toHaveText('saved');
  await page.reload();
  await expect(page.locator('.node.card .card-body table')).toHaveCount(1);
  await expect(page.locator('.node.card .card-body th[colspan="2"]')).toHaveCount(1);
});

// SECURITY: board content is untrusted (a shared Drive board or imported JSON
// is authored by someone else). An <iframe src="javascript:…"> executes in
// THIS page's origin (the frame has no sandbox), which would be stored XSS
// with access to every board and the Drive token. Such a src must never reach
// the element — the frame loads blank instead.
test('security: a javascript: iframe src from stored content never loads', { tag: '@frames' }, async ({ page }) => {
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
test('security: a button with a javascript: URL action does not navigate', { tag: '@buttons' }, async ({ page }) => {
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
test('a button linked to a board item flies the viewport there on click', { tag: ['@buttons', '@nav'] }, async ({ page }) => {
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
  await expect(btn).toHaveText('Target Dossier');   // adopted its target's name
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
test('a button linked to a URL opens it in a new tab on click', { tag: '@buttons' }, async ({ page }) => {
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

// The "Copy ID" button yields a full deep link (https://…/#node=<id>). Pasted
// back into the app as a link, it names a board item — following it must fly
// there in place, never open the whole app in a second tab.
test('a pasted Copy-ID deep link in a card body navigates in place', { tag: '@nav' }, async ({ page }) => {
  const card = await addCardAt(page, 450, 350);
  const id = await card.getAttribute('data-id');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);

  // seed the stored board with a far-away target and rewrite the first card's
  // body to hold the deep link as a plain pasted <a href> (init script: the
  // app re-saves on pagehide, which would clobber a direct pre-reload write)
  await page.addInitScript((id) => {
    const cur = localStorage.getItem('whiteboard:current');
    if (!cur) return;
    const key = 'whiteboard:board:' + cur;
    const b = JSON.parse(localStorage.getItem(key) || 'null');
    if (!b || !b.cards[id] || b.cards.deep_target) return;
    b.cards.deep_target = { x: 6000, y: 6000, title: 'Deep target', body: '' };
    b.cards[id].body = '<a href="' + location.origin + '/#node=deep_target">jump</a>';
    b.version++;
    localStorage.setItem(key, JSON.stringify(b));
  }, id);
  await page.reload();
  await page.evaluate(() => { window.open = (u) => { window.__opened = u; return null; }; });

  await page.locator(`.node.card[data-id="${id}"] .card-body a`).click();
  const vp = page.viewportSize();
  const target = page.locator('.node.card[data-id="deep_target"]');
  await expect(target).toHaveClass(/selected/);
  expect(within(await target.boundingBox(), vp.width, vp.height)).toBe(true);
  expect(await page.evaluate(() => window.__opened)).toBeUndefined();   // no new tab
});

// Same link pasted into a button's link modal: it is URL-shaped, but it must
// resolve to the board item — Enter links the node, and the button flies.
test('pasting a Copy-ID deep link into the button modal links the board item', { tag: ['@buttons', '@nav'] }, async ({ page }) => {
  const card = await addCardAt(page, 450, 350);
  const id = await card.getAttribute('data-id');
  await page.evaluate(() => { window.open = (u) => { window.__opened = u; return null; }; });

  // wander away so the fly-to is observable
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 8; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaX: 500, deltaY: 500, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => within(await card.boundingBox(), page.viewportSize().width, page.viewportSize().height)).toBe(false);

  await page.click('#addButton');
  const modal = page.locator('#button-link-modal');
  await expect(modal).toBeVisible();
  await page.fill('#bl-input', new URL('#node=' + id, page.url()).href);
  await expect(modal.locator('.np-item')).toHaveCount(1);   // found by the id inside the link
  await page.keyboard.press('Enter');                       // node wins over "Link to URL"
  await expect(modal).toBeHidden();

  await page.locator('.btn-node').click();
  const vp = page.viewportSize();
  expect(within(await card.boundingBox(), vp.width, vp.height)).toBe(true);
  await expect(card).toHaveClass(/selected/);
  expect(await page.evaluate(() => window.__opened)).toBeUndefined();   // no new tab
});

// Frames: a named region of the board, linkable like any node, sitting behind
// content with a click-through interior.
test('a frame is a named, linkable region whose interior stays click-through', { tag: '@frames' }, async ({ page }) => {
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
test('the move-items-with-frame toggle carries contents only while enabled', { tag: '@frames' }, async ({ page }) => {
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

// Box-select vs frames: a marquee that swallows a frame whole selects it with
// everything else, but one that merely crosses it leaves it alone — otherwise
// any sweep across the board would constantly grab room-sized regions.
test('box-select takes a frame only when the box fully encloses it', { tag: ['@select', '@frames'] }, async ({ page }) => {
  await page.click('#addFrameNode');
  await page.keyboard.press('Escape');                     // keep default name
  const frame = page.locator('.frame-node');
  const card = await addCardAt(page, 640, 360);            // inside the frame
  await page.mouse.click(60, 640);                         // deselect
  await expect(page.locator('.node.selected')).toHaveCount(0);
  const fb = await frame.boundingBox();

  // cut through the frame: the card inside is taken, the frame is not
  await drag(page, { x: fb.x - 30, y: fb.y - 30 },
                   { x: fb.x + fb.width / 2 + 40, y: fb.y + fb.height + 30 });
  await expect(card).toHaveClass(/selected/);
  await expect(frame).not.toHaveClass(/selected/);

  // swallow it whole: the frame joins the selection like any other node
  await page.mouse.click(60, 640);
  await drag(page, { x: fb.x - 30, y: fb.y - 30 },
                   { x: fb.x + fb.width + 30, y: fb.y + fb.height + 30 });
  await expect(frame).toHaveClass(/selected/);
  await expect(card).toHaveClass(/selected/);
});

// Right-click → "Use as default view": Reset then frames that frame instead
// of snapping to the origin; toggling it off restores the origin behavior.
test('a frame set as default view becomes the Reset target', { tag: ['@frames', '@nav'] }, async ({ page }) => {
  await page.click('#addFrameNode');
  await page.keyboard.press('Escape');                     // keep default name
  const frame = page.locator('.frame-node');
  const tab = frame.locator('.frame-tab');

  await tab.click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Use as default view' }).click();

  // wander far away, then Reset: the frame comes back, roughly filling the view
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    v.dispatchEvent(new WheelEvent('wheel', { deltaX: -2400, deltaY: -1800, bubbles: true, cancelable: true }));
  });
  await page.click('#resetView');
  const box = await frame.boundingBox();
  const vp = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  expect(box.width).toBeGreaterThan(400);                  // framed, not merely visible

  // toggle it off (the item now shows a checkmark); Reset returns to the origin
  await page.click('#fitContent');                         // bring the tab back under the cursor's reach
  await tab.click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: '✓ Use as default view' }).click();
  await page.click('#resetView');
  const t = await page.evaluate(() => document.getElementById('world').style.transform);
  expect(t).toContain('translate(0px, 0px)');
});

// Frames resize from any edge or corner; a west/north drag keeps the opposite
// edge pinned, so contents never shift in world space.
test('a frame resizes from its west edge and NW corner with the far edge pinned', { tag: '@frames' }, async ({ page }) => {
  await page.click('#addFrameNode');
  await page.keyboard.press('Escape');                     // keep default name
  const frame = page.locator('.frame-node');
  const b0 = await frame.boundingBox();

  // west edge: drag left 100 → wider by 100, right edge unmoved
  await drag(page, { x: b0.x, y: b0.y + b0.height / 2 },
                   { x: b0.x - 100, y: b0.y + b0.height / 2 });
  const b1 = await frame.boundingBox();
  expect(Math.round(b1.width - b0.width)).toBe(100);
  expect(Math.round((b1.x + b1.width) - (b0.x + b0.width))).toBe(0);

  // NW corner: drag up-left → both dimensions grow, SE corner unmoved
  await drag(page, { x: b1.x - 2, y: b1.y - 2 }, { x: b1.x - 62, y: b1.y - 42 });
  const b2 = await frame.boundingBox();
  expect(Math.round(b2.width - b1.width)).toBe(60);
  expect(Math.round(b2.height - b1.height)).toBe(40);
  expect(Math.round((b2.x + b2.width) - (b1.x + b1.width))).toBe(0);
  expect(Math.round((b2.y + b2.height) - (b1.y + b1.height))).toBe(0);
});

// Right-click → "Move to top" raises overlapped items, and the stacking
// persists (z is stored on the record, not just DOM order).
test('move to top raises an overlapped card and survives a reload', { tag: '@cards' }, async ({ page }) => {
  const a = await addCardAt(page, 480, 320);
  const idA = await a.getAttribute('data-id');
  const b = await addCardAt(page, 540, 360);               // overlaps a; newer = on top
  const idB = await b.getAttribute('data-id');
  const topAt = (x, y) => page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    const n = el && el.closest('.node');
    return n ? n.dataset.id : null;
  }, [x, y]);
  expect(await topAt(520, 350)).toBe(idB);                 // sanity: b covers the overlap

  await page.locator(`.node[data-id="${idA}"] .card-header`).click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Move to top' }).click();
  expect(await topAt(520, 350)).toBe(idA);

  await expect(page.locator('#saveState')).toHaveText('saved');
  await page.reload();
  await expect(page.locator('.node.card')).toHaveCount(2);
  expect(await topAt(520, 350)).toBe(idA);                 // z came back from storage
});

// "Move to top" raises the whole assembly — a card and its docked buttons
// must come forward together, not leave the buttons sandwiched underneath.
test('move to top raises a card together with its docked buttons', { tag: ['@cards', '@buttons'] }, async ({ page }) => {
  const card = await addCardAt(page, 480, 280);
  const idA = await card.getAttribute('data-id');
  const cb = await card.boundingBox();
  const btn = await addFreeButton(page);
  const bb0 = await btn.boundingBox();
  await drag(page, { x: bb0.x + bb0.width / 2, y: bb0.y + bb0.height / 2 },
                   { x: cb.x + cb.width / 2, y: cb.y + cb.height + 10 });
  await expect(btn).toHaveClass(/attached-bottom/);
  const btnId = await btn.getAttribute('data-id');

  // a second card overlapping the button tray, created later = naturally on top
  const cover = await addCardAt(page, 560, 380);
  const coverId = await cover.getAttribute('data-id');
  const bb = await btn.boundingBox();
  const probe = [bb.x + bb.width / 2, bb.y + bb.height / 2];
  const topAt = () => page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    const n = el && el.closest('.node');
    return n ? n.dataset.id : null;
  }, probe);
  expect(await topAt()).toBe(coverId);              // sanity: tray is covered

  await page.locator(`.node[data-id="${idA}"] .card-header`).click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Move to top' }).click();
  expect(await topAt()).toBe(btnId);                // the button rose WITH its card
});

// Nudging a partly off-screen card must not yank the viewport through a full
// rescue jump — the view follows at nudge speed instead.
test('arrow-key nudge of a partly off-screen card pans gently, never jumps', { tag: '@canvas' }, async ({ page }) => {
  const card = await addCardAt(page, 200, 400);
  // push the card halfway off the left edge by panning the view right
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 3; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaX: 110, deltaY: 0, clientX: 640, clientY: 360, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await card.boundingBox()).x).toBeLessThan(0);
  const vx = () => page.evaluate(() => {
    const m = document.getElementById('world').style.transform.match(/translate\(([-\d.]+)px/);
    return parseFloat(m[1]);
  });
  const x0 = await vx();
  await page.keyboard.press('ArrowDown');           // nudge 10px — not even toward the off edge
  const x1 = await vx();
  expect(Math.abs(x1 - x0)).toBeLessThanOrEqual(11); // follows by ≤ the nudge step, no rescue jump
});

// A long title pasted into a narrower card must wrap inside the card while
// editing — not spill past its right edge.
test('editing a long title wraps inside the card instead of overflowing', { tag: '@cards' }, async ({ page }) => {
  const card = await addCardAt(page, 500, 300);
  await card.locator('.card-title').dblclick();
  await page.keyboard.type('An extremely long investigation title that would never fit in one card width');
  const cb = await card.boundingBox();
  const tb = await card.locator('.card-title').boundingBox();
  expect(tb.x + tb.width).toBeLessThanOrEqual(cb.x + cb.width + 1);
  await page.keyboard.press('Enter');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
});

// Triple-click line selection drags a trailing newline along; pasting a
// single line into a card body must insert just the line.
test('pasting a single line with a trailing newline inserts no stray break', { tag: '@cards' }, async ({ page }) => {
  const card = await addCardAt(page, 500, 300);
  await card.locator('.card-body').click();
  await page.keyboard.type('start');
  await page.evaluate(() => {
    const body = document.querySelector('.card-body');
    const dt = new DataTransfer();
    dt.setData('text/plain', 'pasted line\n');
    body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  const html = await card.locator('.card-body').evaluate((el) => el.innerHTML);
  expect(html).toContain('startpasted line');       // inline, no <br>/<div> break
});

// ── Docked buttons: drop a button on a card's bottom edge (or beside a frame
//    title) and it becomes part of the assembly — follows drags, survives
//    reloads, frees itself via right-click → Detach. ──
async function addFreeButton(page) {
  const before = await page.locator('.btn-node').count();
  await page.click('#addButton');
  await expect(page.locator('#button-link-modal')).toBeVisible();
  await page.keyboard.press('Escape');       // a link isn't needed to dock
  await expect(page.locator('.btn-node')).toHaveCount(before + 1);
  const id = await page.locator('.btn-node').last().getAttribute('data-id');
  return page.locator(`.btn-node[data-id="${id}"]`);
}
// Drop a fresh button into a card's bottom tray.
async function dockButtonTo(page, card) {
  const cb = await card.boundingBox();
  const btn = await addFreeButton(page);
  const b0 = await btn.boundingBox();
  await drag(page, { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 },
                   { x: cb.x + cb.width / 2, y: cb.y + cb.height + 10 });
  await expect(btn).toHaveClass(/attached-bottom/);
  return btn;
}
// Regression: a node drag re-lays only its own dragged assemblies (scoped
// layoutAttachmentsFor) instead of the whole board every frame. The check has
// to read the docked button WHILE THE POINTER IS STILL DOWN — on drop, the
// commit's full layoutAttachments re-lays everything and would paper over a
// broken scoped path, so an after-release assertion (as the "rides its drags"
// test does) can't catch a regression here.
test('a docked button tracks its card mid-drag, before the pointer is released', { tag: '@buttons' }, async ({ page }) => {
  const card = await addCardAt(page, 500, 280);
  const btn = await addFreeButton(page);
  const cb = await card.boundingBox();
  const b0 = await btn.boundingBox();
  await drag(page, { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 },
                   { x: cb.x + cb.width / 2, y: cb.y + cb.height + 10 });
  await expect(btn).toHaveClass(/attached-bottom/);

  const bBefore = await btn.boundingBox();
  const cBefore = await card.boundingBox();
  const hb = await card.locator('.card-header').boundingBox();
  // manual held drag: down, move, ASSERT while held, then release
  await page.mouse.move(hb.x + 24, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 24 + 90, hb.y + hb.height / 2 + 70, { steps: 8 });
  // the button must track the card's OWN live delta (compared to the card,
  // not a fixed number — a full-width tray's box tracks a few px off the
  // card's, which is unrelated to whether the scoped re-layout ran). If the
  // scoped path did nothing, the button would sit still (~0) while the card
  // moved its full ~90/70, and this would fail.
  await expect.poll(async () => {
    const bNow = await btn.boundingBox();
    const cNow = await card.boundingBox();
    return Math.abs((bNow.x - bBefore.x) - (cNow.x - cBefore.x)) < 6
        && Math.abs((bNow.y - bBefore.y) - (cNow.y - cBefore.y)) < 6;
  }).toBe(true);
  const cNow = await card.boundingBox();
  expect(cNow.x - cBefore.x).toBeGreaterThan(60);       // sanity: the card really moved
  await page.mouse.up();
});

// A card and its docked buttons get .selected/.co-selected in the same
// synchronous call, so the only thing that can desync the highlight is HOW the
// two shadows interpolate. Both sides must carry a ring layer of identical
// geometry at rest, so the transition is a pure alpha fade on each — mid-flight
// they then read the same value at the same instant. This used to fail: the card
// grew its ring layer from nothing, so the browser morphed the depth shadow into
// it over ~130ms while the chip's crisp ring faded up independently.
test('a card and its docked button light up in step', { tag: ['@buttons', '@cards'] }, async ({ page }) => {
  const card = await addCardAt(page, 480, 280);
  const btn = await dockButtonTo(page, card);
  const btnId = await btn.getAttribute('data-id');
  const cardId = await card.getAttribute('data-id');
  // reload so no :active/hover left over from the docking drag skews the read
  await expect(page.locator('#saveState')).toHaveText('saved');
  await page.reload();
  const node = page.locator(`.node[data-id="${cardId}"]`);
  const chip = page.locator(`.node[data-id="${btnId}"]`);
  await expect(chip).toHaveClass(/attached-bottom/);

  // the ring layer is box-shadow's FIRST layer on both, and at rest it is a
  // fully transparent 1px slot rather than absent
  const ring = (s) => s.match(/^rgba?\([^)]*\)(?:\s+-?[\d.]+px){3,4}/)[0];
  const rings = () => page.evaluate(([c, b]) => [
    getComputedStyle(document.querySelector(`.node[data-id="${c}"]`)).boxShadow,
    getComputedStyle(document.querySelector(`.node[data-id="${b}"]`)).boxShadow,
  ], [cardId, btnId]);
  const [c0, b0] = await rings();
  expect(ring(c0)).toBe('rgba(0, 0, 0, 0) 0px 0px 0px 1px');
  expect(ring(b0)).toBe(ring(c0));

  // …and mid-transition they hold the same value. Both reads happen in one task,
  // so they see one frame of the timeline: equal iff the two interpolate alike.
  const mid = await node.evaluate((el, b) => {
    const chipEl = document.querySelector(`.node[data-id="${b}"]`);
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    return new Promise((res) => setTimeout(() => res([
      getComputedStyle(el).boxShadow, getComputedStyle(chipEl).boxShadow,
    ]), 50));
  }, btnId);
  expect(ring(mid[0])).toBe(ring(mid[1]));
  expect(ring(mid[0])).not.toBe(ring(c0));         // sanity: it really is mid-fade

  await expect(node).toHaveClass(/selected/);
  await expect(chip).toHaveClass(/co-selected/);
  // and they land on the same ring. Polled, not snapshotted: the class arrives
  // 120ms before the fade finishes, so a one-shot read catches it mid-flight.
  await expect.poll(async () => ring((await rings())[0]))
    .toBe('rgb(255, 198, 41) 0px 0px 0px 1px');
  const [c1, b1] = await rings();
  expect(ring(b1)).toBe(ring(c1));
});

// Colouring an assembly colours all of it. A grey tray under a red card reads as
// a half-finished edit — and unlike the selection cascade this writes each
// button's own colour field, so it survives a reload and a later detach.
test('colouring a card colours its docked buttons', { tag: ['@buttons', '@cards'] }, async ({ page }) => {
  const card = await addCardAt(page, 480, 280);
  const btn = await dockButtonTo(page, card);
  const btnId = await btn.getAttribute('data-id');

  await card.locator('.card-header').click({ button: 'right' });
  await page.locator('#context-menu .ctx-swatch').nth(1).click();   // first real colour
  await expect(card).toHaveClass(/colored/);
  await expect(btn).toHaveClass(/colored/);

  await expect(page.locator('#saveState')).toHaveText('saved');
  const stored = await page.evaluate((id) => {
    const b = JSON.parse(localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current')));
    return b.cards[id].color;
  }, btnId);
  expect(stored).toBeTruthy();                      // its own field, not just a class

  await page.reload();
  await expect(page.locator(`.node[data-id="${btnId}"]`)).toHaveClass(/colored/);
});

// The dock snap preview has to win over every resting state. It was a
// border-colour tint, which .colored (later in the stylesheet) and
// .colored.selected (one class more specific) both outranked — so the preview
// silently disappeared on exactly the coloured items it was needed on.
test('the dock snap preview shows on a coloured card too', { tag: '@buttons' }, async ({ page }) => {
  const card = await addCardAt(page, 480, 280);
  await card.locator('.card-header').click({ button: 'right' });
  await page.locator('#context-menu .ctx-swatch').nth(1).click();
  await expect(card).toHaveClass(/colored/);
  await expect(card).toHaveClass(/selected/);        // colouring leaves it selected — the worst case

  const btn = await addFreeButton(page);
  const cb = await card.boundingBox();
  const b0 = await btn.boundingBox();
  // hold the drag over the tray zone and read the preview while the pointer is down
  await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height + 10, { steps: 8 });
  await expect(card).toHaveClass(/snap-target/);
  const outline = await card.evaluate((el) => getComputedStyle(el).outline);
  await page.mouse.up();
  expect(outline).toMatch(/rgb\(255, 198, 41\)/);    // accent, not the card's own colour
  expect(outline).toMatch(/2px/);
});

// Regression: skipping the port-proximity read while a node is being dragged
// must still CLEAR any port lit while grabbing it — a stuck-lit port stays
// visible after the drop and (being a laid-out child) inflates the node's
// nodeVisualGeom bounds, which then throws off a later fit/fly-to on it.
test('a port lit while grabbing a card does not stay lit after the drag', { tag: '@connections' }, async ({ page }) => {
  const card = await addCardAt(page, 500, 320);
  const hb = await card.locator('.card-header').boundingBox();
  // grab the header near its left edge — close enough to light the left port
  // (within PORT_NEAR_PX) at the very spot the drag starts from
  const gx = hb.x + 24, gy = hb.y + hb.height / 2;
  await page.mouse.move(gx, gy);
  await expect(card.locator('.port.near')).toHaveCount(1);
  await page.mouse.down();
  await page.mouse.move(gx + 60, gy + 90, { steps: 6 });
  await page.mouse.up();
  await expect(card.locator('.port.near')).toHaveCount(0);   // not stuck on
});

// A button's name defines its width: a long label grows the pill instead of
// being clipped at an arbitrary cap — how wide a button gets is the user's call.
test('a long button name expands the button instead of truncating', { tag: '@buttons' }, async ({ page }) => {
  const btn = await addFreeButton(page);
  await btn.click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Rename' }).click();
  const name = 'Take me to the very long and extremely specific place on the board';
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(btn).toHaveText(name);
  // the full label is visible — nothing scrolled out of the clip
  expect(await btn.locator('.btn-node-label').evaluate(
    (el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect((await btn.boundingBox()).width).toBeGreaterThan(320);   // the old cap
});

test('a button docks to a card bottom, rides its drags, and detaches via right-click', { tag: '@buttons' }, async ({ page }) => {
  const card = await addCardAt(page, 500, 280);
  const btn = await addFreeButton(page);
  const cb = await card.boundingBox();
  const b0 = await btn.boundingBox();
  await drag(page, { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 },
                   { x: cb.x + cb.width / 2, y: cb.y + cb.height + 10 });
  await expect(btn).toHaveClass(/attached-bottom/);
  let bp = await nodePos(btn);
  const cp = await nodePos(card);
  expect(bp.x - cp.x).toBe(0);                                    // full-width tab tray
  expect(Math.abs(bp.w - cp.w)).toBeLessThanOrEqual(1);
  expect(bp.y - (cp.y + cp.h)).toBe(-1);                          // flush, sharing the border

  // dragging the card carries the docked button
  const hb = await card.locator('.card-header').boundingBox();
  await drag(page, { x: hb.x + 24, y: hb.y + hb.height / 2 },
                   { x: hb.x + 144, y: hb.y + hb.height / 2 + 60 });
  const bp2 = await nodePos(btn);
  expect(bp2.x - bp.x).toBe(120);
  expect(bp2.y - bp.y).toBe(60);

  // the dock persists (attachedTo lives on the button's record)
  await expect(page.locator('#saveState')).toHaveText('saved');
  await page.reload();
  await expect(page.locator('.btn-node')).toHaveClass(/attached-bottom/);

  // Detach frees it: corners restore and card drags no longer carry it
  await page.locator('.btn-node').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Detach' }).click();
  await expect(page.locator('.btn-node')).not.toHaveClass(/attached-bottom/);
  const free = await nodePos(page.locator('.btn-node'));
  const hb2 = await page.locator('.card-header').boundingBox();
  await drag(page, { x: hb2.x + 24, y: hb2.y + hb2.height / 2 },
                   { x: hb2.x + 24, y: hb2.y + hb2.height / 2 + 80 });
  const free2 = await nodePos(page.locator('.btn-node'));
  expect(free2.y - free.y).toBe(0);                               // stayed put
});

test('a button docks to the right of a frame title and moves with the frame', { tag: '@buttons' }, async ({ page }) => {
  await page.click('#addFrameNode');
  await page.keyboard.press('Escape');                            // keep default name
  const frame = page.locator('.frame-node');
  const tab = frame.locator('.frame-tab');
  const btn = await addFreeButton(page);
  const tb = await tab.boundingBox();
  const b0 = await btn.boundingBox();
  await drag(page, { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 },
                   { x: tb.x + tb.width + 20 + b0.width / 2, y: tb.y + tb.height / 2 });
  await expect(btn).toHaveClass(/attached-title/);
  await expect(frame).toHaveClass(/has-tab-buttons/);
  const bp = await nodePos(btn);

  // screen-rect alignment: flush right of the tab, same top, same height
  // (poll: the chip's :active scale transition needs a beat to settle)
  await expect.poll(() => page.evaluate(() => {
    const b = document.querySelector('.btn-node').getBoundingClientRect();
    const t = document.querySelector('.frame-tab').getBoundingClientRect();
    return Math.max(Math.abs(b.left - (t.right - 1)),
                    Math.abs(b.top - t.top),
                    Math.abs(b.height - t.height));
  })).toBeLessThan(1);

  // selecting the frame highlights its docked buttons along with it
  await tab.click();
  await expect(frame).toHaveClass(/selected/);
  await expect(btn).toHaveClass(/co-selected/);
  // addFreeButton's Escape (to skip linking) correctly restores real DOM
  // focus to #addButton (WCAG focus-restore) — clicking the frame tab is a
  // virtual-selection action and doesn't steal it back. The first Escape
  // here is spent stepping out of that lingering chrome focus; the second
  // clears the (virtual) selection, same two-step Escape as everywhere else.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(btn).not.toHaveClass(/co-selected/);

  // dragging the frame by its tab carries the docked button
  await drag(page, { x: tb.x + 20, y: tb.y + tb.height / 2 },
                   { x: tb.x + 20 + 100, y: tb.y + tb.height / 2 + 50 });
  const bp2 = await nodePos(btn);
  expect(bp2.x - bp.x).toBe(100);
  expect(bp2.y - bp.y).toBe(50);
});

// Regression: commit() skips layoutAttachments on a coalesced title/body edit
// when opts.affects proves none of its ids are a dock root — but a frame's
// docked button reads the tab's live width, which a title edit changes. If
// the skip check were a static "titles never affect docking" assumption
// instead of the dockRootButtons lookup, the button would drift out of sync
// with the tab while typing.
test('renaming a frame with a docked button keeps the button flush with the growing tab', { tag: '@buttons' }, async ({ page }) => {
  await page.click('#addFrameNode');
  await page.keyboard.press('Escape');
  const frame = page.locator('.frame-node');
  const tab = frame.locator('.frame-tab');
  const name = frame.locator('.frame-name');
  const btn = await addFreeButton(page);
  const tb0 = await tab.boundingBox();
  const b0 = await btn.boundingBox();
  await drag(page, { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 },
                   { x: tb0.x + tb0.width + 20 + b0.width / 2, y: tb0.y + tb0.height / 2 });
  await expect(frame).toHaveClass(/has-tab-buttons/);

  await name.dblclick();
  await page.keyboard.type('A Much Longer Frame Title');   // widens the tab per keystroke
  await expect.poll(() => page.evaluate(() => {
    const b = document.querySelector('.btn-node').getBoundingClientRect();
    const t = document.querySelector('.frame-tab').getBoundingClientRect();
    return Math.abs(b.left - (t.right - 1));
  })).toBeLessThan(1);
  const tb1 = await tab.boundingBox();
  expect(tb1.width).toBeGreaterThan(tb0.width);   // sanity: the tab actually grew
});

// Regression: at boot, layoutAttachments must run AFTER the world transform
// is applied — frame rows are measured from the tab's client rect through
// toWorld (the model viewport). With a saved pan, measuring under the default
// transform wrote the docked button to garbage coordinates, invisible until
// the next layout pass ("button missing until the frame is dragged").
test('a frame-docked button lays out correctly on load with a panned viewport', { tag: '@buttons' }, async ({ page }) => {
  await page.click('#addFrameNode');
  await page.keyboard.press('Escape');
  const tab = page.locator('.frame-node .frame-tab');
  const btn = await addFreeButton(page);
  const tb = await tab.boundingBox();
  const b0 = await btn.boundingBox();
  await drag(page, { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 },
                   { x: tb.x + tb.width + 20 + b0.width / 2, y: tb.y + tb.height / 2 });
  await expect(btn).toHaveClass(/attached-title/);

  // leave the viewport somewhere that is NOT the boot default…
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 3; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaX: -120, deltaY: -80, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => page.evaluate(() => {
    const k = Object.keys(localStorage).find((k) => k.startsWith('whiteboard:viewport:'));
    return k ? JSON.parse(localStorage.getItem(k)).x : 0;
  })).not.toBe(0);
  await expect(page.locator('#saveState')).toHaveText('saved');

  // …and reload: the button must sit flush on the tab with no interaction
  await page.reload();
  await expect(page.locator('.btn-node')).toHaveClass(/attached-title/);
  await expect.poll(() => page.evaluate(() => {
    const b = document.querySelector('.btn-node').getBoundingClientRect();
    const t = document.querySelector('.frame-tab').getBoundingClientRect();
    return Math.max(Math.abs(b.left - (t.right - 1)), Math.abs(b.top - t.top));
  })).toBeLessThan(1);
});

// Up to three buttons form a full-width tab tray under a card; a fourth
// won't dock. Chains: a button dropped on a free button's right edge forms
// a menu row that moves with its root; dropping on a DOCKED button appends
// to that button's row instead of nesting.
test('card trays cap at three tabs and buttons chain into menu rows', { tag: '@buttons' }, async ({ page }) => {
  const card = await addCardAt(page, 480, 240);
  const cb = await card.boundingBox();
  const dockToCard = async (btn) => {
    const b = await btn.boundingBox();
    await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 },
                     { x: cb.x + cb.width / 2, y: cb.y + cb.height + 10 });
  };
  const b1 = await addFreeButton(page);
  await dockToCard(b1);
  const b2 = await addFreeButton(page);
  await dockToCard(b2);
  const b3 = await addFreeButton(page);
  await dockToCard(b3);
  await expect(b3).toHaveClass(/attached-bottom/);
  const cp = await nodePos(card);
  const [p1, p2, p3] = [await nodePos(b1), await nodePos(b2), await nodePos(b3)];
  expect(Math.abs(p1.w - p2.w)).toBeLessThanOrEqual(1);           // equal tab segments
  // seams share ~1px borders (±1 from fractional-width rounding)
  expect(Math.abs(p2.x - (p1.x + p1.w - 1))).toBeLessThanOrEqual(1);
  expect(Math.abs(p3.x - (p2.x + p2.w - 1))).toBeLessThanOrEqual(1);
  expect(Math.abs((p3.x + p3.w) - (cp.x + cp.w))).toBeLessThanOrEqual(2);  // spans the card
  await expect(b1).toHaveClass(/attached-first/);
  await expect(b3).toHaveClass(/attached-last/);

  // the tray is full: a fourth button refuses to dock
  const b4 = await addFreeButton(page);
  await dockToCard(b4);
  await expect(b4).not.toHaveClass(/attached-bottom/);

  // chain b4 onto a free root button, then append a fifth via the docked one
  const root = await addFreeButton(page);
  let rb = await root.boundingBox();
  await drag(page, { x: rb.x + rb.width / 2, y: rb.y + rb.height / 2 },
                   { x: 260, y: 600 });
  rb = await root.boundingBox();
  const b4b = await b4.boundingBox();
  await drag(page, { x: b4b.x + b4b.width / 2, y: b4b.y + b4b.height / 2 },
                   { x: rb.x + rb.width + 12 + b4b.width / 2, y: rb.y + rb.height / 2 });
  await expect(b4).toHaveClass(/attached-chain/);
  await expect(root).toHaveClass(/has-chain/);
  const rp = await nodePos(root);
  const p4 = await nodePos(b4);
  expect(p4.x).toBe(rp.x + rp.w - 1);                             // flush right of the root
  expect(p4.y).toBe(rp.y);

  const b5 = await addFreeButton(page);
  const b5b = await b5.boundingBox();
  await drag(page, { x: b5b.x + b5b.width / 2, y: b5b.y + b5b.height / 2 },
                   { x: rb.x + rb.width + b4b.width + 12 + b5b.width / 2, y: rb.y + rb.height / 2 });
  await expect(b5).toHaveClass(/attached-chain/);                 // joined the same row
  await expect(b5).toHaveClass(/attached-last/);
  await expect(b4).not.toHaveClass(/attached-last/);

  // dragging the root moves the whole menu row
  const before4 = await nodePos(b4);
  rb = await root.boundingBox();
  await drag(page, { x: rb.x + rb.width / 2, y: rb.y + rb.height / 2 },
                   { x: rb.x + rb.width / 2 + 90, y: rb.y + rb.height / 2 - 40 });
  const after4 = await nodePos(b4);
  expect(after4.x - before4.x).toBe(90);
  expect(after4.y - before4.y).toBe(-40);
});

test('deleting a card orphans its docked button in place', { tag: '@buttons' }, async ({ page }) => {
  const card = await addCardAt(page, 500, 280);
  const btn = await addFreeButton(page);
  const cb = await card.boundingBox();
  const b0 = await btn.boundingBox();
  await drag(page, { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 },
                   { x: cb.x + cb.width / 2, y: cb.y + cb.height + 10 });
  await expect(btn).toHaveClass(/attached-bottom/);
  const docked = await nodePos(btn);

  await card.locator('.card-header').click({ button: 'right' });
  await page.locator('#context-menu .ctx-item', { hasText: 'Delete card' }).click();
  await expect(page.locator('.node.card')).toHaveCount(0);
  await expect(btn).toHaveCount(1);                               // orphaned, not deleted
  await expect(btn).not.toHaveClass(/attached-bottom/);
  const after = await nodePos(btn);
  expect(after.x).toBe(docked.x);                                 // stays where it was
  expect(after.y).toBe(docked.y);
});

// Empty-state guidance centered on a blank board (NN/g: orient the user).
test('a blank board shows a centered empty-state prompt that clears once a node exists', { tag: '@chrome' }, async ({ page }) => {
  await expect(page.locator('#empty-hint')).toBeVisible();
  await addCardAt(page, 300, 300);
  await expect(page.locator('#empty-hint')).toBeHidden();
});

// A long heading should widen the card (no clipped/ellipsised title), while a
// long body must NOT — the title alone drives width.
test('a long heading widens the card; a long body does not', { tag: '@cards' }, async ({ page }) => {
  const widthOf = (loc) => loc.evaluate((el) => el.getBoundingClientRect().width);
  // pin each new card by data-id (see makeCardAt / helpers.addCardAt) rather
  // than .last() — the card is returned in title-edit mode, ready to type
  const ids = () => page.evaluate(() => [...document.querySelectorAll('.node.card')].map((e) => e.dataset.id));
  const addCardPinned = async () => {
    const before = await ids();
    await page.click('#addCard');
    await expect(page.locator('.node.card')).toHaveCount(before.length + 1);
    const id = (await ids()).find((i) => !before.includes(i));
    return page.locator(`.node.card[data-id="${id}"]`);
  };

  // short title → default width
  const plain = await addCardPinned();
  await page.keyboard.press('Escape');
  expect(await widthOf(plain)).toBeLessThanOrEqual(245);

  // long title → grows past the default
  const wide = await addCardPinned();
  await page.keyboard.type('A really quite long heading that should not be cut off');
  await page.keyboard.press('Escape');
  const wideW = await widthOf(wide);
  expect(wideW).toBeGreaterThan(280);
  // title is fully visible — not clipped by ellipsis
  const title = wide.locator('.card-title');
  const clipped = await title.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(clipped).toBe(false);

  // short title + long body → stays at default (body never drives width)
  const card = await addCardPinned();
  await page.keyboard.press('Escape');
  await card.locator('.card-body').click();
  await page.keyboard.type('This is a long note with plenty of words that should simply wrap onto multiple lines instead of stretching the card wider and wider.');
  await page.keyboard.press('Escape');
  expect(await widthOf(card)).toBeLessThanOrEqual(245);
});

// Drive opt-in lives in the board menu and must not pull in Google's scripts
// (or touch the network) until the user actually clicks Connect.
test('Drive bar is present and loads no Google scripts until Connect', { tag: '@boards' }, async ({ page }) => {
  await page.click('#boardMenuBtn');
  await expect(page.locator('#drive-bar')).toBeVisible();
  await expect(page.locator('#driveConnectBtn')).toBeVisible();
  // nothing Google-hosted should have loaded just by booting + opening the menu
  expect(await page.locator('script[src*="google"]').count()).toBe(0);
});

// ── Silent reconnect for a returning opted-in user ──
// Google's token flow only suppresses its popup inside a real user gesture, so
// the reconnect rides the first discrete input. These boot the app as a user who
// has connected before but whose session token is gone, with Google's script
// replaced by a local stub that records what was asked of it — the route means
// no request leaves the machine, so the suite stays network-clean.
const GIS_URL = 'https://accounts.google.com/gsi/client';
const GIS_STUB = `
  window.__gis = { calls: [], grant: window.__gisGrant === true, refuse: window.__gisRefuse || null };
  window.google = { accounts: { oauth2: {
    initTokenClient(cfg) {
      return { requestAccessToken(opts) {
        // prompt:'' is our interactive ask; prompt:'none' is the silent one
        window.__gis.calls.push((opts && opts.prompt) === 'none' ? 'silent' : 'interactive');
        if (window.__order) window.__order.push('drive:token');   // ordering tests
        // Deferred mode: hold the answer until the test releases it, so a second
        // request can land while the first is still outstanding. Real GIS answers
        // a popup and is never instant, so an instant stub hides every race.
        if (window.__gis.defer) {
          window.__gis.settle = () => cfg.callback({ access_token: 'stub-token', expires_in: 3600 });
          return;
        }
        if (window.__gis.grant) cfg.callback({ access_token: 'stub-token', expires_in: 3600 });
        // A definitive answer arrives on the normal callback as resp.error; a
        // request that never got through arrives on error_callback as a type.
        else if (window.__gis.refuse) cfg.callback({ error: window.__gis.refuse });
        else cfg.error_callback({ type: 'popup_failed_to_open' });   // as a popup blocker looks
      } };
    },
    revoke() {},
  } } };
`;

// Boots as an opted-in-but-disconnected user and waits for the warmup to land.
// `grant` hands out a token; `refuse` returns a definitive OAuth error instead
// of the blocked-popup one, which is what stops the retry loop.
async function bootOptedIn(page, { grant = false, refuse = null } = {}) {
  await page.route(GIS_URL, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: GIS_STUB }));
  await page.addInitScript(([g, r]) => {
    window.__gisGrant = g;
    window.__gisRefuse = r;
    localStorage.setItem('whiteboard:drive:opted', '1');
  }, [grant, refuse]);
  await page.reload();
  // boot warms the script so the first gesture isn't racing a cold fetch
  await page.waitForFunction(() => !!window.__gis);
}
const gisCalls = (page) => page.evaluate(() => window.__gis.calls);

test('an opted-in user reconnects to Drive on the first click, without opening the board menu',
  { tag: '@boards' }, async ({ page }) => {
    await bootOptedIn(page, { grant: true });
    // warming the script must NOT ask for a token on its own — that's the bare
    // page-load request that the browser blocks
    expect(await gisCalls(page)).toEqual([]);
    await expect(page.locator('#driveReconnectBtn')).toBeVisible();

    await page.mouse.click(600, 400);                       // anywhere on the canvas
    await expect(page.locator('#driveReconnectBtn')).toBeHidden();
    expect(await gisCalls(page)).toEqual(['silent']);
    // and the board menu now reports it without a Connect button
    await page.click('#boardMenuBtn');
    await expect(page.locator('#drive-state')).toHaveText(/connected/i);
    await expect(page.locator('#driveConnectBtn')).toBeHidden();
  });

test('a bare modifier keypress does not spend the Drive reconnect attempt',
  { tag: ['@boards', '@a11y'] }, async ({ page }) => {
    await bootOptedIn(page, { grant: true });
    // Shift+Tab is a keyboard user's opening move; the Shift half grants no
    // activation, so consuming the hook there would strand them offline.
    await page.keyboard.down('Shift');
    expect(await gisCalls(page)).toEqual([]);
    await page.keyboard.up('Shift');

    await page.keyboard.press('Tab');                       // a real activation-granting press
    await expect(page.locator('#driveReconnectBtn')).toBeHidden();
    expect(await gisCalls(page)).toEqual(['silent']);
  });

test('a blocked silent reconnect retries on the next gesture instead of giving up',
  { tag: '@boards' }, async ({ page }) => {
    await bootOptedIn(page, { grant: false });
    await page.mouse.click(600, 400);
    // refused for a reason that says nothing about the user's session, so the
    // chip stays up and the hook stays armed
    expect(await gisCalls(page)).toEqual(['silent']);
    await expect(page.locator('#driveReconnectBtn')).toBeVisible();

    await page.evaluate(() => { window.__gis.grant = true; });
    await page.mouse.click(620, 420);
    expect(await gisCalls(page)).toEqual(['silent', 'silent']);
    await expect(page.locator('#driveReconnectBtn')).toBeHidden();
  });

test('a local-only user gets no Drive chip and no Google scripts',
  { tag: ['@boards', '@chrome'] }, async ({ page }) => {
    await expect(page.locator('#driveReconnectBtn')).toBeHidden();
    expect(await page.locator('script[src*="google"]').count()).toBe(0);
  });

// A browser allows ONE popup and ONE file chooser per user gesture, so whoever
// asks first wins. On capture-phase pointerdown this hook always got there before
// the thing the user actually clicked, and Google's token flow ate the allowance:
// the palette's Image button opened no file picker, a URL-linked button opened no
// tab, and nothing anywhere said why. Deferring the CLICK until Drive finishes
// can't fix it either — activation doesn't survive an await. So the reconnect
// goes last instead, and these pin the ordering rather than any list of controls.
//
// Records both sides into one array: the app's activation-hungry calls, and the
// GIS stub's token request (see GIS_STUB).
async function trackGestureOrder(page) {
  await page.addInitScript(() => {
    window.__order = [];
    window.open = (u) => { window.__order.push('app:open'); return null; };
    // Recorded, not called through — a real chooser would hang the run, and it's
    // reaching input.click() at all that proves the app got the gesture.
    HTMLInputElement.prototype.click = function () {
      if (this.type === 'file') window.__order.push('app:filepicker:' + this.id);
    };
  });
}
const gestureOrder = (page) => page.evaluate(() => window.__order);

test('the palette Image button gets the gesture before Drive does',
  { tag: ['@boards', '@chrome'] }, async ({ page }) => {
    await trackGestureOrder(page);
    await bootOptedIn(page, { grant: true });

    await page.click('#addImage');
    await expect.poll(() => gisCalls(page)).toEqual(['silent']);      // Drive still reconnects…
    expect(await gestureOrder(page))
      .toEqual(['app:filepicker:imageFile', 'drive:token']);          // …but only after the picker
    await expect(page.locator('#driveReconnectBtn')).toBeHidden();
  });

test('a URL button gets the gesture before Drive does',
  { tag: ['@boards', '@buttons'] }, async ({ page }) => {
    await trackGestureOrder(page);
    await page.click('#addButton');
    await expect(page.locator('#button-link-modal')).toBeVisible();
    await page.fill('#bl-input', 'https://example.com/thing');
    await page.click('#bl-use-url');
    await expect(page.locator('#button-link-modal')).toBeHidden();
    await expect(page.locator('#saveState')).toHaveText('saved');

    await bootOptedIn(page, { grant: true });
    await page.locator('.btn-node').click();
    await expect.poll(() => gisCalls(page)).toEqual(['silent']);
    expect(await gestureOrder(page)).toEqual(['app:open', 'drive:token']);
  });

// The chip is the fallback for when silent reconnect CAN'T work — a revoked
// consent, an expired Google session. Those refusals stop the retry loop, so the
// chip is the only way back, and one click has to be enough.
test('the Drive chip escalates to an interactive connect when the silent path is refused',
  { tag: ['@boards', '@chrome'] }, async ({ page }) => {
    await bootOptedIn(page, { refuse: 'consent_required' });
    await page.mouse.click(600, 400);
    expect(await gisCalls(page)).toEqual(['silent']);
    await expect(page.locator('#driveReconnectBtn')).toBeVisible();

    // a definitive refusal must NOT re-arm — otherwise every click re-asks
    await page.mouse.click(620, 420);
    expect(await gisCalls(page)).toEqual(['silent']);

    await page.evaluate(() => { window.__gis.grant = true; });
    await page.click('#driveReconnectBtn');
    await expect(page.locator('#driveReconnectBtn')).toBeHidden();
    expect(await gisCalls(page)).toEqual(['silent', 'interactive']);
  });

// The board menu's Connect button and the status-strip chip are ONE action
// reachable two ways, so what's true of one has to be true of the other. It
// wasn't: only the chip spent the first-gesture hook, so a click on Connect
// kicked off a silent reconnect alongside its own interactive request. A blocked
// popup re-arms that hook, which is precisely the state that sends a user to the
// button — so Connect read as dead and only the chip brought Drive back.
test('Connect in the board menu asks for one token, exactly like the reconnect chip',
  { tag: ['@boards', '@chrome'] }, async ({ page }) => {
    // grant:false is the blocked-popup refusal — it says nothing about the
    // session, so the hook re-arms and is live when the click below lands.
    await bootOptedIn(page, { grant: false });
    await page.click('#boardMenuBtn');
    expect(await gisCalls(page)).toEqual(['silent']);
    await expect(page.locator('#driveConnectBtn')).toBeVisible();

    // Deferred, and load-bearing: a microtask checkpoint runs between the
    // button's own handler and the window-level hook, so an INSTANT stub is
    // already connected by the time the hook looks — which is the one state
    // where the hook stands down, and it hides the whole bug. A real popup is
    // still open at that moment.
    await page.evaluate(() => { window.__gis.defer = true; });
    await page.click('#driveConnectBtn');
    // one gesture, one ask — nothing riding along behind this request
    await expect.poll(() => gisCalls(page)).toEqual(['silent', 'interactive']);

    await page.evaluate(() => window.__gis.settle());   // the user finishes the popup
    await expect(page.locator('#driveConnectBtn')).toBeHidden();
    await expect(page.locator('#drive-state')).toHaveText(/connected/i);
    await expect(page.locator('#driveReconnectBtn')).toBeHidden();
  });

// …and the primitive underneath, because the app is not the only thing that can
// overlap two connects: every Drive API call funnels through authed(), which
// asks for a token when the old one expires. Two of those at once used to evict
// each other's resolver, so one promise hung forever and whatever awaited it
// never finished.
test('two overlapping Drive connects share one token request and both settle',
  { tag: '@boards' }, async ({ page }) => {
    await bootOptedIn(page, { grant: true });
    await page.evaluate(() => { window.__gis.defer = true; });

    const out = await page.evaluate(async () => {
      const D = window.__wb_drive;
      const a = D.connect(true), b = D.connect(false);
      await new Promise((r) => setTimeout(r, 0));      // let both reach GIS
      window.__gis.settle();
      // Race each against a timer: a hung promise has to report as a value, not
      // as a suite-wide timeout, or the failure says nothing about the bug.
      const settles = (p) => Promise.race([
        p.then(() => 'settled', () => 'settled'),
        new Promise((r) => setTimeout(() => r('hung'), 300)),
      ]);
      return { a: await settles(a), b: await settles(b),
               calls: window.__gis.calls, connected: D.isConnected() };
    });
    expect(out).toEqual({ a: 'settled', b: 'settled', calls: ['interactive'], connected: true });
  });

// ── Three-way merge (per-node) — the core "don't clobber unedited things" logic.
//    Exercised directly via the pure window.__wb_mergeBoards hook (no OAuth). ──

// ── Storage pressure: two stores, two ceilings, two different messages ──

const noticeText = (page) => page.locator('#storage-notice .notice-text').textContent();
// Put `bytes` of image data in the asset store under one record, and force
// persisted:false so the eviction branch is the one under test rather than
// whatever this browser happens to grant.
async function seedAssetBytes(page, id, bytes) {
  await page.evaluate(async ([aid, n]) => {
    Object.defineProperty(navigator.storage, 'persisted', { configurable: true, value: async () => false });
    await new Promise((res, rej) => {
      const req = indexedDB.open('whiteboard', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const t = req.result.transaction('assets', 'readwrite');
        t.objectStore('assets').put({ id: aid, blob: new Blob([new Uint8Array(n)], { type: 'image/png' }), w: 1, h: 1, added: Date.now() });
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      };
      req.onerror = () => rej(req.error);
    });
  }, [id, bytes]);
}

// The board-text ceiling is the one Drive can't help with — a Drive board caches
// its content AND a merge base locally, so connecting spends MORE of this
// budget. The message must not send the user down that path.
test('the board-text limit warning does not blame images or recommend Drive',
  { tag: '@boards' }, async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('whiteboard:board:junkfill', 'x'.repeat(2.1e6)));
    await page.evaluate(() => window.__wb_checkStoragePressure());
    await expect(page.locator('#storage-notice')).toBeVisible();
    const text = await noticeText(page);
    expect(text).toMatch(/text and layout/);
    expect(text).toMatch(/aren’t the cause/);
    expect(text).not.toMatch(/Drive/);
  });

// A big image library in one browser is a library the browser may clear. This is
// about durability, not a limit — and it's the one case where Drive IS the fix.
test('a large local-only image library is warned about, pointing at Drive',
  { tag: '@boards' }, async ({ page }) => {
    await seedAssetBytes(page, 'a_bigone001', 21 * 1024 * 1024);
    await page.evaluate(() => window.__wb_checkStoragePressure());
    await expect(page.locator('#storage-notice')).toBeVisible();
    const text = await noticeText(page);
    expect(text).toMatch(/only in this browser/);
    expect(text).toMatch(/Drive/);
    // and the button goes somewhere useful rather than just asserting a problem:
    // the Drive bar, whose next step for a disconnected user is Connect
    await page.click('#storage-notice .notice-show');
    await expect(page.locator('#board-menu')).toBeVisible();
    await expect(page.locator('#driveConnectBtn')).toBeVisible();
  });

// Once the board is on Drive the local copy is a cache: losing it costs a
// download, not the pictures. Warning anyway would be crying wolf.
test('a Drive-backed board is not warned about its local image copy',
  { tag: '@boards' }, async ({ page }) => {
    // Drive-backed BEFORE the bytes land: boot runs its own pressure check on an
    // idle callback, and a device-mode board with 21 MB of images is exactly what
    // that check warns about — so the flip has to be in place first.
    await page.evaluate(() => {
      const lib = JSON.parse(localStorage.getItem('whiteboard:library'));
      const e = lib.find((b) => b.id === localStorage.getItem('whiteboard:current'));
      e.mode = 'drive'; e.driveFileId = 'somefile';
      localStorage.setItem('whiteboard:library', JSON.stringify(lib));
    });
    await seedAssetBytes(page, 'a_bigtwo002', 21 * 1024 * 1024);
    await page.evaluate(() => window.__wb_checkStoragePressure());
    await expect(page.locator('#storage-notice')).toBeHidden();
  });

// The settings panel answers "how much room am I using" on demand, keeping the
// two stores separate — a single blended number can't support either message.
test('settings reports board text and picture storage separately', { tag: '@chrome' }, async ({ page }) => {
  await pasteImage(page);
  await expect(page.locator('#saveState')).toHaveText('saved');
  await page.click('#settingsBtn');
  await expect.poll(() => page.locator('#storeText').textContent()).toMatch(/MB of ~/);
  await expect.poll(() => page.locator('#storeImages').textContent()).toMatch(/MB/);
  await expect.poll(() => page.locator('#storePersisted').textContent()).toMatch(/yes|no/);
});

// ── Drive folder layout: board JSON at the top, image bytes in assets/ ──
// These replace Drive I/O with an in-page fake (window.__wb_drive is the app's
// test seam) and boot with a cached token, which is exactly the path a reload
// inside the token's hour takes. Nothing loads Google's scripts, so no request
// leaves the machine and the network-clean guarantee holds.
async function bootWithFakeDrive(page, { files = [], entry = null } = {}) {
  await page.addInitScript(([seedFiles, seedEntry]) => {
    // A live session without GIS: the app restores this token at startup.
    sessionStorage.setItem('whiteboard:drive:tok', JSON.stringify({ t: 'stub-token', e: Date.now() + 3600e3 }));
    localStorage.setItem('whiteboard:drive:opted', '1');
    if (seedEntry) {
      const lib = JSON.parse(localStorage.getItem('whiteboard:library') || '[]');
      const e = lib.find((b) => b.id === localStorage.getItem('whiteboard:current'));
      if (e) { Object.assign(e, seedEntry); localStorage.setItem('whiteboard:library', JSON.stringify(lib)); }
    }
    const D = window.__drive = { files: {}, next: 100, calls: [] };
    for (const f of seedFiles) {
      const rec = { version: 1, parents: [], ...f };
      // Blobs can't cross into an init script, so image bytes arrive base64'd.
      if (rec.blobBase64) {
        const raw = atob(rec.blobBase64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        rec.blob = new Blob([bytes], { type: 'image/png' });
        delete rec.blobBase64;
      }
      D.files[f.id] = rec;
    }
    const put = (f) => { const id = 'f' + (D.next++); D.files[id] = { id, version: 1, parents: [], ...f }; return D.files[id]; };
    const kidsOf = (p) => Object.values(D.files).filter((f) => (f.parents || []).includes(p));

    const install = (drive) => {
      drive.createFolder = async (name, parent) => {
        D.calls.push('createFolder:' + name);
        return put({ name, folder: true, parents: parent ? [parent] : [] });
      };
      drive.renameFolder = async (id, name) => { D.files[id].name = name; return { id, name }; };
      drive.listChildren = async (p) => kidsOf(p).map((f) => ({ id: f.id, name: f.name }));
      drive.getParents = async (id) => (D.files[id].parents || []).slice();
      drive.moveFile = async (id, add, remove) => {
        const f = D.files[id];
        const rm = String(remove || '').split(',').filter(Boolean);
        f.parents = (f.parents || []).filter((p) => !rm.includes(p)).concat(add);
        f.version++;                       // Drive bumps the version on a move
        D.calls.push('moveFile');
        return { id, version: f.version };
      };
      drive.createFile = async (name, content, parent) => {
        D.calls.push('createFile');
        return put({ name: name + '.whiteboard.json', json: JSON.stringify(content), parents: parent ? [parent] : [] });
      };
      drive.updateFile = async (id, content) => {
        D.calls.push('updateFile');
        const f = D.files[id];
        f.json = JSON.stringify(content); f.version++;
        return { id, name: f.name, version: f.version };
      };
      drive.renameFile = async (id, name) => {
        const f = D.files[id];
        f.name = name + '.whiteboard.json'; f.version++;
        return { id, name: f.name, version: f.version };
      };
      drive.getMeta = async (id) => ({ id, name: D.files[id].name, version: D.files[id].version });
      drive.getFile = async (id) => JSON.parse(D.files[id].json);
      drive.uploadBlob = async (name, blob, parent) => {
        D.calls.push('uploadBlob:' + name);
        return put({ name, blob, parents: parent ? [parent] : [] });
      };
      drive.getBlob = async (id) => D.files[id].blob;
    };
    // The app assigns __wb_drive as it boots; patch it the moment it appears,
    // so boot's own first reconcile already runs against the fake.
    let real;
    Object.defineProperty(window, '__wb_drive', {
      configurable: true,
      get: () => real,
      set: (v) => { real = v; install(v); },
    });
  }, [files, entry]);
  await page.reload();
}
// The fake's file tree, minus the blobs (which don't serialize).
const driveTree = (page) => page.evaluate(() => Object.values(window.__drive.files)
  .map((f) => ({ id: f.id, name: f.name, folder: !!f.folder, parents: f.parents, version: f.version, hasBlob: !!f.blob })));
const driveCalls = (page) => page.evaluate(() => window.__drive.calls);
const libEntry = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('whiteboard:library'))
  .find((b) => b.id === localStorage.getItem('whiteboard:current')));

test('saving an image board to Drive makes a folder, and the bytes go up before the JSON',
  { tag: '@boards' }, async ({ page }) => {
    await pasteImage(page);
    await expect(page.locator('#saveState')).toHaveText('saved');
    await bootWithFakeDrive(page);
    await page.click('#boardMenuBtn');
    await page.click('#driveSaveBtn');
    await expect(page.locator('#driveSaveBtn')).toHaveText('Saved to Drive ✓');

    const tree = await driveTree(page);
    const folder = tree.find((f) => f.folder && f.name !== 'assets');
    const assets = tree.find((f) => f.folder && f.name === 'assets');
    expect(folder).toBeTruthy();
    expect(assets.parents).toEqual([folder.id]);
    // the board JSON sits at the folder's top level, the image inside assets/
    const json = tree.find((f) => /\.whiteboard\.json$/.test(f.name));
    expect(json.parents).toEqual([folder.id]);
    const img = tree.find((f) => f.hasBlob);
    expect(img.parents).toEqual([assets.id]);
    expect(img.name).toMatch(/^a_[a-z0-9]+\.(webp|png)$/);

    // Ordering is the invariant: Drive must never hold a board whose image
    // references dangle, so the bytes land before the JSON that names them.
    const calls = await driveCalls(page);
    expect(calls.findIndex((c) => c.startsWith('uploadBlob'))).toBeLessThan(calls.indexOf('createFile'));
  });

// A board saved before the folder layout is a bare file. Opening it moves that
// file into a new folder — same file id, so every sync watermark survives — and
// the move's version bump has to be recorded or the next tick reads a phantom
// remote change and pulls, which would clear the undo stacks for nothing.
test('a legacy flat Drive file migrates into a folder without a phantom pull',
  { tag: '@boards' }, async ({ page }) => {
    const content = await page.evaluate(() => {
      const raw = localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current'));
      return JSON.parse(raw);
    });
    await bootWithFakeDrive(page, {
      files: [
        { id: 'root1', name: 'My Drive', folder: true, parents: [] },
        { id: 'flat1', name: 'Old board.whiteboard.json', json: JSON.stringify(content), parents: ['root1'] },
      ],
      entry: { mode: 'drive', driveFileId: 'flat1', syncedLocalVersion: content.version, driveVersion: '1' },
    });

    await expect.poll(async () => (await libEntry(page)).driveFolderId).toBeTruthy();
    const e = await libEntry(page);
    expect(e.driveFileId).toBe('flat1');            // the file id is load-bearing
    const tree = await driveTree(page);
    const folder = tree.find((f) => f.id === e.driveFolderId);
    expect(folder.parents).toEqual(['root1']);      // created where the file was
    expect(tree.find((f) => f.id === 'flat1').parents).toEqual([folder.id]);
    expect(tree.find((f) => f.id === e.driveAssetsFolderId).name).toBe('assets');
    // the recorded watermark matches the post-move version, so no pull follows
    expect(e.driveVersion).toBe(String(tree.find((f) => f.id === 'flat1').version));
    expect(await driveCalls(page)).not.toContain('updateFile');
  });

// The payoff for the whole feature: a board whose images are on another device
// fills its placeholders in from Drive.
test('an image referenced by a synced board downloads from the assets folder',
  { tag: '@boards' }, async ({ page }) => {
    // real PNG bytes, encoded here so they can ride into the init script
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 60; c.height = 40;
      const x = c.getContext('2d');
      x.fillStyle = '#5AD19A'; x.fillRect(0, 0, 60, 40);
      return c.toDataURL('image/png').split(',')[1];
    });
    const content = await page.evaluate(() => {
      const key = 'whiteboard:board:' + localStorage.getItem('whiteboard:current');
      const c = JSON.parse(localStorage.getItem(key));
      c.cards['c_remoteimg'] = { x: 120, y: 140, title: 'from the other device',
        body: '<img data-asset="a_remote0001" width="60" height="40">' };
      c.version++;
      localStorage.setItem(key, JSON.stringify(c));
      return c;
    });
    await bootWithFakeDrive(page, {
      files: [
        { id: 'fold1', name: 'Board', folder: true, parents: [] },
        { id: 'asst1', name: 'assets', folder: true, parents: ['fold1'] },
        { id: 'json1', name: 'Board.whiteboard.json', json: JSON.stringify(content), parents: ['fold1'] },
        // the bytes, as the device that pasted the image left them
        { id: 'img1', name: 'a_remote0001.png', parents: ['asst1'], blobBase64: png },
      ],
      entry: { mode: 'drive', driveFileId: 'json1', driveFolderId: 'fold1', driveAssetsFolderId: 'asst1',
               syncedLocalVersion: content.version, driveVersion: '1' },
    });

    // Version-wise this board is already in sync — the download is driven by the
    // reference being unsatisfied locally, not by a pull.
    const img = page.locator('.node.card[data-id="c_remoteimg"] .card-body img');
    await expect.poll(() => img.getAttribute('src'), { timeout: 15000 }).toMatch(/^blob:/);
    await expect(img).not.toHaveClass(/asset-missing/);
    // and it's in the local store now, so a later load needs no network at all
    expect(await assetExists(page, 'a_remote0001')).toBe(true);
  });

// Opening a board another device created must ADOPT its folder. Creating a
// second one would strand every asset already uploaded there.
test('a board already inside a folder adopts it instead of making another',
  { tag: '@boards' }, async ({ page }) => {
    const content = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current'))));
    await bootWithFakeDrive(page, {
      files: [
        { id: 'fold9', name: 'Shared board', folder: true, parents: [] },
        { id: 'asst9', name: 'assets', folder: true, parents: ['fold9'] },
        { id: 'json9', name: 'Shared board.whiteboard.json', json: JSON.stringify(content), parents: ['fold9'] },
      ],
      // as openFromDrive leaves it when it couldn't inspect the parents itself
      entry: { mode: 'drive', driveFileId: 'json9', syncedLocalVersion: content.version, driveVersion: '1' },
    });
    await expect.poll(async () => (await libEntry(page)).driveFolderId).toBe('fold9');
    const e = await libEntry(page);
    expect(e.driveAssetsFolderId).toBe('asst9');
    expect(await driveCalls(page)).not.toContain('moveFile');
    expect((await driveCalls(page)).filter((c) => c.startsWith('createFolder'))).toEqual([]);
  });

test('merge: edits to different nodes both survive', { tag: '@boards' }, async ({ page }) => {
  const base = boardOf({ a: cardRecordAt(0, 0, 'A'), b: cardRecordAt(10, 10, 'B') });
  const local = boardOf({ a: cardRecordAt(0, 0, 'A EDITED'), b: cardRecordAt(10, 10, 'B') });   // this device edited A
  const remote = boardOf({ a: cardRecordAt(0, 0, 'A'), b: cardRecordAt(99, 99, 'B') });          // other device moved B
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(0);
  expect(merged.cards.a.title).toBe('A EDITED');   // local edit kept
  expect(merged.cards.b.x).toBe(99);               // remote edit kept
});

test('merge: same node, different fields — both edits kept', { tag: '@boards' }, async ({ page }) => {
  const base = boardOf({ a: cardRecordAt(0, 0, 'A', 'body') });
  const local = boardOf({ a: cardRecordAt(50, 60, 'A', 'body') });          // moved it
  const remote = boardOf({ a: cardRecordAt(0, 0, 'A', 'new body') });        // edited its body
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(0);
  expect(merged.cards.a.x).toBe(50);            // local position
  expect(merged.cards.a.body).toBe('new body'); // remote body
});

test('merge: same field on both sides is a conflict, local wins', { tag: '@boards' }, async ({ page }) => {
  const base = boardOf({ a: cardRecordAt(0, 0, 'A', 'orig') });
  const local = boardOf({ a: cardRecordAt(0, 0, 'A', 'mine') });
  const remote = boardOf({ a: cardRecordAt(0, 0, 'A', 'theirs') });
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(1);
  expect(merged.cards.a.body).toBe('mine');
});

test('merge: node added on one side appears; node deleted on one side goes away', { tag: '@boards' }, async ({ page }) => {
  const base = boardOf({ a: cardRecordAt(0, 0, 'A') });
  const local = boardOf({ a: cardRecordAt(0, 0, 'A'), c: cardRecordAt(5, 5, 'C') });  // added C
  const remote = boardOf({});                                          // deleted A
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(0);
  expect(merged.cards.c).toBeTruthy();      // add survives
  expect(merged.cards.a).toBeFalsy();       // delete survives
});

test('merge: delete on one side vs edit on the other keeps the edit', { tag: '@boards' }, async ({ page }) => {
  const base = boardOf({ a: cardRecordAt(0, 0, 'A', 'orig') });
  const local = boardOf({});                                  // deleted A
  const remote = boardOf({ a: cardRecordAt(0, 0, 'A', 'edited') });   // edited A
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(1);
  expect(merged.cards.a.body).toBe('edited');   // don't lose the edit
});

// Button nodes nest an object (action: {type, target}) inside a record. Each
// merge side comes from a separate JSON parse, so equality must be by value —
// reference compare would flag every configured button as edited on both sides.
test('merge: untouched button with a nested action is not a conflict', { tag: '@boards' }, async ({ page }) => {
  const btn = () => ({ x: 0, y: 0, title: 'Go', kind: 'button', action: { type: 'url', target: 'https://a.example' } });
  const base = boardOf({ b1: btn() });
  const local = boardOf({ b1: btn() });                      // untouched here
  const remote = boardOf({ b1: btn(), c: cardRecordAt(5, 5, 'C') }); // other device added a card
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(0);
  expect(merged.cards.b1.action).toEqual({ type: 'url', target: 'https://a.example' });
  expect(merged.cards.c).toBeTruthy();
});

test('merge: remote changing a button link wins when this device did not touch it', { tag: '@boards' }, async ({ page }) => {
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
test('merge: a field deleted on one side stays deleted', { tag: '@boards' }, async ({ page }) => {
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

// ── Forward compatibility: `main` auto-deploys, so "the other device is one
//    version ahead" is the ordinary case. A merge that rebuilds the document
//    from a fixed field list deletes whatever the newer build added, and the
//    victim is always whoever upgraded first. ──

// A future top-level collection (the shape ARCHITECTURE forbids adding *today*,
// precisely because older clients used to drop it) must survive a round trip
// through a build that has never heard of it.
test('merge: a top-level collection this build does not know survives', { tag: '@boards' }, async ({ page }) => {
  const base = boardOf({ a: cardRecordAt(0, 0, 'A') });
  const local = boardOf({ a: cardRecordAt(0, 0, 'A EDITED') });     // this (old) build edited a card
  const remote = boardOf({ a: cardRecordAt(0, 0, 'A') });
  remote.layers = { L1: { name: 'Sketch', hidden: false } };        // a newer build added this
  const { merged, conflicts } = await merge(page, base, local, remote);
  expect(conflicts).toBe(0);
  expect(merged.cards.a.title).toBe('A EDITED');                    // our own edit still lands
  expect(merged.layers).toEqual({ L1: { name: 'Sketch', hidden: false } });
});

// Preserved, but at whole-value granularity — we can't merge inside a shape we
// can't read. Local wins the tie, same rule as every other conflict.
test('merge: an unknown top-level field edited on both sides keeps the local value', { tag: '@boards' }, async ({ page }) => {
  const base = boardOf({}); base.layers = { L1: { name: 'orig' } };
  const local = boardOf({}); local.layers = { L1: { name: 'mine' } };
  const remote = boardOf({}); remote.layers = { L1: { name: 'theirs' } };
  const { merged } = await merge(page, base, local, remote);
  expect(merged.layers).toEqual({ L1: { name: 'mine' } });
});

// Field preservation handles ADDITIVE change. A schema bump is how a future
// build says a field we already read now means something else, and no amount of
// preservation survives being misread — so this build stops touching the board
// rather than syncing its wrong interpretation back over the original.
test('a Drive board written to a newer schema is neither pulled nor overwritten',
  { tag: '@boards' }, async ({ page }) => {
    const mine = await page.evaluate(() => {
      const raw = localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current'));
      return JSON.parse(raw);
    });
    const theirs = { ...mine, schema: 99, cards: { future1: { x: 0, y: 0, title: 'from the future' } } };
    await bootWithFakeDrive(page, {
      files: [
        { id: 'root1', name: 'My Drive', folder: true, parents: [] },
        { id: 'fold1', name: 'Board', folder: true, parents: ['root1'] },
        { id: 'asst1', name: 'assets', folder: true, parents: ['fold1'] },
        { id: 'file1', name: 'Board.whiteboard.json', json: JSON.stringify(theirs), version: 7, parents: ['fold1'] },
      ],
      // driveVersion is stale, so the remote reads as changed → the pull branch
      entry: { mode: 'drive', driveFileId: 'file1', driveFolderId: 'fold1', driveAssetsFolderId: 'asst1',
               syncedLocalVersion: mine.version, driveVersion: '1' },
    });

    await expect(page.locator('#drive-state')).toHaveText(/out of date/);
    // Neither direction ran: the newer board is still intact on Drive…
    expect(await driveCalls(page)).not.toContain('updateFile');
    const remoteNow = await page.evaluate(() => JSON.parse(window.__drive.files.file1.json));
    expect(remoteNow.schema).toBe(99);
    expect(remoteNow.cards.future1).toBeTruthy();
    // …and it was not adopted locally either
    await expect(page.locator('[data-id="future1"]')).toHaveCount(0);

    // The block is remembered, so the next tick doesn't re-download to re-learn
    // it — and an ordinary edit can't replace the warning with "changes pending".
    expect((await libEntry(page)).remoteSchema).toBe(99);
    await addCardAt(page, 300, 300);
    await expect(page.locator('#drive-state')).toHaveText(/out of date/);
  });

// The Drive conflict prompt exists but stays hidden for normal (device-board) use.
test('Drive conflict modal is present and hidden by default', { tag: '@boards' }, async ({ page }) => {
  await expect(page.locator('#conflict-modal')).toBeHidden();
  await expect(page.locator('#conflict-keep-local')).toHaveCount(1);
  await expect(page.locator('#conflict-keep-drive')).toHaveCount(1);
});

// Select-all to grab/move everything (Miro "quick select all to move").
test('Cmd/Ctrl+A selects every node', { tag: '@select' }, async ({ page }) => {
  await addCardAt(page, 300, 300);
  await addCardAt(page, 520, 320);
  await page.mouse.click(60, 180);                 // deselect + drop any edit focus
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.locator('.node.card.selected')).toHaveCount(2);
});

// Keyboard zoom-to-fit (fast recovery; common shortcut Shift+1).
test('Shift+1 zooms to fit all content', { tag: '@nav' }, async ({ page }) => {
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

test('keyboard: arrow keys nudge the selected node, Shift for fine steps', { tag: '@a11y' }, async ({ page }) => {
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

// Alt+Arrow hops selection to the nearest node in that direction — spatial
// navigation that never moves anything (bare arrows keep their nudge meaning).
test('keyboard: Alt+Arrow jumps selection spatially without nudging', { tag: '@a11y' }, async ({ page }) => {
  const a = await addCardAt(page, 350, 300);
  const idA = await a.getAttribute('data-id');
  const b = await addCardAt(page, 700, 320);
  const idB = await b.getAttribute('data-id');
  await page.mouse.click(60, 180);            // canvas focus, nothing selected
  await page.keyboard.press('Tab');           // reading order: a (topmost) first
  await expect(page.locator(`.node[data-id="${idA}"]`)).toHaveClass(/selected/);
  const x0 = await a.evaluate((el) => parseFloat(el.style.left));

  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator(`.node[data-id="${idB}"]`)).toHaveClass(/selected/);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator(`.node[data-id="${idA}"]`)).toHaveClass(/selected/);
  expect(await a.evaluate((el) => parseFloat(el.style.left))).toBe(x0);  // hop ≠ nudge
});

test('keyboard: a burst of nudges undoes as a single step', { tag: ['@a11y', '@undo'] }, async ({ page }) => {
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

test('keyboard: Enter starts editing the selected card', { tag: '@a11y' }, async ({ page }) => {
  await addCardAt(page, 400, 300);
  await page.mouse.click(60, 180);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('.node.card .card-body')).toBeFocused();
  await page.keyboard.type('typed by keyboard');
  await page.keyboard.press('Escape');
  await expect(page.locator('.node.card .card-body')).toContainText('typed by keyboard');
});

test('keyboard: F6 cycles focus through toolbar, palette, and zoom bar', { tag: '@a11y' }, async ({ page }) => {
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

test('keyboard focus is visible on chrome buttons (WCAG 2.4.7)', { tag: '@a11y' }, async ({ page }) => {
  await page.keyboard.press('F6');
  const style = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return { outline: s.outlineStyle, width: s.outlineWidth };
  });
  expect(style.outline).not.toBe('none');
  expect(parseFloat(style.width)).toBeGreaterThan(0);
});

test('modal focus management: Escape closes the embed modal, focus returns to its trigger', { tag: '@a11y' }, async ({ page }) => {
  await page.click('#addFrame');
  await expect(page.locator('#frame-modal')).toBeVisible();
  await expect(page.locator('#frame-url')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#frame-modal')).toBeHidden();
  await expect(page.locator('#addFrame')).toBeFocused();
});

test('keyboard: Escape closes the button link modal', { tag: '@a11y' }, async ({ page }) => {
  await page.click('#addButton');             // new button opens its link modal
  await expect(page.locator('#button-link-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#button-link-modal')).toBeHidden();
});

test('screen readers: Tab selection is announced via a polite live region', { tag: '@a11y' }, async ({ page }) => {
  await addCardAt(page, 400, 300);
  await page.mouse.click(60, 180);
  await page.keyboard.press('Tab');
  await expect(page.locator('.visually-hidden[aria-live="polite"]')).toContainText('1 of 1');
});

test('reduced motion: the locate flash is a static ring that still clears', { tag: '@a11y' }, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await addCardAt(page, 400, 300);
  await page.mouse.click(60, 180);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#jump')).toBeVisible();
  await page.keyboard.press('Enter');                       // jump to the first (only) item
  await expect(page.locator('.node.flash')).toHaveCount(1); // static highlight applied
  await expect(page.locator('.node.flash')).toHaveCount(0, { timeout: 3000 }); // cleared by timer
});

test('keyboard: C aims a connection at the nearest node and Enter creates it', { tag: ['@a11y', '@connections'] }, async ({ page }) => {
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

test('keyboard: Escape cancels an aimed connection without creating one', { tag: ['@a11y', '@connections'] }, async ({ page }) => {
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

// Connections were pointer-only to select once created: Delete and label-edit
// existed but nothing keyboard-driven could set selectedConn. E now steps
// through the selected node's connections, Enter labels the highlighted one,
// Escape returns to the node.
test('keyboard: E cycles a node\'s connections both ways, Enter labels one, Escape returns to the node', { tag: ['@a11y', '@connections'] }, async ({ page }) => {
  const a = await addCardAt(page, 300, 300);
  const b = await addCardAt(page, 760, 300);
  const c = await addCardAt(page, 520, 560);
  const d = await addCardAt(page, 900, 560);
  const connect = async (fromEl, side, toEl) => {
    await fromEl.hover();
    const p = await fromEl.locator(`.port.${side}`).boundingBox();
    const t = await toEl.boundingBox();
    await drag(page, { x: p.x + p.width / 2, y: p.y + p.height / 2 },
                     { x: t.x + t.width / 2, y: t.y + t.height / 2 });
  };
  await connect(a, 'right', b);            // A → B
  await connect(a, 'bottom', c);           // A → C
  await connect(a, 'right', d);            // A → D  (three arrows: direction is observable)
  await expect(page.locator('#connections g.conn')).toHaveCount(3);

  const selConn = () => page.locator('#connections g.conn.selected');
  const selId = () => selConn().getAttribute('data-id');
  // select A via its header — clicking the body would focus the contenteditable
  // (onCanvas would go false and E would type instead of cycling)
  await a.locator('.card-header').click();
  await expect(a).toHaveClass(/selected/);

  // forward E visits all three in order, then wraps
  await page.keyboard.press('e');
  const seq = [await selId()];
  await page.keyboard.press('e'); seq.push(await selId());
  await page.keyboard.press('e'); seq.push(await selId());
  expect(new Set(seq).size).toBe(3);        // three distinct arrows
  await page.keyboard.press('e');
  expect(await selId()).toBe(seq[0]);       // wraps to the first

  // Shift+E from seq[0] steps BACKWARD to seq[2] (forward would give seq[1])
  await page.keyboard.press('Shift+e');
  expect(await selId()).toBe(seq[2]);
  await page.keyboard.press('Shift+e');
  expect(await selId()).toBe(seq[1]);

  await page.keyboard.press('Escape');     // back to the node, not empty
  await expect(a).toHaveClass(/selected/);
  await expect(selConn()).toHaveCount(0);
  // Shift+E from the node lands on the LAST arrow directly (backward fresh start)
  await page.keyboard.press('Shift+e');
  expect(await selId()).toBe(seq[2]);

  await page.keyboard.press('Escape');
  await page.keyboard.press('e');          // reselect a connection
  await page.keyboard.press('Enter');      // edit its label
  await page.keyboard.type('allied with');
  await page.keyboard.press('Enter');
  await expect(page.locator('.conn-label', { hasText: 'allied with' })).toHaveCount(1);
});

// Context-menu actions (color, pin, dock, copy id, …) were right-click only,
// and nodes hold virtual selection — no DOM focus — so the browser's own menu
// key had nothing to target. M (also Shift+F10 / the Menu key) now opens the
// menu for the selection with role=menu, focus on the first item, and arrow-
// key navigation.
test('keyboard: M opens the context menu for the selected node with arrow-nav, and an item fires', { tag: ['@a11y'] }, async ({ page }) => {
  const card = await addCardAt(page, 450, 320);
  await page.mouse.click(60, 180);        // focus the canvas
  await page.keyboard.press('Tab');       // select the card
  await expect(card).toHaveClass(/selected/);

  await page.keyboard.press('m');
  const menu = page.locator('#context-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('role', 'menu');
  // focus landed inside the menu, on the first menuitem
  expect(await page.evaluate(() => document.activeElement.closest('#context-menu') !== null)).toBe(true);
  const firstFocused = await page.evaluate(() => document.activeElement.textContent);

  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => document.activeElement.textContent)).not.toBe(firstFocused);

  // arrow to the Duplicate item and activate it with Enter
  await page.keyboard.press('Home');      // back to the first item
  const label = () => page.evaluate(() => document.activeElement.querySelector('.ctx-label')?.textContent || '');
  for (let i = 0; i < 12 && !/Duplicate/.test(await label()); i++) await page.keyboard.press('ArrowDown');
  expect(await label()).toMatch(/Duplicate/);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(page.locator('.node.card')).toHaveCount(2);   // duplicated
  // focus is back on the canvas (body), not stranded in the removed menu
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('keyboard: Escape closes the M-opened menu without acting', { tag: ['@a11y'] }, async ({ page }) => {
  await addCardAt(page, 450, 320);
  await page.mouse.click(60, 180);
  await page.keyboard.press('Tab');
  await page.keyboard.press('m');
  await expect(page.locator('#context-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#context-menu')).toBeHidden();
  await expect(page.locator('.node.card')).toHaveCount(1);   // nothing happened
});

test('keyboard: the board menu list is arrow-navigable and Enter switches boards', { tag: ['@a11y', '@boards'] }, async ({ page }) => {
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

test('modals trap Tab: focus cycles inside the embed dialog', { tag: '@a11y' }, async ({ page }) => {
  await page.click('#addFrame');
  await expect(page.locator('#frame-modal')).toBeVisible();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('#frame-modal'))).toBe(true);
  }
  await page.keyboard.press('Escape');
});

// The link picker hangs off the edit toolbar's link button; like the toolbar
// (see the 2d test above) it must re-anchor as the board pans, not stick to
// its original screen position.
// Re-opening the picker on an existing inline link offers "Remove link",
// which unwraps the chip back to plain text — previously there was no way
// out of having a link at all.
test('the link picker can remove an existing inline link', { tag: '@nav' }, async ({ page }) => {
  const a = await addCardAt(page, 350, 300);
  const idA = await a.getAttribute('data-id');
  const b = await addCardAt(page, 700, 300);
  const idB = await b.getAttribute('data-id');
  const bodyA = page.locator(`.node[data-id="${idA}"] .card-body`);
  await bodyA.click();
  await page.click('#tt-link');
  await page.locator(`#node-picker .np-item[data-id="${idB}"]`).click();
  const chip = bodyA.locator('a.node-link');
  await expect(chip).toHaveCount(1);
  const label = await chip.textContent();

  // put the selection on the chip, then reopen the picker: it's now editing
  await page.evaluate(() => {
    const el = document.querySelector('a.node-link');
    const r = document.createRange();
    r.selectNode(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.click('#tt-link');
  const remove = page.locator('#node-picker .np-remove');
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(bodyA.locator('a.node-link')).toHaveCount(0);
  await expect(bodyA).toContainText(label);                  // the text survives
  await expect(page.locator('#saveState')).toHaveText('saved');
  await page.reload();
  await expect(page.locator(`.node[data-id="${idA}"] .card-body a.node-link`)).toHaveCount(0);
});

test('the link picker stays anchored to the toolbar when the board is panned', { tag: '@chrome' }, async ({ page }) => {
  await addCardAt(page, 500, 350);
  await page.locator('.node.card .card-body').first().click();
  await page.click('#tt-link');
  const picker = page.locator('#node-picker');
  await expect(picker).toBeVisible();
  const before = await picker.evaluate((el) => parseFloat(el.style.top));
  await page.evaluate(() => document.getElementById('viewport').dispatchEvent(
    new WheelEvent('wheel', { deltaY: 220, clientX: 600, clientY: 400, bubbles: true, cancelable: true })));
  // the card (and toolbar) moved up on screen — the picker must follow (~ the pan delta)
  await expect.poll(() => picker.evaluate((el) => parseFloat(el.style.top))).toBeLessThan(before - 100);
  // and it still hangs just below the toolbar's link button
  const gap = await page.evaluate(() => {
    const b = document.getElementById('tt-link').getBoundingClientRect();
    const p = document.getElementById('node-picker').getBoundingClientRect();
    return p.top - b.bottom;
  });
  expect(gap).toBeGreaterThan(0);
  expect(gap).toBeLessThan(12);
});

// While its card is partly visible the toolbar clamps to stay readable, but
// once the card is fully off screen it must scroll off WITH the card — not
// hug the screen edge detached from anything visible. (Both axes.)
test('the edit toolbar releases the edge and scrolls off once its card leaves the screen', { tag: '@chrome' }, async ({ page }) => {
  await addCardAt(page, 400, 350);
  await page.locator('.node.card .card-body').first().click();
  const bar = page.locator('#text-toolbar');
  await expect(bar).toBeVisible();
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 6; i++) v.dispatchEvent(new WheelEvent('wheel',
      { deltaX: 300, deltaY: 0, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
  });
  // the card is now far past the left edge — the toolbar followed it off
  await expect.poll(() => bar.evaluate((el) => parseFloat(el.style.left))).toBeLessThan(-100);
});

// Cards auto-size to their text, so typing moves the anchor. Above the card
// that's harmless (the top edge is fixed), but a toolbar flipped BELOW a
// top-of-screen card used to stay at the old bottom edge — which typing then
// pushed past, leaving the bar parked on top of the text it belongs to.
test('the edit toolbar follows the bottom edge of a card that grows as you type', { tag: '@chrome' }, async ({ page }) => {
  const card = await addCardAt(page, 400, 90);               // high enough to force the flip below
  await card.locator('.card-body').click();
  const bar = page.locator('#text-toolbar');
  await expect(bar).toBeVisible();
  const geom = () => page.evaluate(() => {
    const c = document.querySelector('.node.card').getBoundingClientRect();
    const t = document.getElementById('text-toolbar').getBoundingClientRect();
    return { cardBottom: c.bottom, barTop: t.top, overlaps: t.top < c.bottom && t.bottom > c.top };
  });
  const before = await geom();
  expect(before.overlaps).toBe(false);
  expect(before.barTop).toBeGreaterThan(before.cardBottom);  // flipped below, clear of the card

  for (let i = 0; i < 12; i++) await page.keyboard.type('a line of text to grow the card\n');
  await expect.poll(async () => (await geom()).cardBottom).toBeGreaterThan(before.cardBottom + 200);
  await expect.poll(async () => (await geom()).overlaps).toBe(false);
  const after = await geom();
  expect(after.barTop).toBeGreaterThan(after.cardBottom);    // still below the grown card
});

test('the link picker scrolls off with its card instead of hugging the edge', { tag: '@chrome' }, async ({ page }) => {
  await addCardAt(page, 400, 350);
  await page.locator('.node.card .card-body').first().click();
  await page.click('#tt-link');
  const picker = page.locator('#node-picker');
  await expect(picker).toBeVisible();
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 6; i++) v.dispatchEvent(new WheelEvent('wheel',
      { deltaX: 300, deltaY: 0, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => picker.evaluate((el) => parseFloat(el.style.left))).toBeLessThan(-100);
});

// The off-screen glide (0.3s ease) is enabled via a .gliding class only while
// the card is released off screen — never during on-screen tracking, where a
// transition would lag the toolbar behind its card. Assert the toggle.
test('the toolbar glides only when released off screen, tracks instantly on screen', { tag: '@chrome' }, async ({ page }) => {
  await addCardAt(page, 400, 350);
  await page.locator('.node.card .card-body').first().click();
  const bar = page.locator('#text-toolbar');
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveClass(/gliding/);             // on screen → instant tracking
  const pan = () => page.evaluate(() => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 6; i++) v.dispatchEvent(new WheelEvent('wheel',
      { deltaX: 300, deltaY: 0, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
  });
  await pan();
  await expect(bar).toHaveClass(/gliding/);                 // card gone → glide enabled
  expect(await bar.evaluate((el) => getComputedStyle(el).transitionDuration)).toContain('0.3s');
  await page.evaluate(() => {                               // pan back the other way
    const v = document.getElementById('viewport');
    for (let i = 0; i < 6; i++) v.dispatchEvent(new WheelEvent('wheel',
      { deltaX: -300, deltaY: 0, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
  });
  await expect(bar).not.toHaveClass(/gliding/);             // back on screen → instant again
});

// After gliding off, the toolbar/picker must glide BACK to their tracked spot
// when the card returns — not stay frozen off screen (the "doesn't go back"
// bug). And the picker must land fully off, never half-on hugging the edge.
test('the toolbar and picker glide back on screen when their card returns', { tag: '@chrome' }, async ({ page }) => {
  await addCardAt(page, 400, 350);
  await page.locator('.node.card .card-body').first().click();
  await page.click('#tt-link');
  const bar = page.locator('#text-toolbar');
  const picker = page.locator('#node-picker');
  await expect(picker).toBeVisible();
  const panBy = (dx) => page.evaluate((d) => {
    const v = document.getElementById('viewport');
    for (let i = 0; i < 6; i++) v.dispatchEvent(new WheelEvent('wheel',
      { deltaX: d, deltaY: 0, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
  }, dx);

  await panBy(300);                                          // card off to the left
  await expect.poll(() => picker.evaluate((el) => parseFloat(el.style.left))).toBeLessThan(-100);
  await expect.poll(() => bar.evaluate((el) => parseFloat(el.style.left))).toBeLessThan(-100);

  await panBy(-300);                                         // bring it back
  // both settle back on screen (the glide-back plus self-healing reposition)
  await expect.poll(() => bar.evaluate((el) => parseFloat(el.style.left)), { timeout: 3000 })
    .toBeGreaterThanOrEqual(0);
  await expect.poll(() => picker.evaluate((el) => parseFloat(el.style.left)), { timeout: 3000 })
    .toBeGreaterThanOrEqual(0);
});

// Clicking away with the link picker open must dismiss the whole editing UI —
// the picker's filter input holds focus, so only ITS blur can signal it. And
// Escape must rescue a stranded toolbar/picker from the canvas.
test('clicking away (or Escape) closes the edit toolbar and link picker', { tag: '@chrome' }, async ({ page }) => {
  await addCardAt(page, 420, 320);
  const bar = page.locator('#text-toolbar');
  const picker = page.locator('#node-picker');

  await page.locator('.node.card .card-body').first().click();
  await page.click('#tt-link');
  await expect(picker).toBeVisible();
  await page.mouse.click(950, 620);                          // empty canvas
  await expect(picker).toBeHidden();
  await expect(bar).toBeHidden();

  // Escape path: re-open, strand it, and check Escape closes it SYNCHRONOUSLY
  // (before the 150ms blur timer could) — proving the Escape chain handles it
  await page.locator('.node.card .card-body').first().click();
  await page.click('#tt-link');
  await expect(picker).toBeVisible();
  const closedByEscape = await page.evaluate(() => {
    document.activeElement.blur();                           // strand without a click
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return document.getElementById('node-picker').classList.contains('hidden') &&
           document.getElementById('text-toolbar').classList.contains('hidden');
  });
  expect(closedByEscape).toBe(true);
});
