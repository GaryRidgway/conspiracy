import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const EMBED_URL = 'http://localhost:8123/tests/fixtures/embed.html';

// ── helpers ─────────────────────────────────────────────
const board = (page) => page.evaluate(() => localStorage.getItem('whiteboard'));

// Wait for the debounced auto-save to flush something into localStorage.
async function expectSaved(page, substr) {
  await expect.poll(() => board(page), { timeout: 3000 }).toContain(substr);
}

// Low-level drag using pointer events (the app listens on pointer*).
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

// Create an iframe through the themed modal.
async function addFrame(page, url) {
  await page.click('#addFrame');
  await expect(page.locator('#frame-modal')).toBeVisible();
  await page.fill('#frame-url', url);
  await page.click('#frame-add');
  await expect(page.locator('#frame-modal')).toBeHidden();
}

// Screen-space midpoint of a connection path, correct under any pan/zoom.
async function connectionMidpoint(page) {
  return page.locator('#connections .line').evaluate((line) => {
    const p = line.getPointAtLength(line.getTotalLength() / 2);
    const s = p.matrixTransform(line.getScreenCTM());
    return { x: s.x, y: s.y };
  });
}

// Create a card by double-clicking empty canvas at screen (x, y).
// Focus the title explicitly rather than relying on the rAF auto-focus,
// which a programmatic dblclick can outrun.
async function makeCardAt(page, x, y, { title, body } = {}) {
  const before = await page.locator('.node.card').count();
  await page.mouse.dblclick(x, y);
  await expect(page.locator('.node.card')).toHaveCount(before + 1);
  const node = page.locator('.node.card').last();
  if (title != null || body != null) {
    await node.locator('.card-title').click();
    if (title != null) await page.keyboard.type(title);
    if (body != null) { await page.keyboard.press('Enter'); await page.keyboard.type(body); }
    await page.keyboard.press('Escape');
  }
  return node;
}

// ── fixture: fresh isolated context per test + error capture ──
let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
});
test.afterEach(() => {
  expect(errors, 'no uncaught page errors').toEqual([]);
});

// ════════════════════════════════════════════════════════
test('boots with an empty board and a toolbar', async ({ page }) => {
  await expect(page.locator('#toolbar .brand')).toContainText('Infinite Whiteboard');
  for (const id of ['#addCard', '#addFrame', '#fitContent', '#resetView', '#clearBoard']) {
    await expect(page.locator(id)).toBeVisible();
  }
  await expect(page.locator('.node')).toHaveCount(0);
});

