'use strict';

/**
 * #328 (arch-3), acceptance criterion 3: the large-file threshold is enforced
 * in CI.
 *
 * The check is a ratchet rather than a flat limit, because a flat 800-line
 * limit would fail the repository on day one against every file already over
 * it, and a gate that cannot pass gets disabled. A ratchet is enforceable
 * immediately -- but "no worse than today" converges only if the ceiling is
 * also required to fall, which `docs/architecture-policy.md` now mandates.
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
  MAX_LINE_LENGTH,
  LONG_LINE_ALLOWED,
  BASELINE_PATH,
  countLines,
  countMaxLineLength,
  evaluate,
  listSourceFiles,
  measure,
  measureMaxLineLengths,
  readBaseline,
} = require('../scripts/check-file-size');
const { longLineExceptionViolations } = require('../scripts/file-size-policy');

const REPO_ROOT = path.resolve(__dirname, '..');

function kinds(violations) {
  return violations.map((item) => item.kind).sort();
}

/**
 * A longest-line map covering every recorded exception, so a test can change
 * one entry without the untouched ones reading as stale (a missing entry means
 * the file is gone, by design).
 */
function fullMap(overrides = {}) {
  const map = Object.fromEntries(LONG_LINE_ALLOWED.map((entry) => [entry.file, MAX_LINE_LENGTH + 1]));
  return { ...map, ...overrides };
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

test('a new-over-threshold message reports how far over the threshold it is', () => {
  const { violations } = evaluate({ 'lib/big.js': THRESHOLD + 2200 }, {});
  assert.match(violations[0].message, new RegExp(`2200 over the ${THRESHOLD}-line threshold`));
});

test('--update alone (no --seed-new) never seeds a new debt entry for a brand-new file (#1289)', () => {
  const { violations, nextBaseline } = evaluate({ 'lib/brand-new.js': THRESHOLD + 2200 }, {});
  assert.deepEqual(kinds(violations), ['new-over-threshold']);
  assert.deepEqual(nextBaseline, {}, 'plain evaluate() (seedNew defaults to false) must not write a ceiling');
});

test('--seed-new explicitly opts in to recording a brand-new over-threshold file (#1289)', () => {
  const { violations, nextBaseline } = evaluate(
    { 'lib/brand-new.js': THRESHOLD + 2200 }, {}, THRESHOLD, { seedNew: true },
  );
  assert.deepEqual(kinds(violations), ['new-over-threshold']);
  assert.equal(nextBaseline['lib/brand-new.js'], THRESHOLD + 2200);
});

test('--seed-new never lets an existing ceiling grow -- only new files are affected (#1289)', () => {
  const { nextBaseline } = evaluate(
    { 'kernel.js': 5000 }, { 'kernel.js': 2098 }, THRESHOLD, { seedNew: true },
  );
  assert.equal(nextBaseline['kernel.js'], 2098, 'seedNew only governs brand-new entries, not the grown-ceiling ratchet');
});

test('a baseline file that grows past its recorded ceiling fails', () => {
  const { violations } = evaluate({ 'kernel.js': 2099 }, { 'kernel.js': 2098 });
  assert.deepEqual(kinds(violations), ['grew']);
  assert.equal(violations[0].limit, 2098);
});

/** A review entry well inside its window, for the cases that are about the
 *  ceiling arithmetic rather than about review dates. A recorded entry with no
 *  review date is itself a violation, so these have to supply one. */
const reviewed = (...files) => ({
  reviews: Object.fromEntries(files.map((file) => [file, { why: 'test', review_by: '2099-01-01' }])),
  today: '2026-09-12',
});

test('a baseline file that holds exactly at its ceiling passes', () => {
  const { violations } = evaluate({ 'kernel.js': 2098 }, { 'kernel.js': 2098 }, THRESHOLD, reviewed('kernel.js'));
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
  const { violations, nextBaseline } = evaluate({ 'kernel.js': 1500 }, { 'kernel.js': 2098 }, THRESHOLD, reviewed('kernel.js'));
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
    THRESHOLD,
    reviewed('b.js', 'c.js'),
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

test('an entry past its review date fails, so the ledger cannot freeze', () => {
  // The half the ratchet was missing. A ceiling that may fall is not a ceiling
  // that must: without this, an entry sits at today's size forever and the
  // ledger freezes the way the policy this replaced did, one threshold lower.
  const { violations } = evaluate(
    { 'lib/big.js': THRESHOLD + 100 },
    { 'lib/big.js': THRESHOLD + 100 },
    THRESHOLD,
    { reviews: { 'lib/big.js': { why: 'recorded', review_by: '2026-01-01' } }, today: '2026-09-12' },
  );

  const expired = violations.filter((item) => item.kind === 'review-expired');
  assert.equal(expired.length, 1);
  assert.match(expired[0].message, /due for review by 2026-01-01/);
});

test('an entry inside its review window does not fail on that ground', () => {
  const { violations } = evaluate(
    { 'lib/big.js': THRESHOLD + 100 },
    { 'lib/big.js': THRESHOLD + 100 },
    THRESHOLD,
    { reviews: { 'lib/big.js': { why: 'recorded', review_by: '2027-03-31' } }, today: '2026-09-12' },
  );

  assert.deepEqual(violations.filter((item) => item.kind.startsWith('review-')), []);
});

test('a recorded ceiling with no review date at all is a violation', () => {
  // Otherwise the date requirement is opt-in, and an entry added by hand
  // without one would be permanently exempt from the rule meant to catch it.
  const { violations } = evaluate(
    { 'lib/big.js': THRESHOLD + 100 },
    { 'lib/big.js': THRESHOLD + 100 },
    THRESHOLD,
    { reviews: {}, today: '2026-09-12' },
  );

  assert.equal(violations.filter((item) => item.kind === 'review-missing').length, 1);
});

/**
 * Density: the line-count ratchet cannot see a file collapsed onto one line.
 * These pin the longest-line budget and its exception ledger directly.
 */
test('a line over the character budget fails when the file is not recorded', () => {
  const { violations } = evaluate(
    { 'lib/dense.js': 10 },
    {},
    THRESHOLD,
    { maxLineLengths: fullMap({ 'lib/dense.js': MAX_LINE_LENGTH + 1 }) },
  );
  const density = violations.filter((item) => item.kind === 'density');
  assert.equal(density.length, 1);
  assert.equal(density[0].file, 'lib/dense.js');
  assert.match(density[0].message, new RegExp(`over the ${MAX_LINE_LENGTH}-character budget`));
});

test('a line exactly at the character budget passes', () => {
  const { violations } = evaluate(
    { 'lib/dense.js': 10 },
    {},
    THRESHOLD,
    { maxLineLengths: fullMap({ 'lib/dense.js': MAX_LINE_LENGTH }) },
  );
  assert.deepEqual(violations.filter((item) => item.kind === 'density'), []);
});

test('a recorded long-line exception passes while its file is still over budget', () => {
  const file = 'public/js/app-approvals.js';
  const { violations } = evaluate(
    { [file]: 38 },
    {},
    THRESHOLD,
    { maxLineLengths: fullMap({ [file]: MAX_LINE_LENGTH + 30000 }) },
  );
  assert.deepEqual(violations.filter((item) => item.kind.startsWith('density')), []);
});

test('an expired long-line exception fails', () => {
  const file = 'public/js/app-approvals.js';
  const { violations } = evaluate(
    { [file]: 38 },
    {},
    THRESHOLD,
    { maxLineLengths: fullMap({ [file]: MAX_LINE_LENGTH + 30000 }), today: '2099-01-01' },
  );
  const expired = violations.filter((item) => item.kind === 'density-exception-expired');
  // Every recorded entry is past 2099, and the gate reports each one.
  assert.equal(expired.length, LONG_LINE_ALLOWED.length);
  assert.equal(expired.some((item) => item.file === file), true);
});

test('a long-line exception whose file fell under the budget is stale', () => {
  const file = 'public/js/app-approvals.js';
  const { violations } = evaluate(
    { [file]: 38 },
    {},
    THRESHOLD,
    { maxLineLengths: fullMap({ [file]: MAX_LINE_LENGTH }) },
  );
  const stale = violations.filter((item) => item.kind === 'density-exception-stale');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].file, file);
});

test('a long-line exception whose file is gone is stale', () => {
  const gone = 'public/js/app-approvals.js';
  const map = fullMap();
  delete map[gone];
  const { violations } = evaluate({ 'lib/other.js': 10 }, {}, THRESHOLD, { maxLineLengths: map });
  const stale = violations.filter((item) => item.kind === 'density-exception-stale');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].file, gone);
});

