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
import { boardOf, cardRecord, merge, installErrorGuard } from './helpers.js';

installErrorGuard(test);

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

test('mergeBoards keeps local on a conflict but carries the other side as alt', { tag: '@boards' }, async ({ page }) => {
  const res = await merge(page,
    boardOf({ a: cardRecord('A', 'orig') }),
    boardOf({ a: cardRecord('A', 'mine') }),
    boardOf({ a: cardRecord('A', 'theirs') }));
  expect(res.conflicts).toBe(1);
  expect(res.merged.cards.a.body).toBe('mine');           // local wins, as ever
  expect(res.conflictItems[0].alt.body).toBe('theirs');   // …but the loser survives
  expect(res.conflictItems[0].keptSide).toBe('local');
});

test('delete-vs-edit: the alt is "apply the delete", and keptSide names the editor', { tag: '@boards' }, async ({ page }) => {
  const res = await merge(page,
    boardOf({ a: cardRecord('A', 'orig') }),
    boardOf({}),                            // this device deleted A
    boardOf({ a: cardRecord('A', 'edited') }));   // the other device edited it
  expect(res.conflicts).toBe(1);
  expect(res.merged.cards.a.body).toBe('edited');   // edit still wins the merge
  expect(res.conflictItems[0].alt).toBeUndefined(); // the alternative is the delete
  expect(res.conflictItems[0].keptSide).toBe('remote');
});

test('the panel flips a record to the other device and back, undoably', { tag: '@boards' }, async ({ page }) => {
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

test('a pull landing while the review panel is open closes it instead of letting a stale flip clobber it', { tag: '@boards' }, async ({ page }) => {
  const id = await addNamedCard(page, 'Alpha');
  const rec = await storedCard(page, id);
  await openReview(page, [{ coll: 'cards', id, label: 'Alpha', alt: { ...rec, title: 'Beta' }, keptSide: 'local' }]);

  const panel = page.locator('#merge-review');
  const title = page.locator(`.node.card[data-id="${id}"] .card-title`);
  await expect(panel).toBeVisible();

  // another sync tick lands a genuinely newer, unrelated edit while the panel
  // is still open — no new conflict, since only the remote side changed
  await page.evaluate(({ id, rec }) => {
    const content = JSON.parse(localStorage.getItem('whiteboard:board:' + localStorage.getItem('whiteboard:current')));
    content.cards[id] = { ...rec, title: 'Gamma' };
    content.version++;
    window.__wb_applyPulledBoard(localStorage.getItem('whiteboard:current'), content);
  }, { id, rec });
  await expect(title).toHaveText('Gamma');

  // the panel's kept/alt are now stale — clicking a choice must not apply
  // them over the newer content; it should just close instead
  await panel.locator('.mr-choice', { hasText: 'Other device' }).click();
  await expect(title).toHaveText('Gamma');
  await expect(panel).toBeHidden();
});

test('"use other device for all" applies every alt, deletes included — and deletes can be flipped back', { tag: '@boards' }, async ({ page }) => {
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

// The Drive conflict prompt only opens live from a sync round-trip (no OAuth
// in this suite), so __wb_openConflictModal exercises the same open() a real
// conflict would — covering the wireModal focus-restore fix directly.
test('conflict modal: Escape cancels and restores focus to the trigger', { tag: '@boards' }, async ({ page }) => {
  // the real prompt opens from a background sync, not a click — whatever had
  // focus beforehand is "the trigger" for restoreModalFocus's purposes
  await page.locator('#boardMenuBtn').focus();
  const result = page.evaluate(() => window.__wb_openConflictModal('Test Board'));
  await expect(page.locator('#conflict-modal')).toBeVisible();

  // a keyboard user engages the modal via the generic Tab trap — this is
  // what makes the bug reproduce: closing while focus is INSIDE the modal
  await page.keyboard.press('Tab');
  await expect(page.locator('#conflict-cancel')).toBeFocused();

  await page.keyboard.press('Escape');
  expect(await result).toBe('cancel');
  await expect(page.locator('#conflict-modal')).toBeHidden();
  await expect(page.locator('#boardMenuBtn')).toBeFocused();   // not dumped on <body>
});

test('conflict modal: clicking the backdrop cancels and restores focus', { tag: '@boards' }, async ({ page }) => {
  await page.locator('#boardMenuBtn').focus();
  const result = page.evaluate(() => window.__wb_openConflictModal('Test Board'));
  await expect(page.locator('#conflict-modal')).toBeVisible();

  // the overlay is full-viewport with the dialog centered — a corner click
  // always lands on the backdrop, never the dialog itself
  await page.locator('#conflict-modal').click({ position: { x: 5, y: 5 } });
  expect(await result).toBe('cancel');
  await expect(page.locator('#conflict-modal')).toBeHidden();
  await expect(page.locator('#boardMenuBtn')).toBeFocused();
});

// ════════════════════════════════════════════════════════════════════════
//  DOCKED-FRAME MEMBERSHIP IS SYNCED CONTENT
//  dockMembers is a plain field on a frame card, so it rides the existing
//  per-record/per-field merge with no special-casing: non-overlapping dock
//  changes on two devices both survive; the same frame docked differently
//  on both sides is an ordinary field conflict.
// ════════════════════════════════════════════════════════════════════════
function frameRecord(dockMembers) {
  const rec = { x: 0, y: 0, w: 400, h: 300, kind: 'frame', title: 'Frame' };
  if (dockMembers) rec.dockMembers = dockMembers;
  return rec;
}

test('docking two different frames on two devices both survive a merge', { tag: '@boards' }, async ({ page }) => {
  const res = await merge(page,
    boardOf({ fa: frameRecord(), fb: frameRecord() }),
    boardOf({ fa: frameRecord(['c1']), fb: frameRecord() }),      // this device docked A
    boardOf({ fa: frameRecord(), fb: frameRecord(['c2']) }));     // the other docked B
  expect(res.conflicts).toBe(0);
  expect(res.merged.cards.fa.dockMembers).toEqual(['c1']);
  expect(res.merged.cards.fb.dockMembers).toEqual(['c2']);
});

test('the same frame docked with different membership on both sides is a conflict', { tag: '@boards' }, async ({ page }) => {
  const res = await merge(page,
    boardOf({ fa: frameRecord() }),
    boardOf({ fa: frameRecord(['mine']) }),
    boardOf({ fa: frameRecord(['theirs']) }));
  expect(res.conflicts).toBe(1);
  expect(res.merged.cards.fa.dockMembers).toEqual(['mine']);       // local wins, as ever
  expect(res.conflictItems[0].alt.dockMembers).toEqual(['theirs']); // …but the loser survives
});

test('undocking on one device while the other only changes membership keeps the undock', { tag: '@boards' }, async ({ page }) => {
  const res = await merge(page,
    boardOf({ fa: frameRecord(['a']) }),
    boardOf({ fa: frameRecord() }),              // this device undocked (deleted the field)
    boardOf({ fa: frameRecord(['a', 'b']) }));   // the other device only added a member
  expect(res.conflicts).toBe(1);
  expect(res.merged.cards.fa.dockMembers).toBeUndefined();   // local delete wins the field conflict
  expect(res.conflictItems[0].alt.dockMembers).toEqual(['a', 'b']);
});
