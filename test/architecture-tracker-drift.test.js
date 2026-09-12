'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  TRACKER_PATH,
  BASELINE_PATH,
  baselineEvolutionViolations,
  checkTrackerArtifact,
  classify,
  renderMarkdown,
  snapshot,
  trackedEntries,
} = require('../scripts/architecture-snapshot');

test('committed architecture tracker matches the generated snapshot', () => {
  const expected = renderMarkdown(classify(snapshot()));
  const actual = fs.readFileSync(TRACKER_PATH, 'utf8');
  assert.equal(checkTrackerArtifact(expected, actual), null);
});

test('a stale tracker count fails the drift comparison', () => {
  const expected = renderMarkdown({
    structural: [],
    recorded: [],
    decompose: [{ file: 'kernel.js', lines: 1000, signals: [] }],
  });
  const stale = expected.replace('Tracked in total: **1**', 'Tracked in total: **2**');

  assert.match(checkTrackerArtifact(expected, stale), /Architecture tracker drift/);
});

test('the real CLI exits non-zero for a mutated tracker artifact', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-architecture-tracker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stalePath = path.join(root, 'architecture-trackers.md');
  const stale = fs.readFileSync(TRACKER_PATH, 'utf8')
    .replace('Tracked in total: **92**', 'Tracked in total: **93**');
  fs.writeFileSync(stalePath, stale);

  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '../scripts/architecture-snapshot.js'),
    `--check=${stalePath}`,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Architecture tracker drift/);
});

test('CRLF checkout content does not create false tracker drift', () => {
  const expected = fs.readFileSync(TRACKER_PATH, 'utf8');
  assert.equal(checkTrackerArtifact(expected, expected.replace(/\n/g, '\r\n')), null);
});

test('baseline evolution permits only monotonic per-file improvement', () => {
  const previous = { schemaVersion: 2, entries: {
    'a.js': { band: 'decompose', lines: 900, signals: ['DIP'] },
  } };
  assert.deepEqual(baselineEvolutionViolations(previous, { schemaVersion: 2, entries: {
    'a.js': { band: 'recorded', lines: 700, signals: [] },
  } }), []);
  assert.match(baselineEvolutionViolations(previous, { schemaVersion: 2, entries: {
    'a.js': previous.entries['a.js'],
    'b.js': { band: 'structural', lines: 200, signals: ['DIP'] },
  } })[0], /newly tracked/);
});

test('numeric signal decreases are improvements while increases are rejected', () => {
  const previous = { schemaVersion: 2, entries: {
    'a.js': { band: 'structural', lines: 200, signals: ['FANOUT:35', 'ISP:6', 'OCP:10'] },
  } };
  assert.deepEqual(baselineEvolutionViolations(previous, { schemaVersion: 2, entries: {
    'a.js': { band: 'structural', lines: 200, signals: ['FANOUT:34', 'ISP:5', 'OCP:9'] },
  } }), []);
  assert.match(baselineEvolutionViolations(previous, { schemaVersion: 2, entries: {
    'a.js': { band: 'structural', lines: 200, signals: ['FANOUT:36'] },
  } })[0], /worsened signal/);
});

function runFixtureGate(t, mutateGroups) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-architecture-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const groups = classify(snapshot());
  mutateGroups(groups);
  const trackerPath = path.join(root, 'tracker.md');
  const baselinePath = path.join(root, 'baseline.json');
  const snapshotPath = path.join(root, 'snapshot.json');
  fs.writeFileSync(trackerPath, renderMarkdown(groups));
  fs.writeFileSync(baselinePath, JSON.stringify({ schemaVersion: 2, entries: trackedEntries(groups) }));
  fs.writeFileSync(snapshotPath, JSON.stringify(groups));
  return spawnSync(process.execPath, [
    path.resolve(__dirname, '../scripts/architecture-snapshot.js'),
    `--check=${trackerPath}`,
    `--baseline=${baselinePath}`,
    `--previous-baseline=${BASELINE_PATH}`,
    `--snapshot=${snapshotPath}`,
  ], { encoding: 'utf8' });
}

test('real CLI rejects count and baseline increased together', (t) => {
  const result = runFixtureGate(t, (groups) => groups.decompose.push({
    file: 'lib/new-debt.js', lines: 901, signals: [],
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /baseline cannot add debt/);
});

test('real CLI rejects same-count tracked-file churn', (t) => {
  const result = runFixtureGate(t, (groups) => {
    const removed = groups.recorded.shift();
    groups.recorded.push({ ...removed, file: 'lib/replacement-debt.js' });
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /replacement-debt\.js is newly tracked/);
});

test('real CLI fails closed when base ref cannot be resolved', () => {
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '../scripts/architecture-snapshot.js'),
    '--check',
    '--base-ref=not-a-real-ref',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});
