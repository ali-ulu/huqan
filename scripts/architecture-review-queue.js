#!/usr/bin/env node
'use strict';

/**
 * Deterministic hourly architecture-debt review queue (#2924).
 *
 * The tracker artifact (`docs/generated/architecture-trackers.md`) already
 * measures the debt; it does not record which item has been read. Picking
 * the next file by hand makes the order a judgement call -- two reviewers
 * can cover the same file while another sits unread, and nothing records
 * that a file was reviewed. This derives a single, stable order from the
 * same counters the gates enforce and tracks progress against it locally.
 *
 * Order:
 *   1. decomposition owed (> 800 lines)   -- the tracker's first table
 *   2. recorded debt (401-800 lines)      -- the tracker's second table
 *   3. a structural signal at an accepted size -- the tracker's third table
 *   4. layer exceptions                   -- scripts/check-layers.js ALLOWED
 * Inside bands 1-3: larger files first, then path ascending -- total and
 * stable. Band 4 is ordered soonest review date first, because each
 * exception carries a date after which the gate itself fails.
 *
 * `--check` re-parses the committed tracker artifact directly (its own
 * markdown-table parser, not the generator's data structures) and fails
 * when it disagrees with the live snapshot. Deriving the queue from
 * `scripts/architecture-snapshot.js` alone would be enough for the queue to
 * work; parsing the artifact text as well is what makes "fed by this file"
 * a checked statement rather than a comment.
 *
 * No background automation is added here: this prints and tracks a queue.
 * Scheduling the hourly review stays with whoever starts it.
 *
 * Usage:
 *   node scripts/architecture-review-queue.js
 *   node scripts/architecture-review-queue.js --next
 *   node scripts/architecture-review-queue.js --json
 *   node scripts/architecture-review-queue.js --done=<key>
 *   node scripts/architecture-review-queue.js --reset
 *   node scripts/architecture-review-queue.js --check
 */

const fs = require('fs');
const path = require('path');
const { snapshot, classify, TRACKER_PATH } = require('./architecture-snapshot');
const { ALLOWED: LAYER_EXCEPTIONS } = require('./check-layers');

const repoRoot = path.resolve(__dirname, '..');
const STATE_PATH = path.join(repoRoot, '.architecture-review-queue-state.json');

const TRACKED_BANDS = ['decompose', 'recorded', 'structural'];

const BAND_LABEL = {
  decompose: 'decomposition owed, over 800 lines',
  recorded: 'recorded debt, 401-800 lines',
  structural: 'at or under 400 lines, tracked for a signal',
  exception: 'layer exception',
};

function byLinesDescPathAsc(a, b) {
  if (b.lines !== a.lines) return b.lines - a.lines;
  if (a.file < b.file) return -1;
  if (a.file > b.file) return 1;
  return 0;
}

function byReviewDateAsc(a, b) {
  if (a.review_by < b.review_by) return -1;
  if (a.review_by > b.review_by) return 1;
  return 0;
}

/** The queue itself: tracked bands in order, each internally sorted, then
 *  layer exceptions last. `groups` defaults to the live tree so callers
 *  exercising a fixture can pass their own. */
function buildQueue(groups = classify(snapshot()), exceptions = LAYER_EXCEPTIONS) {
  const entries = [];
  for (const band of TRACKED_BANDS) {
    for (const row of [...groups[band]].sort(byLinesDescPathAsc)) {
      entries.push({
        key: row.file, band, file: row.file, lines: row.lines, signals: [...row.signals],
      });
    }
  }
  for (const entry of [...exceptions].sort(byReviewDateAsc)) {
    entries.push({
      key: `${entry.from} -> ${entry.to}`,
      band: 'exception',
      from: entry.from,
      to: entry.to,
      why: entry.why,
      review_by: entry.review_by,
    });
  }
  return entries;
}

// -- parsing the committed artifact directly, for --check -------------------

