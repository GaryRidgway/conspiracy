// ════════════════════════════════════════════════════════════════════════
//  OFFLINE SHELL (sw.js)
//  Every byte of a user's work is already local — localStorage for board
//  content, IndexedDB for image bytes. The only thing that ever needed the
//  network was the app itself, which sw.js now caches.
//
//  The strategy is network-first, so the worker is a NO-OP whenever the network
//  answers. That is what makes it safe to have registered during the rest of the
//  suite, and it means the only behaviour worth testing here is the part that
//  differs: what happens with the network gone.
// ════════════════════════════════════════════════════════════════════════
import { test, expect } from '@playwright/test';
import { addCardAt, installErrorGuard } from './helpers.js';

installErrorGuard(test);

// The worker registers on `load`, so every test here waits for it to take
// control before cutting the network — otherwise it's testing a race.
async function awaitController(page) {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
}

test('the app boots with no network at all, and the board is still there', { tag: '@offline' }, async ({ page, context }) => {
  const node = await addCardAt(page, 400, 300);
  const id = await node.getAttribute('data-id');
  await page.locator(`[data-id="${id}"] .card-title`).dblclick();
  await page.keyboard.type('Written while online');
  await page.keyboard.press('Escape');
  await expect(page.locator('#saveState')).toHaveText('saved');
  await awaitController(page);

  await context.setOffline(true);
  await page.reload();

  // the shell came from cache…
  await expect(page.locator('#boardMenuBtn')).toBeVisible();
  await expect(page.locator('#tools')).toBeVisible();
  // …and the work came from localStorage, which never needed the network
  await expect(page.locator(`[data-id="${id}"] .card-title`)).toHaveText('Written while online');
  await context.setOffline(false);
});

test('edits made offline persist across an offline reload', { tag: '@offline' }, async ({ page, context }) => {
  await awaitController(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#boardMenuBtn')).toBeVisible();

  const node = await addCardAt(page, 420, 320);
  const id = await node.getAttribute('data-id');
  await page.locator(`[data-id="${id}"] .card-title`).dblclick();
  await page.keyboard.type('Written offline');
  await page.keyboard.press('Escape');
  await expect(page.locator('#saveState')).toHaveText('saved');

  await page.reload();
  await expect(page.locator(`[data-id="${id}"] .card-title`)).toHaveText('Written offline');
  await context.setOffline(false);
});

// Styling and icons are part of "the app opened", not a nice-to-have: a shell
// that boots unstyled reads as broken, which is worse than an honest failure.
test('the offline shell brings its stylesheet and icons with it', { tag: '@offline' }, async ({ page, context }) => {
  await awaitController(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#boardMenuBtn')).toBeVisible();

  // a real rule from styles.css applied, not the browser default
  const positioned = await page.evaluate(() =>
    getComputedStyle(document.getElementById('viewport')).position);
  expect(positioned).toBe('fixed');
  // and an icon mask resolved rather than 404ing
  const iconOk = await page.evaluate(async () => {
    const res = await fetch('icons/undo.svg');
    return res.ok && (await res.text()).includes('<svg');
  });
  expect(iconOk).toBe(true);
  await context.setOffline(false);
});

// Network-first is the load-bearing choice: `main` auto-deploys, and a
// cache-first worker would pin every user one deploy behind until it updated.
// A connected user must always get what the server currently holds.
//
// Proved by planting a stale entry in the worker's own cache and asking for the
// file online: cache-first would hand back the plant. (page.route can't be used
// for this — it doesn't intercept fetches the worker itself makes, which is
// exactly the request under test.)
test('an online load takes the network copy, never a stale cached one', { tag: '@offline' }, async ({ page }) => {
  await awaitController(page);
  const planted = await page.evaluate(async () => {
    const c = await caches.open('whiteboard-shell-v1');
    await c.put(new Request(new URL('styles.css', location.href).href),
      new Response('/* STALE PLANT */', { headers: { 'content-type': 'text/css' } }));
    return (await (await c.match(new URL('styles.css', location.href).href)).text());
  });
  expect(planted).toContain('STALE PLANT');            // the plant really is in the cache

  const served = await page.evaluate(async () => (await fetch('styles.css')).text());
  expect(served).not.toContain('STALE PLANT');
  expect(served).toContain('#viewport');               // the real stylesheet

  // and the fresh copy replaced the plant, so a later offline load isn't stale
  const afterwards = await page.evaluate(async () => {
    const c = await caches.open('whiteboard-shell-v1');
    const hit = await c.match(new URL('styles.css', location.href).href);
    return hit ? hit.text() : null;
  });
  expect(afterwards).not.toContain('STALE PLANT');
});

// The worker must stay out of the way of everything that isn't the shell.
// Cross-origin is the sharp case — Drive and Google's token flow go through it,
// and an offline-shell bug that swallowed those would be a Drive outage.
test('the worker does not intercept cross-origin or embedded content', { tag: '@offline' }, async ({ page, context }) => {
  await awaitController(page);

  // An IFRAME is the case that matters and the one that's easy to get wrong: it
  // is `mode: 'navigate'` just like the app opening, and only `destination`
  // separates the two. Testing this with fetch() proves nothing — fetch is mode
  // 'cors', so it misses the branch entirely, and an earlier version of this
  // test passed while every same-origin embed on the board was being
  // intercepted. Route the request to prove it reached the NETWORK layer, which
  // is exactly what a worker answering it would have prevented.
  let served = 0;
  await page.route('**/tests/fixtures/embed.html', (route) => {
    served++;
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>routed</p>' });
  });
  await page.evaluate(() => new Promise((res) => {
    const f = document.createElement('iframe');
    f.src = 'tests/fixtures/embed.html';
    f.onload = res; f.onerror = res;
    document.body.appendChild(f);
  }));
  expect(served).toBe(1);

  // and a cross-origin request is refused by the network, not answered by us
  await context.setOffline(true);
  const crossOrigin = await page.evaluate(async () => {
    try { await fetch('https://accounts.google.com/gsi/client', { mode: 'no-cors' }); return 'answered'; }
    catch (e) { return 'failed'; }
  });
  expect(crossOrigin).toBe('failed');
  await context.setOffline(false);
});
