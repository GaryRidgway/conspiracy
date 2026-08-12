#!/usr/bin/env node
'use strict';
// ════════════════════════════════════════════════════════
//  BUILD MAP — regenerates MAP.md and the ARCHITECTURE.md
//  table of contents.
//
//    node tools/build-map.js           write both
//    node tools/build-map.js --check   exit 1 if either is stale
//
//  --check is what tests/docs.spec.js runs, so the freshness
//  guarantee rides the suite that already gates every commit
//  instead of a hook that only fires where it is installed.
// ════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const {
  sections,
  markerProblems,
  renderMap,
  headings,
  renderToc,
  injectToc,
} = require('./extract.js');

const ROOT = path.join(__dirname, '..');
const at = (f) => path.join(ROOT, f);
const read = (f) => fs.readFileSync(at(f), 'utf8');

function build() {
  const app = read('app.js');
  const secs = sections(app);
  if (!secs.length) throw new Error('found no section banners in app.js — has the banner style changed?');

  const problems = markerProblems(app, secs);
  if (problems.length) {
    throw new Error(
      'app.js section markers are ambiguous, so MAP.md could not point at them:\n' +
        problems.map((p) => `  - ${p}`).join('\n')
    );
  }

  const arch = read('ARCHITECTURE.md');
  return {
    count: secs.length,
    files: {
      'MAP.md': renderMap(secs),
      'ARCHITECTURE.md': injectToc(arch, renderToc(headings(arch))),
    },
  };
}

function main() {
  const check = process.argv.includes('--check');

  let built;
  try {
    built = build();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  const stale = Object.entries(built.files).filter(([f, want]) => {
    const have = fs.existsSync(at(f)) ? read(f) : null;
    return have !== want;
  });

  if (check) {
    if (!stale.length) {
      console.log(`✓ MAP.md and the ARCHITECTURE.md contents are current (${built.count} sections)`);
      return;
    }
    console.error(
      `✗ stale generated docs: ${stale.map(([f]) => f).join(', ')}\n` +
        '  app.js sections changed without the docs being rebuilt. Run:\n' +
        '      npm run map'
    );
    process.exit(1);
  }

  if (!stale.length) {
    console.log(`✓ already current (${built.count} sections) — nothing written`);
    return;
  }
  for (const [f, want] of stale) {
    fs.writeFileSync(at(f), want);
    console.log(`wrote ${f}`);
  }
  console.log(`✓ ${built.count} sections mapped`);
}

main();