test('+ Card creates a card; title/body persist across reload', async ({ page }) => {
  await page.click('#addCard');
  await page.keyboard.type('My Title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('My Body');
  await page.keyboard.press('Escape');

  await expect(page.locator('.node.card')).toHaveCount(1);
  await expectSaved(page, 'My Title');

  await page.reload();
  await expect(page.locator('.card-title')).toHaveText('My Title');
  await expect(page.locator('.card-body')).toHaveText('My Body');
});

test('double-click empty canvas creates a card', async ({ page }) => {
  await makeCardAt(page, 400, 300, { title: 'DblClick' });
  await expect(page.locator('.node.card')).toHaveCount(1);
  await expectSaved(page, 'DblClick');
});

test('dragging a card moves it and the new position persists', async ({ page }) => {
  await makeCardAt(page, 300, 300, { title: 'Movable' });
  const node = page.locator('.node.card');
  const before = await node.boundingBox();

  const header = page.locator('.card-header');
  const hb = await header.boundingBox();
  // grab header to the right of the title, left of the delete button
  await drag(page, { x: hb.x + hb.width * 0.55, y: hb.y + hb.height / 2 },
                   { x: hb.x + hb.width * 0.55 + 160, y: hb.y + hb.height / 2 + 90 });

  const after = await node.boundingBox();
  expect(after.x).toBeGreaterThan(before.x + 100);
  expect(after.y).toBeGreaterThan(before.y + 50);

  const left = await node.evaluate((el) => el.style.left);
  await expectSaved(page, '"title":"Movable"');
  await page.reload();
  await expect(page.locator('.node.card')).toHaveCount(1);
  expect(await page.locator('.node.card').evaluate((el) => el.style.left)).toBe(left);
});

test('delete a card via the × button', async ({ page }) => {
  await makeCardAt(page, 350, 350, { title: 'ToDelete' });
  await page.locator('.node.card').hover();
  await page.click('.card-delete');
  await expect(page.locator('.node.card')).toHaveCount(0);
});

test('delete a selected card via the Delete key', async ({ page }) => {
  await makeCardAt(page, 350, 350, { title: 'KeyDelete' });
  // select by clicking the header (not the editable title)
  const hb = await page.locator('.card-header').boundingBox();
  await page.mouse.click(hb.x + hb.width * 0.55, hb.y + hb.height / 2);
  await page.keyboard.press('Delete');
  await expect(page.locator('.node.card')).toHaveCount(0);
});

test('+ Frame embeds a URL with sandbox; label + src persist', async ({ page }) => {
  await addFrame(page, EMBED_URL);

  const frame = page.locator('.node.iframe-node');
  await expect(frame).toHaveCount(1);
  await expect(frame.locator('iframe')).toHaveAttribute('src', EMBED_URL);
  await expect(frame.locator('iframe')).toHaveAttribute('sandbox', /allow-scripts/);
  await expect(frame.locator('.iframe-label')).toHaveText('localhost');

  await expectSaved(page, EMBED_URL);
  await page.reload();
  await expect(page.locator('.node.iframe-node iframe')).toHaveAttribute('src', EMBED_URL);
});

test('edit a frame URL in place from its header', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const frame = page.locator('.node.iframe-node');
  await expect(frame.locator('iframe')).toHaveAttribute('src', EMBED_URL);

  await frame.locator('.iframe-edit').click();
  await expect(page.locator('#frame-modal')).toBeVisible();
  await expect(page.locator('#frame-url')).toHaveValue(EMBED_URL);   // prefilled
  await expect(page.locator('#frame-add')).toHaveText('Save');

  await page.fill('#frame-url', 'https://example.org/');
  await page.click('#frame-add');
  await expect(page.locator('#frame-modal')).toBeHidden();

  await expect(frame.locator('iframe')).toHaveAttribute('src', 'https://example.org/');
  await expect(frame.locator('.iframe-label')).toHaveText('example.org');

  await expectSaved(page, 'example.org');
  await page.reload();
  await expect(page.locator('.node.iframe-node iframe')).toHaveAttribute('src', 'https://example.org/');
});

test('iframe interact mode toggles on double-click and off on Escape', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const frame = page.locator('.node.iframe-node');
  await expect(frame).toHaveCount(1);

  const wrap = await frame.locator('.iframe-wrap').boundingBox();
  await page.mouse.dblclick(center(wrap).x, center(wrap).y);
  await expect(frame).toHaveClass(/interactive/);

  await page.keyboard.press('Escape');
  await expect(frame).not.toHaveClass(/interactive/);
});

test('resizing a frame changes its size and persists', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const frame = page.locator('.node.iframe-node');
  await expect(frame).toHaveCount(1);

  const before = await frame.boundingBox();
  const handle = await frame.locator('.resize-handle').boundingBox();
  await drag(page, center(handle), { x: center(handle).x + 80, y: center(handle).y + 60 });

  const after = await frame.boundingBox();
  expect(after.width).toBeGreaterThan(before.width + 50);
  expect(after.height).toBeGreaterThan(before.height + 40);

  await expectSaved(page, '"w":');
  await page.reload();
  const restored = await page.locator('.node.iframe-node').boundingBox();
  expect(Math.round(restored.width)).toBe(Math.round(after.width));
});

test('drag a port to another node to create a connection; it persists', async ({ page }) => {
  await makeCardAt(page, 250, 300, { title: 'A' });
  await makeCardAt(page, 700, 320, { title: 'B' });
  const cards = page.locator('.node.card');
  await expect(cards).toHaveCount(2);

  const a = cards.nth(0);
  const b = cards.nth(1);
  await a.hover(); // reveal ports (pointer-events become active on hover)
  const port = await a.locator('.port.right').boundingBox();
  const bBox = await b.boundingBox();
  await drag(page, center(port), center(bBox));

  await expect(page.locator('#connections g.conn')).toHaveCount(1);
  const d = await page.locator('#connections .line').getAttribute('d');
  expect(d).toMatch(/^M[\d.-]+,[\d.-]+ C/); // a real bezier

  await expectSaved(page, '"from"');
  await page.reload();
  await expect(page.locator('#connections g.conn')).toHaveCount(1);
});

