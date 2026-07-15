// ════════════════════════════════════════════════════════════════════════
//  MERGE REVIEW
//  On a true conflict the three-way merge keeps this device's version, but it
//  now also carries the other side's version per conflicted record
//  (conflictItems[].alt) — and the review panel (the merge notice's "Review")
//  can flip any record between the two after the fact. The data path is pure
//  (__wb_mergeBoards); the apply path is driven through __wb_openMergeReview.
//  Neither needs OAuth/Drive.
// ════════════════════════════════════════════════════════════════════════
import { test, expect } from '@playwright/test';

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
});
test.afterEach(() => expect(errors, 'no uncaught page errors').toEqual([]));

const boardOf = (cards) => ({ schema: 1, version: 1, viewport: { x: 0, y: 0, zoom: 1 }, cards, iframes: {}, connections: {} });
const card = (title, body) => ({ x: 0, y: 0, title, body: body || '' });
const merge = (page, b, l, r) =>
  page.evaluate(([b, l, r]) => window.__wb_mergeBoards(b, l, r), [b, l, r]);

// create a titled card and return its data-id
async function addNamedCard(page, title) {
  await page.click('#addCard');
  await page.keyboard.type(title);
  await page.keyboard.press('Escape');
  const id = await page.locator('.node.card').last().getAttribute('data-id');
  await expect(page.locator('#saveState')).toHaveText(/saved/i);
  return id;
}
// open the review panel against the live board via the test hook
function openReview(page, items) {
  return page.evaluate((items) => window.__wb_openMergeReview(items), items);
}
const storedCard = (page, id) => page.evaluate((id) => {
  const b = JSON.parse(localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current')));
  return b.cards[id];
}, id);

test('mergeBoards keeps local on a conflict but carries the other side as alt', async ({ page }) => {
  const res = await merge(page,
    boardOf({ a: card('A', 'orig') }),
    boardOf({ a: card('A', 'mine') }),
    boardOf({ a: card('A', 'theirs') }));
  expect(res.conflicts).toBe(1);
  expect(res.merged.cards.a.body).toBe('mine');           // local wins, as ever
  expect(res.conflictItems[0].alt.body).toBe('theirs');   // …but the loser survives
  expect(res.conflictItems[0].keptSide).toBe('local');
});

test('delete-vs-edit: the alt is "apply the delete", and keptSide names the editor', async ({ page }) => {
  const res = await merge(page,
    boardOf({ a: card('A', 'orig') }),
    boardOf({}),                            // this device deleted A
    boardOf({ a: card('A', 'edited') }));   // the other device edited it
  expect(res.conflicts).toBe(1);
  expect(res.merged.cards.a.body).toBe('edited');   // edit still wins the merge
  expect(res.conflictItems[0].alt).toBeUndefined(); // the alternative is the delete
  expect(res.conflictItems[0].keptSide).toBe('remote');
});

test('the panel flips a record to the other device and back, undoably', async ({ page }) => {
  const id = await addNamedCard(page, 'Alpha');
  const rec = await storedCard(page, id);
  await openReview(page, [{ coll: 'cards', id, label: 'Alpha', alt: { ...rec, title: 'Beta' }, keptSide: 'local' }]);

  const panel = page.locator('#merge-review');
  const title = page.locator(`.node.card[data-id="${id}"] .card-title`);
  await expect(panel).toBeVisible();

  await panel.locator('.mr-choice', { hasText: 'Other device' }).click();
  await expect(title).toHaveText('Beta');
  await expect(panel.locator('.mr-choice', { hasText: 'Other device' })).toHaveClass(/active/);

  await panel.locator('.mr-choice', { hasText: 'This device' }).click();
  await expect(title).toHaveText('Alpha');

  // each flip is a plain content commit — reversible through normal undo
  await panel.locator('.mr-choice', { hasText: 'Other device' }).click();
  await expect(title).toHaveText('Beta');
  await page.keyboard.press('Escape');                      // close the panel
  await expect(panel).toBeHidden();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(title).toHaveText('Alpha');
});

test('"use other device for all" applies every alt, deletes included — and deletes can be flipped back', async ({ page }) => {
  const idA = await addNamedCard(page, 'Alpha');
  const idB = await addNamedCard(page, 'Gamma');
  const recA = await storedCard(page, idA);
  await openReview(page, [
    { coll: 'cards', id: idA, label: 'Alpha', alt: { ...recA, title: 'Beta' }, keptSide: 'local' },
    { coll: 'cards', id: idB, label: 'Gamma', keptSide: 'local' },   // no alt = other side deleted it
  ]);

  await page.locator('#merge-review .mr-all').click();
  await expect(page.locator(`.node.card[data-id="${idA}"] .card-title`)).toHaveText('Beta');
  await expect(page.locator(`.node.card[data-id="${idB}"]`)).toHaveCount(0);   // delete applied

  // the panel still holds the kept version: flip the delete back
  await page.locator('#merge-review .mr-row').nth(1).locator('.mr-choice', { hasText: 'This device' }).click();
  await expect(page.locator(`.node.card[data-id="${idB}"]`)).toHaveCount(1);
  await expect(page.locator(`.node.card[data-id="${idB}"] .card-title`)).toHaveText('Gamma');
});
