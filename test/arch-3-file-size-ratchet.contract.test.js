'use strict';

/**
 * #328 (arch-3), acceptance criterion 3: the large-file threshold is enforced
 * in CI.
 *
 * The check is a ratchet rather than a flat limit, because a flat 800-line
 * limit would fail the repository on day one against 18 existing files that
 * `docs/v4/big-file-refactor-gate.md` explicitly forbids splitting right now.
 * A gate that cannot pass gets disabled; a ratchet that says "no worse than
 * today" is enforceable immediately and still converges on the same place.
 *
 * These tests pin the ratchet's decision logic directly, so its edge cases do
 * not depend on the repository's current file sizes.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  THRESHOLD,
  BASELINE_PATH,
  countLines,
  evaluate,
  listSourceFiles,
} = require('../scripts/check-file-size');

const REPO_ROOT = path.resolve(__dirname, '..');

function kinds(violations) {
  return violations.map((item) => item.kind).sort();
}

test('a file under the threshold and absent from the baseline is fine', () => {
  const { violations } = evaluate({ 'lib/small.js': THRESHOLD }, {});
  assert.deepEqual(violations, []);
});

test('a new file over the threshold fails', () => {
  const { violations } = evaluate({ 'lib/big.js': THRESHOLD + 1 }, {});
  assert.deepEqual(kinds(violations), ['new-over-threshold']);
  assert.equal(violations[0].file, 'lib/big.js');
  assert.equal(violations[0].limit, THRESHOLD);
});

test('a baseline file that grows past its recorded ceiling fails', () => {
  const { violations } = evaluate({ 'kernel.js': 2099 }, { 'kernel.js': 2098 });
  assert.deepEqual(kinds(violations), ['grew']);
  assert.equal(violations[0].limit, 2098);
});

test('a baseline file that holds exactly at its ceiling passes', () => {
  const { violations } = evaluate({ 'kernel.js': 2098 }, { 'kernel.js': 2098 });
  assert.deepEqual(violations, []);
});

test('--update can never raise an existing ceiling', () => {
  const { nextBaseline } = evaluate({ 'kernel.js': 5000 }, { 'kernel.js': 2098 });
  assert.equal(
    nextBaseline['kernel.js'],
    2098,
    'a grown file keeps its old, lower ceiling so --update cannot bless it',
  );
});

test('shrinking a baseline file requires lowering the ledger', () => {
  const { violations, nextBaseline } = evaluate({ 'kernel.js': 1500 }, { 'kernel.js': 2098 });
  assert.deepEqual(kinds(violations), ['baseline-stale']);
  assert.equal(nextBaseline['kernel.js'], 1500, 'the gain must be locked in');
});

test('a baseline file that reaches the threshold must leave the ledger', () => {
  const { violations, nextBaseline } = evaluate({ 'kernel.js': THRESHOLD }, { 'kernel.js': 2098 });
  assert.deepEqual(kinds(violations), ['baseline-clearable']);
  assert.equal('kernel.js' in nextBaseline, false, 'the entry must be dropped, not pinned at the threshold');
});

test('a deleted or renamed file leaves no stale ledger entry', () => {
  const { violations } = evaluate({}, { 'lib/gone.js': 1200 });
  assert.deepEqual(kinds(violations), ['baseline-orphan']);
});

test('the ratchet reports every independent violation, not just the first', () => {
  const { violations } = evaluate(
    { 'a.js': THRESHOLD + 1, 'b.js': 1300, 'c.js': 900 },
    { 'b.js': 1200, 'c.js': 1000 },
  );
  assert.deepEqual(kinds(violations), ['baseline-stale', 'grew', 'new-over-threshold']);
});

test('countLines matches wc -l semantics for the trailing-newline cases', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'huqan-arch3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cases = [
    ['', 0],
    ['a\n', 1],
    ['a', 1],
    ['a\nb\n', 2],
    ['a\nb', 2],
    ['\n\n', 2],
  ];
  for (const [content, expected] of cases) {
    const file = path.join(root, `case-${Buffer.from(content).toString('hex')}.js`);
    fs.writeFileSync(file, content);
    assert.equal(countLines(file), expected, JSON.stringify(content));
  }
});

test('the committed baseline is consistent with the tracked source tree', () => {
  const document = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  assert.equal(document.threshold, THRESHOLD, 'the ledger records the threshold it was taken at');

  const tracked = new Set(listSourceFiles());
  for (const [file, recorded] of Object.entries(document.files)) {
    assert.equal(tracked.has(file), true, `${file} is in the baseline but not a tracked source file`);
    assert.equal(
      recorded > THRESHOLD,
      true,
      `${file} is recorded at ${recorded}, which does not need a baseline entry`,
    );
    assert.equal(
      countLines(path.join(REPO_ROOT, file)) <= recorded,
      true,
      `${file} exceeds its recorded ceiling of ${recorded}`,
    );
  }
});

test('generated bundles and tests are outside the ratchet', () => {
  const files = listSourceFiles();
  assert.equal(
    files.some((file) => file.includes('obsidian-plugin/dist/')),
    false,
    'a generated bundle is never hand-split, so counting it only produces noise',
  );
  assert.equal(
    files.some((file) => file.endsWith('.test.js')),
    false,
    'the invariant is about the shipped runtime, matching check-import-cycles.js',
  );
  assert.equal(files.includes('kernel.js'), true, 'the runtime is in scope');
});