test('a connection re-routes when a connected node moves', async ({ page }) => {
  await makeCardAt(page, 250, 300, { title: 'A' });
  await makeCardAt(page, 700, 320, { title: 'B' });
  const a = page.locator('.node.card').nth(0);
  const b = page.locator('.node.card').nth(1);

  await a.hover();
  const port = await a.locator('.port.right').boundingBox();
  await drag(page, center(port), center(await b.boundingBox()));
  await expect(page.locator('#connections g.conn')).toHaveCount(1);

  const before = await page.locator('#connections .line').getAttribute('d');
  // move B downward
  const hb = await b.locator('.card-header').boundingBox();
  await drag(page, { x: hb.x + hb.width * 0.55, y: hb.y + hb.height / 2 },
                   { x: hb.x + hb.width * 0.55, y: hb.y + hb.height / 2 + 200 });
  const after = await page.locator('#connections .line').getAttribute('d');
  expect(after).not.toBe(before);
});

test('select a connection and delete it with the Delete key', async ({ page }) => {
  await makeCardAt(page, 200, 250, { title: 'A' });
  await makeCardAt(page, 750, 250, { title: 'B' });
  const a = page.locator('.node.card').nth(0);
  await a.hover();
  const port = await a.locator('.port.right').boundingBox();
  await drag(page, center(port), center(await page.locator('.node.card').nth(1).boundingBox()));
  await expect(page.locator('#connections g.conn')).toHaveCount(1);

  // click the curve midpoint (converted world→screen via getScreenCTM)
  const mid = await connectionMidpoint(page);
  await page.mouse.click(mid.x, mid.y);
  await expect(page.locator('#connections g.conn.selected')).toHaveCount(1);

  await page.keyboard.press('Delete');
  await expect(page.locator('#connections g.conn')).toHaveCount(0);
});

test('deleting a node removes its connections', async ({ page }) => {
  await makeCardAt(page, 250, 300, { title: 'A' });
  await makeCardAt(page, 700, 320, { title: 'B' });
  const a = page.locator('.node.card').nth(0);
  await a.hover();
  const port = await a.locator('.port.right').boundingBox();
  await drag(page, center(port), center(await page.locator('.node.card').nth(1).boundingBox()));
  await expect(page.locator('#connections g.conn')).toHaveCount(1);

  await a.hover();
  await a.locator('.card-delete').click();
  await expect(page.locator('.node.card')).toHaveCount(1);
  await expect(page.locator('#connections g.conn')).toHaveCount(0);
});

test('Clear empties the whole board', async ({ page }) => {
  await makeCardAt(page, 300, 300, { title: 'A' });
  await makeCardAt(page, 500, 400, { title: 'B' });
  await expect(page.locator('.node.card')).toHaveCount(2);

  page.once('dialog', (d) => d.accept()); // confirm()
  await page.click('#clearBoard');
  await expect(page.locator('.node')).toHaveCount(0);
  await expectSaved(page, '"cards":{}');
});

test('Export downloads the board as JSON', async ({ page }) => {
  await makeCardAt(page, 350, 300, { title: 'ExportMe' });
  await expectSaved(page, 'ExportMe');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportBtn'),
  ]);
  expect(download.suggestedFilename()).toBe('whiteboard.json');
  const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(Object.values(data.cards).map((c) => c.title)).toContain('ExportMe');
});

