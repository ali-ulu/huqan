'use strict';

/**
 * #2924: the hourly review queue must derive a single stable order from the
 * tracker artifact and layer exceptions, and its `--check` must be able to
 * catch the artifact and the live tree disagreeing.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { renderMarkdown, TRACKER_PATH } = require('../scripts/architecture-snapshot');
const {
  buildQueue,
  parseTrackerArtifact,
  disagreeingBands,
  readState,
  writeState,
  formatEntry,
} = require('../scripts/architecture-review-queue');

const SCRIPT_PATH = path.resolve(__dirname, '../scripts/architecture-review-queue.js');

const FIXTURE_GROUPS = {
  decompose: [
    { file: 'kernel.js', lines: 855, signals: ['FANOUT:39'] },
    { file: 'z-bigger.js', lines: 900, signals: [] },
  ],
  recorded: [
    { file: 'a.js', lines: 500, signals: [] },
    { file: 'b.js', lines: 500, signals: [] },
  ],
  structural: [
    { file: 'graph.js', lines: 392, signals: ['FANOUT:31'] },
  ],
};

const FIXTURE_EXCEPTIONS = [
  { from: 'x.js', to: 'y.js', why: 'later', review_by: '2026-12-31' },
  { from: 'p.js', to: 'q.js', why: 'sooner', review_by: '2026-10-01' },
];

test('bands come in decompose, recorded, structural, exception order', () => {
  const queue = buildQueue(FIXTURE_GROUPS, FIXTURE_EXCEPTIONS);
  assert.deepEqual(queue.map((entry) => entry.band), [
    'decompose', 'decompose', 'recorded', 'recorded', 'structural', 'exception', 'exception',
  ]);
});

test('inside a band, larger files come first, then path ascending', () => {
  const queue = buildQueue(FIXTURE_GROUPS, []);
  assert.deepEqual(queue.filter((e) => e.band === 'decompose').map((e) => e.file), ['z-bigger.js', 'kernel.js']);
  assert.deepEqual(queue.filter((e) => e.band === 'recorded').map((e) => e.file), ['a.js', 'b.js']);
});

test('layer exceptions are ordered soonest review date first', () => {
  const queue = buildQueue({ decompose: [], recorded: [], structural: [] }, FIXTURE_EXCEPTIONS);
  assert.deepEqual(queue.map((entry) => entry.key), ['p.js -> q.js', 'x.js -> y.js']);
});

test('the queue is total and stable: every entry has a unique key', () => {
  const queue = buildQueue(FIXTURE_GROUPS, FIXTURE_EXCEPTIONS);
  const keys = queue.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('parseTrackerArtifact reads back what renderMarkdown wrote', () => {
  const markdown = renderMarkdown(FIXTURE_GROUPS);
  const parsed = parseTrackerArtifact(markdown);
  assert.deepEqual(parsed.decompose.map((r) => r.file).sort(), ['kernel.js', 'z-bigger.js']);
  assert.deepEqual(parsed.recorded.map((r) => r.file).sort(), ['a.js', 'b.js']);
  assert.deepEqual(parsed.structural[0], { file: 'graph.js', lines: 392, signals: ['FANOUT:31'] });
});

test('disagreeingBands is empty when the artifact matches the live groups', () => {
  const markdown = renderMarkdown(FIXTURE_GROUPS);
  assert.deepEqual(disagreeingBands(FIXTURE_GROUPS, parseTrackerArtifact(markdown)), []);
});

test('disagreeingBands names a band that drifted from the artifact', () => {
  const markdown = renderMarkdown(FIXTURE_GROUPS);
  const parsed = parseTrackerArtifact(markdown);
  const mutated = { ...FIXTURE_GROUPS, recorded: [...FIXTURE_GROUPS.recorded, { file: 'c.js', lines: 450, signals: [] }] };
  assert.deepEqual(disagreeingBands(mutated, parsed), ['recorded']);
});

test('the committed tracker artifact agrees with the real queue derivation', () => {
  const { classify, snapshot } = require('../scripts/architecture-snapshot');
  const markdown = fs.readFileSync(TRACKER_PATH, 'utf8');
  assert.deepEqual(disagreeingBands(classify(snapshot()), parseTrackerArtifact(markdown)), []);
});

test('formatEntry describes a tracked file and a layer exception', () => {
  assert.match(formatEntry({ band: 'recorded', file: 'a.js', lines: 500, signals: [] }), /recorded debt.*a\.js \(500 lines\)/);
  assert.match(
    formatEntry({
      band: 'exception', from: 'x.js', to: 'y.js', why: 'later', review_by: '2026-12-31',
    }),
    /layer exception, due 2026-12-31: x\.js -> y\.js -- later/,
  );
});

function withTempState(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-review-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'state.json');
}

test('readState defaults to an empty done set when no file exists', (t) => {
  assert.deepEqual(readState(withTempState(t)), { done: {} });
});

test('writeState then readState round-trips a marked-done key', (t) => {
  const statePath = withTempState(t);
  writeState({ done: { 'a.js': { at: '2026-09-26T00:00:00.000Z' } } }, statePath);
  assert.deepEqual(readState(statePath), { done: { 'a.js': { at: '2026-09-26T00:00:00.000Z' } } });
});

function runCli(args, t) {
  const statePath = withTempState(t);
  const result = spawnSync(process.execPath, [SCRIPT_PATH, `--state=${statePath}`, ...args], { encoding: 'utf8' });
  return { ...result, statePath };
}

test('CLI --check passes against the committed tracker artifact', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK: review queue agrees/);
});

test('CLI --check fails against a mutated tracker artifact', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-review-queue-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stalePath = path.join(root, 'architecture-trackers.md');
  fs.writeFileSync(stalePath, '# empty\n');

  const result = spawnSync(process.execPath, [SCRIPT_PATH, `--check=${stalePath}`], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /disagrees with/);
});

test('CLI default listing prints numbered entries with a remaining count', (t) => {
  const result = runCli([], t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[ \] 1\./m);
  assert.match(result.stdout, /remaining\.$/m);
});

test('CLI --json prints a queue array and an empty done list', (t) => {
  const result = runCli(['--json'], t);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.queue));
  assert.deepEqual(parsed.done, []);
});

test('CLI --done marks an entry, which --next then skips', (t) => {
  const statePath = withTempState(t);
  const first = spawnSync(process.execPath, [SCRIPT_PATH, `--state=${statePath}`, '--json'], { encoding: 'utf8' });
  const firstKey = JSON.parse(first.stdout).queue[0].key;

  const marked = spawnSync(process.execPath, [SCRIPT_PATH, `--state=${statePath}`, `--done=${firstKey}`], { encoding: 'utf8' });
  assert.equal(marked.status, 0, marked.stderr);
  assert.match(marked.stdout, /Marked done/);

  const next = spawnSync(process.execPath, [SCRIPT_PATH, `--state=${statePath}`, '--next'], { encoding: 'utf8' });
  assert.equal(next.status, 0, next.stderr);
  assert.doesNotMatch(next.stdout, new RegExp(firstKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('CLI --done rejects an unknown key', (t) => {
  const result = runCli(['--done=not-a-real-file.js'], t);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown queue key/);
});

test('CLI --reset clears previously marked progress', (t) => {
  const statePath = withTempState(t);
  const first = spawnSync(process.execPath, [SCRIPT_PATH, `--state=${statePath}`, '--json'], { encoding: 'utf8' });
  const firstKey = JSON.parse(first.stdout).queue[0].key;
  spawnSync(process.execPath, [SCRIPT_PATH, `--state=${statePath}`, `--done=${firstKey}`], { encoding: 'utf8' });

  const reset = spawnSync(process.execPath, [SCRIPT_PATH, `--state=${statePath}`, '--reset'], { encoding: 'utf8' });
  assert.equal(reset.status, 0, reset.stderr);

  const after = spawnSync(process.execPath, [SCRIPT_PATH, `--state=${statePath}`, '--json'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(after.stdout).done, []);
});
