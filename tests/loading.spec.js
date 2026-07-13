// ════════════════════════════════════════════════════════════════════════
//  FRAME LOADING TIERS
//  Embeds load by where they sit relative to the user's viewport:
//    visible  → src set immediately (what you see loads first)
//    near     → within one viewport of an edge: idle-prefetched, one at a
//               time, nearest first
//    far      → stays a "click to load" placeholder (no src, no cost)
//  Loading is one-way (a loaded frame never unloads), so each scenario
//  reloads the page to re-evaluate from the persisted viewport.
// ════════════════════════════════════════════════════════════════════════
import { test, expect } from '@playwright/test';

const EMBED_URL = 'http://localhost:8123/tests/fixtures/embed.html';

async function addFrame(page, url) {
  await page.click('#addFrame');
  await expect(page.locator('#frame-modal')).toBeVisible();
  await page.fill('#frame-url', url);
  await page.click('#frame-add');
  await expect(page.locator('#frame-modal')).toBeHidden();
}

// pan by dispatching a wheel event (the app coalesces on rAF), then wait for
// the debounced local save so a reload comes back to this exact viewport
async function panBy(page, dx, dy) {
  await page.evaluate(([dx, dy]) => {
    document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel',
      { deltaX: dx, deltaY: dy, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
  }, [dx, dy]);
  await expect.poll(() => page.evaluate(() => {
    const k = Object.keys(localStorage).find((k) => k.startsWith('whiteboard:viewport:'));
    return k ? JSON.parse(localStorage.getItem(k)).x : 0;
  })).not.toBe(0);
}

const frameSrc = (page) =>
  page.locator('.node.iframe-node iframe').evaluate((f) => f.getAttribute('src'));

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
});
test.afterEach(() => expect(errors, 'no uncaught page errors').toEqual([]));

test('visible frame loads immediately; a far frame stays an unloaded placeholder', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const frame = page.locator('.node.iframe-node');
  await expect(frame.locator('iframe')).toHaveAttribute('src', EMBED_URL);   // visible → loads

  // pan three-plus viewports away and come back on a fresh page: the frame
  // must NOT load from way off screen
  const bb = await frame.boundingBox();
  await panBy(page, bb.x + bb.width + 1280 * 2 + 200, 0);
  await page.reload();
  await expect(page.locator('.node.iframe-node')).toHaveCount(1);
  await page.waitForTimeout(1200);              // give any (wrong) prefetch a chance to fire
  expect(await frameSrc(page)).toBeNull();
  await expect(page.locator('.frame-placeholder')).toHaveText(/click to load/);
});

test('panning a far frame into view loads it', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const bb = await page.locator('.node.iframe-node').boundingBox();
  const away = bb.x + bb.width + 1280 * 2 + 200;
  await panBy(page, away, 0);
  await page.reload();
  expect(await frameSrc(page)).toBeNull();

  // pan back: the frame crosses the near ring and then the viewport — it
  // must be loaded by the time the user is looking at it
  await panBy(page, -away, 0);
  await expect(page.locator('.node.iframe-node iframe')).toHaveAttribute('src', EMBED_URL);
});

test('near-ring frame prefetches in idle time while still off screen', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  const bb = await page.locator('.node.iframe-node').boundingBox();
  // park it just past the left edge: off screen, inside the one-viewport ring
  const away = bb.x + bb.width + 300;
  await panBy(page, away, 0);
  await page.reload();

  const frame = page.locator('.node.iframe-node');
  await expect(frame).toHaveCount(1);
  // still off screen…
  expect((await frame.boundingBox()).x + (await frame.boundingBox()).width).toBeLessThan(0);
  // …yet the idle prefetch fills it in
  await expect(frame.locator('iframe')).toHaveAttribute('src', EMBED_URL, { timeout: 8000 });
});

test('frames shrunk to a dot do not load even on screen; zooming in loads them', async ({ page }) => {
  await addFrame(page, EMBED_URL);
  // zoom far out around the frame so it drops under the min on-screen width
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) {
      document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel',
        { deltaY: 300, ctrlKey: true, clientX: 640, clientY: 360, bubbles: true, cancelable: true }));
    }
  });
  await expect.poll(() => page.evaluate(() => {
    const k = Object.keys(localStorage).find((k) => k.startsWith('whiteboard:viewport:'));
    return k ? JSON.parse(localStorage.getItem(k)).zoom : 1;
  })).toBeLessThan(0.2);
  await page.reload();
  await page.waitForTimeout(1200);
  expect(await frameSrc(page)).toBeNull();      // on screen, but a dot — not worth a page load

  // zoom back in: it crosses the threshold and loads
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) {
      document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel',
        { deltaY: -300, ctrlKey: true, clientX: 640, clientY: 360, bubbles: true, cancelable: true }));
    }
  });
  await expect(page.locator('.node.iframe-node iframe')).toHaveAttribute('src', EMBED_URL);
});