test('Import replaces the board and restores the viewport', async ({ page }) => {
  await makeCardAt(page, 300, 300, { title: 'Original' });

  const imported = {
    schema: 1, version: 9,
    viewport: { x: -150, y: 75, zoom: 1 },
    cards: { c_imp: { x: 220, y: 140, title: 'Imported', body: 'hi' } },
    iframes: {}, connections: {},
  };
  page.once('dialog', (d) => d.accept());   // confirm the replace
  await page.locator('#importFile').setInputFiles({
    name: 'board.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });

  await expect(page.locator('.card-title')).toHaveText('Imported');
  await expect(page.locator('.node.card')).toHaveCount(1);
  // viewport applied immediately (no need to wait for the debounced save)
  const t = await page.evaluate(() => document.getElementById('world').style.transform);
  expect(t).toContain('translate(-150px, 75px)');
});

test('Import rejects invalid JSON and leaves the board untouched', async ({ page }) => {
  await makeCardAt(page, 300, 300, { title: 'Keep' });

  const [dialog] = await Promise.all([
    page.waitForEvent('dialog'),
    page.locator('#importFile').setInputFiles({
      name: 'bad.json', mimeType: 'application/json',
      buffer: Buffer.from('not json {{{'),
    }),
  ]);
  expect(dialog.message()).toContain('Import failed');
  await dialog.accept();
  await expect(page.locator('.card-title')).toHaveText('Keep');
  await expect(page.locator('.node.card')).toHaveCount(1);
});

test('copy-link puts a #node=<id> deep link on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const node = await makeCardAt(page, 350, 300, { title: 'Linkable' });
  const id = await node.getAttribute('data-id');

  await node.hover();
  await node.locator('.copy-link').click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('#node=' + id);
});

test('opening #node=<id> frames and selects that node', async ({ page }) => {
  // make a node far from origin so framing visibly changes the viewport
  const node = await makeCardAt(page, 1100, 650, { title: 'Target' });
  const id = await node.getAttribute('data-id');
  await expectSaved(page, 'Target');

  await page.goto('/#node=' + id);
  // framed: world is zoomed in; node is selected
  await expect(page.locator('.node.card.selected')).toHaveCount(1);
  const scale = await page.evaluate(() => {
    const m = document.getElementById('world').style.transform.match(/scale\(([^)]+)\)/);
    return m ? parseFloat(m[1]) : 1;
  });
  expect(scale).toBeGreaterThan(1);
});

test('Tab and Shift+Tab cycle selection between nodes', async ({ page }) => {
  await makeCardAt(page, 250, 300, { title: 'A' });
  await makeCardAt(page, 620, 300, { title: 'B' });
  await page.keyboard.press('Escape');   // clear the post-create selection

  await page.keyboard.press('Tab');
  await expect(page.locator('.node.selected')).toHaveCount(1);
  const first = await page.locator('.node.selected').getAttribute('data-id');

  await page.keyboard.press('Tab');
  const second = await page.locator('.node.selected').getAttribute('data-id');
  expect(second).not.toBe(first);

  await page.keyboard.press('Shift+Tab');
  expect(await page.locator('.node.selected').getAttribute('data-id')).toBe(first);
});

test('off-screen iframes are not loaded until brought into view', async ({ page }) => {
  await page.evaluate((url) => {
    localStorage.setItem('whiteboard', JSON.stringify({
      schema: 1, version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      cards: {}, connections: {},
      iframes: { f_far: { x: 4000, y: 4000, w: 480, h: 320, src: url, logicalWidth: 1440 } },
    }));
  }, EMBED_URL);
  await page.reload();

  await expect(page.locator('.node.iframe-node')).toHaveCount(1);
  await expect(page.locator('.node.iframe-node')).not.toHaveClass(/loaded/);
  expect(await page.locator('.node.iframe-node iframe').getAttribute('src')).toBeNull();

  await page.goto('/#node=f_far');   // deep-link frames it into view
  await expect(page.locator('.node.iframe-node')).toHaveClass(/loaded/);
  await expect(page.locator('.node.iframe-node iframe')).toHaveAttribute('src', EMBED_URL);
});

test('iframes too small on screen stay unloaded until fit/zoomed', async ({ page }) => {
  await page.evaluate((url) => {
    localStorage.setItem('whiteboard', JSON.stringify({
      schema: 1, version: 1, viewport: { x: 0, y: 0, zoom: 0.1 },
      cards: {}, connections: {},
      iframes: { f_tiny: { x: 50, y: 50, w: 480, h: 320, src: url, logicalWidth: 1440 } },
    }));
  }, EMBED_URL);
  await page.reload();
  await expect(page.locator('.node.iframe-node')).not.toHaveClass(/loaded/);   // 48px wide < 120

  await page.click('#zoomFit');
  await expect(page.locator('.node.iframe-node')).toHaveClass(/loaded/);
});