function splitSections(markdown) {
  const sections = {};
  for (const part of markdown.split(/\n(?=## )/)) {
    const title = part.match(/^## (.+)$/m);
    if (title) sections[title[1]] = part;
  }
  return sections;
}

function parseTableRows(sectionText) {
  const rows = [];
  for (const line of sectionText.split('\n')) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\|$/);
    if (!match) continue;
    rows.push({ file: match[1], lines: Number(match[2]), signals: match[3] === '—' ? [] : match[3].split(/\s+/) });
  }
  return rows;
}

function findSection(sections, prefix) {
  const title = Object.keys(sections).find((candidate) => candidate.startsWith(prefix));
  return title ? parseTableRows(sections[title]) : [];
}

/** Independent of `architecture-snapshot.js`'s own renderer: this reads the
 *  markdown text the way a person would, so a generator bug that produces
 *  wrong markdown but a self-consistent data structure cannot hide from it. */
function parseTrackerArtifact(markdown) {
  const sections = splitSections(markdown);
  return {
    decompose: findSection(sections, 'Decomposition owed'),
    recorded: findSection(sections, 'Recorded debt'),
    structural: findSection(sections, 'At or under'),
  };
}

function bandFingerprint(rows) {
  return rows
    .map((row) => `${row.file}:${row.lines}:${[...row.signals].sort().join(',')}`)
    .sort();
}

/** Bands that disagree between the live snapshot and the parsed artifact,
 *  empty when they agree. Order-independent: only membership and per-file
 *  lines/signals are compared, because the artifact's own row order is not
 *  the queue's order. */
function disagreeingBands(liveGroups, parsedGroups) {
  return TRACKED_BANDS.filter((band) => {
    const live = JSON.stringify(bandFingerprint(liveGroups[band]));
    const parsed = JSON.stringify(bandFingerprint(parsedGroups[band] || []));
    return live !== parsed;
  });
}

// -- local, gitignored progress state ---------------------------------------

function readState(statePath = STATE_PATH) {
  if (!fs.existsSync(statePath)) return { done: {} };
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return parsed && typeof parsed.done === 'object' && parsed.done !== null ? parsed : { done: {} };
}

function writeState(state, statePath = STATE_PATH) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function formatEntry(entry) {
  if (entry.band === 'exception') {
    return `${BAND_LABEL.exception}, due ${entry.review_by}: ${entry.from} -> ${entry.to} -- ${entry.why}`;
  }
  const signals = entry.signals.length > 0 ? ` [${entry.signals.join(' ')}]` : '';
  return `${BAND_LABEL[entry.band]}: ${entry.file} (${entry.lines} lines)${signals}`;
}

function optionValue(argv, name) {
  const arg = argv.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.slice(arg.indexOf('=') + 1) : null;
}

function main(argv = process.argv.slice(2)) {
  const statePath = optionValue(argv, '--state') || STATE_PATH;

  const checkArg = argv.find((arg) => arg === '--check' || arg.startsWith('--check='));
  if (checkArg) {
    const trackerPath = checkArg.includes('=') ? path.resolve(checkArg.slice(checkArg.indexOf('=') + 1)) : TRACKER_PATH;
    const markdown = fs.existsSync(trackerPath) ? fs.readFileSync(trackerPath, 'utf8') : '';
    const liveGroups = classify(snapshot());
    const mismatched = disagreeingBands(liveGroups, parseTrackerArtifact(markdown));
    if (mismatched.length > 0) {
      console.error(
        `Architecture review queue disagrees with ${path.relative(repoRoot, trackerPath)} in band(s): ${mismatched.join(', ')}.`,
      );
      console.error('Regenerate it with `npm run arch:snapshot -- --write` before trusting the queue.');
      return 1;
    }
    console.log(`OK: review queue agrees with the committed tracker artifact (${buildQueue(liveGroups).length} entries).`);
    return 0;
  }

  const queue = buildQueue();

  const doneKey = optionValue(argv, '--done');
  if (doneKey !== null) {
    const match = queue.find((entry) => entry.key === doneKey);
    if (!match) {
      console.error(`Unknown queue key: ${doneKey}`);
      return 1;
    }
    const state = readState(statePath);
    state.done[doneKey] = { at: new Date().toISOString() };
    writeState(state, statePath);
    console.log(`Marked done: ${doneKey}`);
    return 0;
  }

  if (argv.includes('--reset')) {
    writeState({ done: {} }, statePath);
    console.log('Review queue progress reset.');
    return 0;
  }

  const state = readState(statePath);
  const pending = queue.filter((entry) => !state.done[entry.key]);

  if (argv.includes('--next')) {
    if (pending.length === 0) {
      console.log('Queue empty: every tracked item and layer exception has been reviewed.');
      return 0;
    }
    console.log(formatEntry(pending[0]));
    return 0;
  }

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ queue, done: Object.keys(state.done) }, null, 2)}\n`);
    return 0;
  }

  queue.forEach((entry, index) => {
    const mark = state.done[entry.key] ? 'x' : ' ';
    console.log(`[${mark}] ${index + 1}. ${formatEntry(entry)}`);
  });
  console.log(`\n${pending.length} of ${queue.length} remaining.`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  STATE_PATH,
  TRACKED_BANDS,
  BAND_LABEL,
  byLinesDescPathAsc,
  byReviewDateAsc,
  buildQueue,
  parseTrackerArtifact,
  disagreeingBands,
  readState,
  writeState,
  formatEntry,
};
