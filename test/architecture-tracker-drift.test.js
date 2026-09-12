'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  TRACKER_PATH,
  checkTrackerBaseline,
  checkTrackerArtifact,
  classify,
  renderMarkdown,
  snapshot,
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

test('tracker baseline rejects increases and requires reviewed decreases to be recorded', () => {
  const baseline = { decompose: 12, recorded: 58, structural: 22, tracked: 92 };
  assert.match(
    checkTrackerBaseline({ ...baseline, structural: 23, tracked: 93 }, baseline),
    /increased/,
  );
  assert.match(
    checkTrackerBaseline({ ...baseline, decompose: 11, tracked: 91 }, baseline),
    /decreased/,
  );
  assert.equal(checkTrackerBaseline(baseline, baseline), null);
});