test('Reset view returns viewport to origin and 100%', async ({ page }) => {
  // pan away first
  await drag(page, { x: 600, y: 400 }, { x: 300, y: 250 });
  await page.click('#resetView');
  await expectSaved(page, '"viewport":{"x":0,"y":0,"zoom":1}');
  const vp = await page.evaluate(() => JSON.parse(localStorage.getItem('whiteboard')).viewport);
  expect(vp).toMatchObject({ x: 0, y: 0, zoom: 1 });
});

test('themed modal: Cancel and Escape dismiss without creating; Enter submits', async ({ page }) => {
  // Cancel button
  await page.click('#addFrame');
  await expect(page.locator('#frame-modal')).toBeVisible();
  await page.click('#frame-cancel');
  await expect(page.locator('#frame-modal')).toBeHidden();
  await expect(page.locator('.node.iframe-node')).toHaveCount(0);

  // Escape key
  await page.click('#addFrame');
  await expect(page.locator('#frame-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#frame-modal')).toBeHidden();
  await expect(page.locator('.node.iframe-node')).toHaveCount(0);

  // Enter submits; a bare host gets https://
  await page.click('#addFrame');
  await page.fill('#frame-url', 'example.org');
  await page.keyboard.press('Enter');
  await expect(page.locator('#frame-modal')).toBeHidden();
  await expect(page.locator('.node.iframe-node iframe')).toHaveAttribute('src', 'https://example.org');
});

test('Ctrl+wheel zooms and clamps to 10–400%', async ({ page }) => {
  const scale = () => page.evaluate(() => {
    const m = document.getElementById('world').style.transform.match(/scale\(([^)]+)\)/);
    return m ? parseFloat(m[1]) : 1;
  });
  const wheel = (deltaY, n = 1) => page.evaluate(({ deltaY, n }) => {
    const vp = document.getElementById('viewport');
    for (let i = 0; i < n; i++) {
      vp.dispatchEvent(new WheelEvent('wheel', {
        deltaY, clientX: 400, clientY: 300, ctrlKey: true, bubbles: true, cancelable: true,
      }));
    }
  }, { deltaY, n });

  expect(await scale()).toBeCloseTo(1, 5);
  await wheel(-300);                      // zoom in
  expect(await scale()).toBeGreaterThan(1);
  await wheel(800, 40);                   // spam out → clamp at MIN
  expect(await scale()).toBeGreaterThanOrEqual(0.1 - 1e-9);
  expect(await scale()).toBeLessThan(1);
  await wheel(-800, 80);                  // spam in → clamp at MAX
  expect(await scale()).toBeLessThanOrEqual(4 + 1e-9);
  expect(await scale()).toBeGreaterThan(1);
});

const worldScale = (page) => page.evaluate(() => {
  const m = document.getElementById('world').style.transform.match(/scale\(([^)]+)\)/);
  return m ? parseFloat(m[1]) : 1;
});

test('zoom widget zooms the canvas and resets, with a live % readout', async ({ page }) => {
  await expect(page.locator('#zoomReset')).toHaveText('100%');

  await page.click('#zoomIn');
  expect(await worldScale(page)).toBeGreaterThan(1);
  await expect(page.locator('#zoomReset')).not.toHaveText('100%');

  await page.click('#zoomReset');
  expect(await worldScale(page)).toBeCloseTo(1, 5);
  await expect(page.locator('#zoomReset')).toHaveText('100%');

  await page.click('#zoomOut');
  expect(await worldScale(page)).toBeLessThan(1);
});

test('using a canvas zoom control exits iframe interact mode', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const frame = page.locator('.node.iframe-node');
  const wrap = await frame.locator('.iframe-wrap').boundingBox();
  await page.mouse.dblclick(center(wrap).x, center(wrap).y);
  await expect(frame).toHaveClass(/interactive/);

  await page.click('#zoomIn');                 // a canvas gesture
  await expect(frame).not.toHaveClass(/interactive/);
});