test('the density budget is inert when maxLineLengths is not supplied', () => {
  const { violations } = evaluate({ 'lib/big.js': THRESHOLD + 1 }, {});
  assert.deepEqual(kinds(violations), ['new-over-threshold']);
});

test('countMaxLineLength matches awk length semantics', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'huqan-density-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cases = [
    ['', 0],
    ['abc\nde\n', 3],
    ['a\nbbbbbb\n', 6],
    ['no-trailing-newline', 19],
  ];
  for (const [content, expected] of cases) {
    const file = path.join(root, `case-${Buffer.from(content).toString('hex')}.js`);
    fs.writeFileSync(file, content);
    assert.equal(countMaxLineLength(file), expected, JSON.stringify(content));
  }
});

test('the committed long-line exceptions are live: each names a tracked file still over budget', () => {
  const tracked = new Set(listSourceFiles());
  for (const entry of LONG_LINE_ALLOWED) {
    assert.equal(tracked.has(entry.file), true, `${entry.file} is recorded but is not a tracked source file`);
    assert.equal(
      countMaxLineLength(path.join(REPO_ROOT, entry.file)) > MAX_LINE_LENGTH,
      true,
      `${entry.file} is recorded but its longest line is within the budget`,
    );
    assert.equal(typeof entry.why, 'string', `${entry.file} must carry a reason`);
    assert.equal(typeof entry.review_by, 'string', `${entry.file} must carry a review date`);
  }
});

