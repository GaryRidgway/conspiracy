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
import { installErrorGuard, addCardAt } from './helpers.js';

const EMBED_URL = 'http://localhost:8123/tests/fixtures/embed.html';
// Autofocuses a field on load, like most real pages worth embedding do.
const GRABBY_URL = 'http://localhost:8123/tests/fixtures/grabby.html';

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

installErrorGuard(test);

test('visible frame loads immediately; a far frame stays an unloaded placeholder', { tag: '@frames' }, async ({ page }) => {
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

test('panning a far frame into view loads it', { tag: '@frames' }, async ({ page }) => {
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

test('near-ring frame prefetches in idle time while still off screen', { tag: '@frames' }, async ({ page }) => {
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

// The prefetch runs in idle time, which is exactly the pause between two
// keystrokes — and a page that autofocuses a field pulls focus into its own
// document as it loads. Unguarded, that took the caret out of the card the user
// was typing in, seconds after they stopped: "stop to think, lose your place".
test('the idle prefetch waits rather than steal the caret from a card', { tag: '@frames' }, async ({ page }) => {
  await addFrame(page, GRABBY_URL);
  const bb = await page.locator('.node.iframe-node').boundingBox();
  const away = bb.x + bb.width + 1280 * 2 + 200;
  await panBy(page, away, 0);
  await page.reload();
  expect(await frameSrc(page)).toBeNull();                  // far → placeholder

  const card = await addCardAt(page, 600, 400);
  await card.locator('.card-body').click();
  await page.keyboard.type('mid-sentence');
  // bring it back to 200px past the left edge: off screen, inside the near ring
  await panBy(page, -(away - bb.x - bb.width - 200), 0);
  const box = await page.locator('.node.iframe-node').boundingBox();
  expect(box.x + box.width).toBeLessThan(0);                // still off screen
  await page.waitForTimeout(2500);                          // idle: the prefetch would fire here
  await expect(card.locator('.card-body')).toBeFocused();
  expect(await frameSrc(page)).toBeNull();                  // held, because we're typing

  // held, not dropped — finish editing and it loads
  await page.mouse.click(1000, 650);
  await expect(page.locator('.node.iframe-node iframe')).toHaveAttribute('src', GRABBY_URL, { timeout: 8000 });
});

// ════════════════════════════════════════════════════════════════════════
//  NODE HYDRATION — cards/buttons/frames defer too: first paint renders
//  what's near the viewport, the rest materializes in idle chunks. Code
//  that needs the whole board (Tab, fit, search) flushes synchronously.
// ════════════════════════════════════════════════════════════════════════

// create a card via the palette and return its data-id (diff ids, never
// .last(): dock members render after #world, so .last() can miss the new one)
async function addCard(page) {
  const ids = () => page.evaluate(() => [...document.querySelectorAll('.node.card')].map((e) => e.dataset.id));
  const before = await ids();
  await page.click('#addCard');
  await page.keyboard.press('Escape');
  return (await ids()).find((i) => !before.includes(i));
}

// inject a card far outside the viewport straight into the stored board,
// with a connection from `fromId`, then reload so boot sees it. Must run as
// an init script: the app re-saves its in-memory board on pagehide, which
// would clobber a plain pre-reload localStorage write.
async function injectFarCard(page, fromId) {
  await page.addInitScript((fromId) => {
    const cur = localStorage.getItem('whiteboard:current');
    if (!cur) return;
    const key = 'whiteboard:board:' + cur;
    const b = JSON.parse(localStorage.getItem(key) || 'null');
    if (!b || b.cards.far_test) return;
    b.cards.far_test = { x: 6000, y: 6000, title: 'FarAway', body: 'far-needle' };
    b.connections.cn_far = { from: fromId, to: 'far_test' };
    b.version++;
    localStorage.setItem(key, JSON.stringify(b));
  }, fromId);
  await page.reload();
}

test('far-off-screen card hydrates in idle time; its arrow draws once both ends exist', { tag: '@frames' }, async ({ page }) => {
  const nearId = await addCard(page);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await injectFarCard(page, nearId);

  // the near card is in the first synchronous paint…
  await expect(page.locator(`.node.card[data-id="${nearId}"]`)).toHaveCount(1);
  // …the far one materializes from the idle queue without any interaction
  await expect(page.locator('.node.card[data-id="far_test"]')).toHaveCount(1, { timeout: 5000 });
  // and the connection that was waiting on it now has a real path
  await expect.poll(() => page.evaluate(() => {
    const line = document.querySelector('#connections .conn .line');
    return (line && line.getAttribute('d')) || '';
  })).toMatch(/^M/);
});

test('pending nodes stay reachable: Tab and fit-to-content flush hydration', { tag: '@frames' }, async ({ page }) => {
  // stub out idle callbacks so background hydration NEVER runs — deferral
  // becomes observable, and only the explicit flush paths can materialize
  await page.addInitScript(() => { window.requestIdleCallback = () => 0; });
  const nearId = await addCard(page);
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  await injectFarCard(page, nearId);

  const far = page.locator('.node.card[data-id="far_test"]');
  await expect(page.locator(`.node.card[data-id="${nearId}"]`)).toHaveCount(1);
  await page.waitForTimeout(400);
  await expect(far).toHaveCount(0);              // deferred, and idle is stubbed out

  // Tab cycles in reading order across the WHOLE board — near first, then far
  await page.keyboard.press('Tab');
  await expect(page.locator(`.node.card[data-id="${nearId}"]`)).toHaveClass(/selected/);
  await page.keyboard.press('Tab');
  await expect(far).toHaveCount(1);              // flushed into existence
  await expect(far).toHaveClass(/selected/);

  // fit-to-content frames everything, pending included
  await page.click('#fitContent');
  const vp = page.viewportSize();
  const bb = await far.boundingBox();
  expect(bb.x + bb.width > 0 && bb.x < vp.width && bb.y + bb.height > 0 && bb.y < vp.height).toBe(true);
});

test('frames shrunk to a dot do not load even on screen; zooming in loads them', { tag: '@frames' }, async ({ page }) => {
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

// ════════════════════════════════════════════════════════════════════════
//  FLY-TO HYDRATION CAP — a flight sweeping past a dense cluster must not
//  hydrate it all in one animation frame (visible hitch); promotePendingInView
//  spreads it across frames at HYDRATE_CHUNK while a flight is in progress.
// ════════════════════════════════════════════════════════════════════════

test('a flight caps per-frame hydration at HYDRATE_CHUNK instead of bursting', { tag: '@frames' }, async ({ page }) => {
  const HYDRATE_CHUNK = 24;
  await addCard(page);
  await panBy(page, 6000, 0);   // camera starts far from home; resetView flies it back

  // idle-time hydration (unrelated to flight) would otherwise drain the
  // cluster in the background before the flight even starts — stub it out so
  // only the flight's own promotion path can materialize these nodes
  await page.addInitScript(() => { window.requestIdleCallback = () => 0; });

  // cluster sits at the flight's midpoint (fastest part of the ease curve),
  // tight enough that the sweeping viewport crosses its near-view margin in
  // one frame — exactly the burst the cap has to spread out
  const { cx, cy } = await page.evaluate(() => ({ cx: innerWidth / 2, cy: innerHeight / 2 }));
  const clusterX = Math.round(cx + 3000);
  const clusterY = Math.round(cy);
  const N = 64;
  await page.addInitScript(([clusterX, clusterY, N]) => {
    const cur = localStorage.getItem('whiteboard:current');
    if (!cur) return;
    const key = 'whiteboard:board:' + cur;
    const b = JSON.parse(localStorage.getItem(key) || 'null');
    if (!b || b.cards.cluster_0) return;
    for (let i = 0; i < N; i++) {
      b.cards['cluster_' + i] = {
        x: clusterX + (i % 8) * 15, y: clusterY + Math.floor(i / 8) * 15, title: 'C' + i, body: '',
      };
    }
    b.version++;
    localStorage.setItem(key, JSON.stringify(b));
  }, [clusterX, clusterY, N]);
  await page.reload();
  await expect(page.locator('.node.card[data-id="cluster_0"]')).toHaveCount(0);   // pending: off screen, idle stubbed

  await page.click('#settingsBtn');
  await page.check('#setFlyTo');
  await page.keyboard.press('Escape');

  // sample the rendered card count every rAF across the whole flight
  const counts = await page.evaluate(() => new Promise((resolve) => {
    const samples = [];
    document.getElementById('resetView').click();
    const start = performance.now();
    const tick = () => {
      samples.push(document.querySelectorAll('.node.card').length);
      if (performance.now() - start < 1000) requestAnimationFrame(tick); else resolve(samples);
    };
    requestAnimationFrame(tick);
  }));
  const deltas = counts.slice(1).map((c, i) => c - counts[i]);
  expect(Math.max(...deltas)).toBeLessThanOrEqual(HYDRATE_CHUNK);
  expect(counts[counts.length - 1]).toBe(N + 1);   // all of it lands by the time the flight settles
});
