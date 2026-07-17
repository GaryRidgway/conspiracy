// ════════════════════════════════════════════════════════════════════════
//  SHARED TEST HELPERS
//  Low-level building blocks used by more than one spec file. Helpers used
//  by only a single spec stay local to that file — this is for things that
//  must change together, not a dumping ground.
// ════════════════════════════════════════════════════════════════════════

export async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

// find the NEW card by diffing ids — never .last(): dock members live in
// #dock-world, which comes after #world in the document, so document-order
// locators grab a panel member instead of the just-created card
export async function addCardAt(page, x, y) {
  const ids = () => page.evaluate(() => [...document.querySelectorAll('.node.card')].map((e) => e.dataset.id));
  const before = await ids();
  await page.click('#addCard');
  await page.keyboard.press('Escape');
  const id = (await ids()).find((i) => !before.includes(i));
  const node = page.locator(`.node.card[data-id="${id}"]`);
  const bb = await node.boundingBox();
  const hb = await node.locator('.card-header').boundingBox();
  const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  const gx = hb.x + 24, gy = hb.y + hb.height / 2;
  await drag(page, { x: gx, y: gy }, { x: gx + (x - cx), y: gy + (y - cy) });
  return node;
}

export const worldScale = (page) => page.evaluate(() => {
  const m = document.getElementById('world').style.transform.match(/scale\(([^)]+)\)/);
  return m ? parseFloat(m[1]) : 1;
});

// Model position, not boundingBox: right after a drop the node can still be
// mid :active scale, which shifts its client rect by a couple of pixels.
export const nodePos = (loc) => loc.evaluate((el) => ({
  x: parseFloat(el.style.left), y: parseFloat(el.style.top),
  w: el.offsetWidth, h: el.offsetHeight,
}));

// ── three-way merge test fixtures ──
export const boardOf = (cards) => ({ schema: 1, version: 1, viewport: { x: 0, y: 0, zoom: 1 }, cards, iframes: {}, connections: {} });

// a positioned card record — for drag/attach/detach and merge-position tests
export function cardRecordAt(x, y, title, body) { return { x, y, title: title || '', body: body || '' }; }
// a minimal card record at the origin — for merge-review's conflict tests
export function cardRecord(title, body) { return { x: 0, y: 0, title, body: body || '' }; }

export const merge = (page, base, local, remote) =>
  page.evaluate(([b, l, r]) => window.__wb_mergeBoards(b, l, r), [base, local, remote]);
