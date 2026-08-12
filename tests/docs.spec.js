// ════════════════════════════════════════════════════════════════════════
//  DOCS
//  MAP.md and the ARCHITECTURE.md contents are generated from app.js, and a
//  generated file nobody regenerates is worse than none — it sends readers
//  confidently to the wrong place. The freshness check rides this suite
//  because the suite already gates every commit, whereas a git or editor
//  hook only fires on machines where someone installed it.
//
//  These tests need no browser; they read the repo off disk.
// ════════════════════════════════════════════════════════════════════════
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The repo root is where playwright.config.js sits. Asking the runner beats
// __dirname (only defined because specs are transpiled to CJS) or
// process.cwd() (whatever directory npm happened to be invoked from). NB
// config.rootDir is the testDir, not the repo root — configFile is the anchor.
const root = () => path.dirname(test.info().config.configFile);
const read = (f) => readFileSync(path.join(root(), f), 'utf8');

// app.js is one file on purpose, but "one file" is a decision to keep making,
// not a licence to grow forever. This trips well before the file becomes
// unnavigable so that splitting it is a deliberate choice with a diff
// attached, rather than something discovered years later. Raising the
// ceiling is a fine outcome — doing it silently is not.
const MAX_APP_LINES = 10_000;

test('MAP.md and the ARCHITECTURE.md contents are up to date', { tag: '@docs' }, () => {
  let out;
  try {
    out = execFileSync('node', ['tools/build-map.js', '--check'], {
      cwd: root(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // surface the generator's own message — it names the stale files and the fix
    throw new Error(`${err.stdout || ''}${err.stderr || ''}`.trim() || String(err));
  }
  expect(out).toContain('current');
});

test(`app.js stays under ${MAX_APP_LINES.toLocaleString()} lines`, { tag: '@docs' }, () => {
  const lines = read('app.js').split('\n').length;
  expect(
    lines,
    `app.js is ${lines.toLocaleString()} lines. Either split a section out, or raise ` +
      `MAX_APP_LINES here on purpose — the point is that crossing this is a decision.`
  ).toBeLessThanOrEqual(MAX_APP_LINES);
});

test('every ARCHITECTURE.md contents entry points at a real heading', { tag: '@docs' }, () => {
  const md = read('ARCHITECTURE.md');
  const toc = md.slice(md.indexOf('<!-- toc:start -->'), md.indexOf('<!-- toc:end -->'));
  const labels = [...toc.matchAll(/^\s*- \[(.+?)\]\(#/gm)].map((m) => m[1]);
  expect(labels.length).toBeGreaterThan(10);

  // compare on label text with code ticks stripped, the same way the TOC renders it
  const bodyHeadings = new Set(
    [...md.matchAll(/^#{2,3} +(.+?)\s*$/gm)].map((m) => m[1].replace(/`/g, ''))
  );
  for (const label of labels) expect(bodyHeadings).toContain(label);
});
