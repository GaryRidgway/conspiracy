// ════════════════════════════════════════════════════════
//  OFFLINE SHELL
//  All of a user's data is already local (localStorage + IndexedDB); the only
//  thing that needed the network was the app itself. This caches the shell so
//  the whiteboard opens with no connection at all.
//
//  NETWORK-FIRST, cache as the fallback. Cache-first loads faster and is the
//  wrong trade here: `main` auto-deploys, so cache-first means every user runs
//  one deploy behind until the worker updates — and "an old client is holding a
//  board a newer one wrote" is the exact hazard app.js's schema guard exists to
//  contain. Network-first buys offline without ever serving stale code to an
//  online user, which also means NO update prompt and no skipWaiting: there is
//  nothing to hurry, because the page is already fresh whenever the network
//  answers. Its other payoff is that this file is a no-op online, so it cannot
//  change how the app behaves under test either.
//
//  Two things it deliberately does NOT touch:
//  - Anything cross-origin. Google's scripts and every Drive API call fall
//    straight through, so the network-clean guarantee and the auth flow can't
//    be affected by anything in here.
//  - Anything that isn't the shell. An embedded page is CONTENT, not shell:
//    intercepting it would put this worker in the middle of arbitrary iframes it
//    has no business caching.
// ════════════════════════════════════════════════════════
'use strict';

// Bumping this drops the old cache on activate. Forgetting to bump is SAFE:
// every successful online fetch refreshes its own entry, so a stale precache
// self-heals on the next connected load. The version only tidies up entries for
// files that no longer exist.
const CACHE = 'whiteboard-shell-v1';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './icons/add.svg',
  './icons/button.svg',
  './icons/card.svg',
  './icons/center_focus_strong.svg',
  './icons/check.svg',
  './icons/delete.svg',
  './icons/edit.svg',
  './icons/fit_screen.svg',
  './icons/format_bold.svg',
  './icons/format_italic.svg',
  './icons/format_list_bulleted.svg',
  './icons/format_list_numbered.svg',
  './icons/help.svg',
  './icons/image.svg',
  './icons/link.svg',
  './icons/redo.svg',
  './icons/remove.svg',
  './icons/settings.svg',
  './icons/tag.svg',
  './icons/undo.svg',
];

// Resolved against the worker's own location, so the same file works at the
// site root (the test server) and under /conspiracy/ (Pages) with no config.
const SHELL_URLS = new Set(SHELL.map((p) => new URL(p, self.location.href).href));

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One at a time rather than cache.addAll: addAll is all-or-nothing, so a
    // single missing icon would leave the worker permanently uninstalled and
    // the app with no offline at all. A gap is worth more than a cliff.
    await Promise.all(SHELL.map((p) =>
      cache.add(new Request(p, { cache: 'reload' })).catch(() => {})));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => (n === CACHE ? null : caches.delete(n))));
    // Control the page that registered us, so offline works on the FIRST visit
    // rather than only from the second load onward. Safe precisely because
    // network-first means taking control changes nothing while online.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;        // Drive, Google, embeds elsewhere
  // A TOP-LEVEL navigation is the app opening, so it's ours. An iframe is also
  // `mode: 'navigate'` — `destination` is the only thing that separates them,
  // and getting this wrong put the worker in the middle of every same-origin
  // embed on the board. Otherwise: the shell, and nothing else the board
  // happens to reference.
  const topLevelNav = req.mode === 'navigate' && req.destination === 'document';
  const isShell = SHELL_URLS.has(url.href.split('#')[0]);
  if (!topLevelNav && !isShell) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    // Only a real same-origin success is worth keeping. Caching an error or an
    // opaque response here would hand it back as the offline answer forever.
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    // A deep link (#board=…, ?anything) is still the app asking to start. Serve
    // the shell and let app.js read the board out of local storage, which is
    // where it lives anyway.
    if (req.mode === 'navigate' && req.destination === 'document') {
      const shell = await caches.match('./index.html', { ignoreSearch: true })
                 || await caches.match('./', { ignoreSearch: true });
      if (shell) return shell;
    }
    throw err;
  }
}