test('panning the canvas exits iframe interact mode', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const frame = page.locator('.node.iframe-node');
  const wrap = await frame.locator('.iframe-wrap').boundingBox();
  await page.mouse.dblclick(center(wrap).x, center(wrap).y);
  await expect(frame).toHaveClass(/interactive/);

  // drag empty canvas (top-left corner is clear of the centered frame)
  await drag(page, { x: 60, y: 200 }, { x: 220, y: 320 });
  await expect(frame).not.toHaveClass(/interactive/);
});

test('zoom keeps the world point under the cursor fixed', async ({ page }) => {
  const node = await makeCardAt(page, 500, 350, { title: 'Anchor' });
  const before = await node.boundingBox();
  const cx = before.x, cy = before.y;     // cursor at the card's top-left corner
  await page.evaluate(({ x, y }) => {
    document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel', {
      deltaY: -400, clientX: x, clientY: y, ctrlKey: true, bubbles: true, cancelable: true,
    }));
  }, { x: cx, y: cy });
  const after = await node.boundingBox();
  // the corner that was under the cursor should stay there
  expect(Math.abs(after.x - cx)).toBeLessThan(3);
  expect(Math.abs(after.y - cy)).toBeLessThan(3);
});

const frameScale = (page) => page.locator('.node.iframe-node iframe')
  .evaluate((f) => parseFloat((f.style.transform.match(/scale\(([^)]+)\)/) || [])[1]));

test('iframe renders at a fixed 1440px logical width, scaled to fit', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const frame = page.locator('.node.iframe-node iframe');
  expect(await frame.evaluate((f) => f.style.width)).toBe('1440px');
  const s = await frameScale(page);
  expect(s).toBeGreaterThan(0);
  expect(s).toBeLessThan(1);              // default 480-wide box < 1440
});

test('resizing a frame keeps 1440 logical width but increases the scale', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const node = page.locator('.node.iframe-node');
  const s1 = await frameScale(page);

  const handle = await node.locator('.resize-handle').boundingBox();
  await drag(page, center(handle), { x: center(handle).x + 200, y: center(handle).y + 120 });

  expect(await page.locator('.node.iframe-node iframe').evaluate((f) => f.style.width)).toBe('1440px');
  expect(await frameScale(page)).toBeGreaterThan(s1);
});

test('per-iframe content zoom: + enlarges, % resets, and it persists', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const node = page.locator('.node.iframe-node');
  const s0 = await frameScale(page);
  await expect(node.locator('.czoom-val')).toHaveText('100%');

  // zoom content in → smaller logical width → larger CSS scale
  await node.locator('.czoom-in').click();
  await node.locator('.czoom-in').click();
  expect(await frameScale(page)).toBeGreaterThan(s0);
  await expect(node.locator('.czoom-val')).not.toHaveText('100%');

  // persists across reload
  await expectSaved(page, '"logicalWidth"');
  await page.reload();
  expect(await frameScale(page)).toBeGreaterThan(s0);

  // clicking the % resets to 100%
  await page.locator('.node.iframe-node .czoom-val').click();
  await expect(page.locator('.node.iframe-node .czoom-val')).toHaveText('100%');
  expect(await frameScale(page)).toBeCloseTo(s0, 5);
});

test('zoom-to-frame button centers the iframe and zooms in', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const node = page.locator('.node.iframe-node');
  await node.locator('.iframe-zoom').click();

  const scale = await page.evaluate(() => {
    const m = document.getElementById('world').style.transform.match(/scale\(([^)]+)\)/);
    return m ? parseFloat(m[1]) : 1;
  });
  expect(scale).toBeGreaterThan(1);

  const vp = page.viewportSize();
  const toolbarBottom = await page.evaluate(
    () => document.getElementById('toolbar').getBoundingClientRect().bottom);
  const box = await node.boundingBox();
  // horizontally centered, and clear of the toolbar (not framed behind it)
  expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(20);
  expect(box.y).toBeGreaterThanOrEqual(toolbarBottom - 1);
  // vertical center sits below the window midpoint (centered in the area below the bar)
  expect(box.y + box.height / 2).toBeGreaterThan(vp.height / 2);
});
