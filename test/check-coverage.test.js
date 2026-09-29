const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluate,
  main,
  measuredFiles,
  parseArgs,
} = require('../scripts/check-coverage');

const REPO_ROOT = path.resolve(__dirname, '..');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-coverage-'));
}

function summaryFor(entries, total) {
  const summary = {};
  for (const [file, metrics] of Object.entries(entries)) {
    summary[`${REPO_ROOT}/${file}`] = {
      lines: { pct: metrics.lines, total: metrics.linesTotal ?? 100 },
      branches: { pct: metrics.branches, total: 50 },
    };
  }
  summary.total = {
    lines: { pct: total.lines }, statements: { pct: total.lines },
    functions: { pct: total.functions }, branches: { pct: total.branches },
  };
  return summary;
}

const EMPTY_TOTAL = { lines: 90, functions: 90, branches: 80 };

test('a metric at or above its floor is not a violation', () => {
  const baseline = { slackPoints: 0.1, minFileLines: 20, totals: { ...EMPTY_TOTAL }, files: {} };
  const summary = summaryFor({}, { ...EMPTY_TOTAL });
  const result = evaluate(baseline, summary);
  assert.deepEqual(result.violations, []);
});

test('a drop beyond the slack is a violation, a drop within it is not', () => {
  const baseline = { slackPoints: 0.2, minFileLines: 20, totals: { lines: 90, functions: 90, branches: 80 }, files: {} };
  const within = evaluate(baseline, summaryFor({}, { ...EMPTY_TOTAL, lines: 89.9 }));
  assert.deepEqual(within.violations, []);
  const beyond = evaluate(baseline, summaryFor({}, { ...EMPTY_TOTAL, lines: 85 }));
  assert.equal(beyond.violations.length, 1);
  assert.match(beyond.violations[0], /global lines/);
});

test('a per-file drop below its floor is a violation', () => {
  const baseline = {
    slackPoints: 0.1, minFileLines: 20, totals: { ...EMPTY_TOTAL },
    files: { 'lib/a.js': { lines: 80, branches: 70 } },
  };
  const ok = evaluate(baseline, summaryFor({ 'lib/a.js': { lines: 80, branches: 70 } }, { ...EMPTY_TOTAL }));
  assert.deepEqual(ok.violations, []);
  const bad = evaluate(baseline, summaryFor({ 'lib/a.js': { lines: 60, branches: 70 } }, { ...EMPTY_TOTAL }));
  assert.equal(bad.violations.length, 1);
  assert.match(bad.violations[0], /lib\/a\.js lines/);
});

test('files under the line threshold and tests are not scored', () => {
  const baseline = { slackPoints: 0, minFileLines: 20, totals: { ...EMPTY_TOTAL }, files: {} };
  const summary = summaryFor({
    'lib/tiny.js': { lines: 0, branches: 0, linesTotal: 5 },
    'test/x.test.js': { lines: 0, branches: 0 },
  }, { ...EMPTY_TOTAL });
  const result = evaluate(baseline, summary);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(Object.keys(result.nextFiles), []);
});

test('--update records measured files but never lowers a floor that regressed', () => {
  const directory = makeDir();
  try {
    const baselinePath = path.join(directory, 'baseline.json');
    const summaryPath = path.join(directory, 'summary.json');
    fs.writeFileSync(baselinePath, JSON.stringify({
      slackPoints: 0.1, minFileLines: 20,
      totals: { lines: 90, functions: 90, branches: 80 },
      files: { 'lib/regressed.js': { lines: 80, branches: 70 } },
    }));
    fs.writeFileSync(summaryPath, JSON.stringify(summaryFor(
      { 'lib/regressed.js': { lines: 60, branches: 70 }, 'lib/new.js': { lines: 95, branches: 88 } },
      { lines: 85, functions: 90, branches: 80 },
    )));

    const status = main([`--baseline=${baselinePath}`, `--coverage=${summaryPath}`, '--update']);
    assert.equal(status, 1, 'a regression must still fail after update');

    const written = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.equal(written.files['lib/regressed.js'].lines, 80, 'the higher per-file floor is kept');
    assert.equal(written.files['lib/new.js'].lines, 95, 'a new file is recorded');
    assert.equal(written.totals.lines, 90, 'the global floor is kept when the total regressed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a missing coverage summary is a usage error, not a pass', () => {
  const directory = makeDir();
  try {
    const baselinePath = path.join(directory, 'baseline.json');
    fs.writeFileSync(baselinePath, JSON.stringify({ slackPoints: 0.1, totals: { ...EMPTY_TOTAL }, files: {} }));
    const status = main([`--baseline=${baselinePath}`, `--coverage=${path.join(directory, 'absent.json')}`]);
    assert.equal(status, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('measuredFiles strips absolute paths and drops tests', () => {
  const files = measuredFiles(summaryFor({ 'lib/a.js': { lines: 50, branches: 50 } }, { ...EMPTY_TOTAL }));
  assert.deepEqual(Object.keys(files), ['lib/a.js']);
});

test('measuredFiles ignores absolute paths outside the repository', () => {
  const outside = path.resolve(REPO_ROOT, '..', 'outside.js');
  const files = measuredFiles({
    [outside]: { lines: { pct: 50, total: 100 }, branches: { pct: 50, total: 50 } },
    total: {},
  });
  assert.deepEqual(files, {});
});

test('parseArgs rejects junk and unknown options', () => {
  assert.throws(() => parseArgs(['oops']), /unexpected argument/);
  assert.throws(() => parseArgs(['--nope=1']), /unknown option/);
});
