// Benchmark: what does a keystroke actually cost on a large board?
//
// Backs the numbers in ARCHITECTURE.md -> Deferred optimizations. That entry
// used to justify itself with "several MB on a board with pasted images", which
// stopped being true when image bytes moved to IndexedDB — so it is measured
// now rather than asserted. Not part of `npm test`: it needs the dev server on
// :8123 and takes ~30s. Run it before re-litigating the snapshot cost, and
// again if board content ever leaves localStorage (that lifts the ceiling which
// is the only reason these numbers are bounded).
//
//   python3 -m http.server 8123 &   # or leave `npm test` running
//   node tools/bench-commit.mjs
//
// Three things, per board size:
//   snapshot  — JSON.stringify of the three collections (contentSnapshot)
//   save      — that stringify plus the localStorage write (the 400ms debounce)
//   keystroke — the app's own synchronous work per typed character, end to end:
//               input handler → commit → layout passes → recordUndo → snapshot
import { chromium } from '@playwright/test';

// up to the practical ceiling: localStorage gives ~5MB, so a board much
// past 12k cards of this shape cannot be stored at all.
const SIZES = [200, 1000, 2000, 5000, 12000];
const BASE = process.env.BENCH_URL || 'http://localhost:8123';

// A realistic card: a title, a rich-text body with markup, a colour, a position.
const bodyHtml = (i) =>
  `<div>Note ${i}: this is roughly what a real card body looks like once ` +
  `someone has typed into it for a while.</div><div><b>Follow up</b> with ` +
  `<i>the other team</i> about item ${i}.</div><ul><li>first point</li>` +
  `<li>second point</li><li>third, slightly longer point about item ${i}</li></ul>`;

function makeBoard(n) {
  const cards = {}, connections = {};
  for (let i = 0; i < n; i++) {
    const id = 'c_bench' + i;
    cards[id] = {
      x: (i % 40) * 260, y: Math.floor(i / 40) * 200,
      title: 'Card ' + i, body: bodyHtml(i),
      color: ['', 'amber', 'rose', 'teal'][i % 4] || undefined,
    };
    if (!cards[id].color) delete cards[id].color;
    if (i > 0) connections['cn_bench' + i] = { from: 'c_bench' + (i - 1), to: id };
  }
  return { schema: 1, version: 1, cards, iframes: {}, connections };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const browser = await chromium.launch();
const rows = [];

for (const n of SIZES) {
  const board = makeBoard(n);
  const json = JSON.stringify(board);
  const ctx = await browser.newContext();
  await ctx.addInitScript(([raw]) => {
    const id = 'b_bench';
    localStorage.setItem('whiteboard:library', JSON.stringify([{ id, name: 'Bench', mode: 'device', updatedAt: Date.now() }]));
    localStorage.setItem('whiteboard:current', id);
    localStorage.setItem('whiteboard:board:' + id, raw);
    localStorage.setItem('whiteboard:settings', '{"flyTo":false}');
  }, [json]);

  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.waitForSelector('#boardMenuBtn');
  await page.waitForSelector('.node.card');

  const res = await page.evaluate(() => {
    const raw = localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current'));
    const content = JSON.parse(raw);
    // exactly what contentSnapshot() serializes
    const three = { cards: content.cards, iframes: content.iframes, connections: content.connections };

    const time = (fn, reps) => {
      for (let i = 0; i < 3; i++) fn();               // warm
      const runs = [];
      for (let i = 0; i < reps; i++) { const t = performance.now(); fn(); runs.push(performance.now() - t); }
      return runs;
    };

    const snapshot = time(() => JSON.stringify(three), 25);
    // Overwrite the SAME key, as the real save does — writing a second copy
    // doubles the board's footprint and blows the ~5MB quota on a big board.
    const key = 'whiteboard:board:' + localStorage.getItem('whiteboard:current');
    const save = time(() => localStorage.setItem(key, JSON.stringify(content)), 25);

    // End-to-end keystroke: drive the app's own input path on a rendered card.
    // This is the number that decides whether typing janks — it includes
    // commit()'s layout/derivation passes, not just the snapshot.
    const el = document.querySelector('.node.card .card-body');
    el.focus();
    // Sanity: prove the dispatch really reaches commit() before believing any
    // timing off it. A silent no-op would read as "typing is free".
    const saveEl = document.getElementById('saveState');
    saveEl.className = 'save saved';
    el.append(document.createTextNode('!'));
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const committed = /dirty/.test(saveEl.className);
    const keystroke = [];
    for (let i = 0; i < 40; i++) {
      el.append(document.createTextNode('x'));
      const t = performance.now();
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      keystroke.push(performance.now() - t);
    }
    return { bytes: raw.length, snapshot, save, keystroke, committed };
  });

  if (!res.committed) throw new Error('input dispatch did not reach commit() — timings would be meaningless');
  rows.push({
    n,
    mb: (res.bytes / 1048576).toFixed(2),
    snapshot: median(res.snapshot),
    snapshotMax: Math.max(...res.snapshot),
    save: median(res.save),
    key: median(res.keystroke),
    keyMax: Math.max(...res.keystroke),
  });
  await ctx.close();
}

await browser.close();

console.log('\ncards | board MB | snapshot ms | save ms | keystroke ms (median / worst)');
console.log('------+----------+-------------+---------+------------------------------');
for (const r of rows) {
  console.log(
    String(r.n).padStart(5) + ' | ' + r.mb.padStart(8) + ' | ' +
    (r.snapshot.toFixed(2) + ' (' + r.snapshotMax.toFixed(2) + ')').padStart(11) + ' | ' +
    r.save.toFixed(2).padStart(7) + ' | ' +
    r.key.toFixed(2) + ' / ' + r.keyMax.toFixed(2));
}
console.log('\n60fps budget is 16.7ms per frame.\n');