test('a long-line exception with no measure injected is date-checked but not called stale', () => {
  // The caller that cannot touch the filesystem still gets the review-date
  // half; only staleness needs a measurement, so it is left to that caller.
  const entries = [{ file: 'lib/dense.js', why: 'test', review_by: '2027-03-31' }];
  assert.deepEqual(longLineExceptionViolations(entries, { today: '2026-09-12' }), []);
});

test('a long-line exception whose file measures over the budget is neither expired nor stale', () => {
  const entries = [{ file: 'lib/dense.js', why: 'test', review_by: '2027-03-31' }];
  const violations = longLineExceptionViolations(entries, {
    today: '2026-09-12',
    measure: () => MAX_LINE_LENGTH + 1,
  });
  assert.deepEqual(violations, []);
});

test('measure counts the lines of every named file', () => {
  const measured = measure(['kernel.js', 'graph.js']);
  assert.deepEqual(Object.keys(measured).sort(), ['graph.js', 'kernel.js']);
  for (const [file, lines] of Object.entries(measured)) {
    assert.equal(lines, countLines(path.join(REPO_ROOT, file)), `${file} must match countLines`);
  }
});

test('measureMaxLineLengths returns the longest line of every named file', () => {
  const measured = measureMaxLineLengths(['kernel.js', 'graph.js']);
  assert.deepEqual(Object.keys(measured).sort(), ['graph.js', 'kernel.js']);
  for (const [file, longest] of Object.entries(measured)) {
    assert.equal(longest, countMaxLineLength(path.join(REPO_ROOT, file)), `${file} must match countMaxLineLength`);
  }
});

test('readBaseline returns the recorded line-count ceilings', () => {
  const baseline = readBaseline();
  assert.equal(typeof baseline, 'object');
  for (const [file, recorded] of Object.entries(baseline)) {
    assert.equal(typeof recorded, 'number', `${file} must map to a line count`);
    assert.equal(recorded > THRESHOLD, true, `${file} is recorded below the threshold and does not need an entry`);
  }
});

test('readBaseline yields an empty map when the ledger is absent or malformed', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'huqan-baseline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(readBaseline(path.join(root, 'absent.json')), {}, 'a missing ledger is no entries, not a throw');

  const noFiles = path.join(root, 'no-files.json');
  fs.writeFileSync(noFiles, JSON.stringify({ threshold: THRESHOLD }));
  assert.deepEqual(readBaseline(noFiles), {}, 'a ledger without a files map yields no entries');

  const nullFiles = path.join(root, 'null-files.json');
  fs.writeFileSync(nullFiles, JSON.stringify({ files: null }));
  assert.deepEqual(readBaseline(nullFiles), {}, 'a null files map yields no entries');

  const withFiles = path.join(root, 'with-files.json');
  fs.writeFileSync(withFiles, JSON.stringify({ files: { 'kernel.js': 2098 } }));
  assert.deepEqual(readBaseline(withFiles), { 'kernel.js': 2098 });
});
