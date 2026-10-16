'use strict';

// #3198: the coverage a real `ocr review` reports. The fixture is the verbatim
// JSON of ocr v1.12.11 reviewing d71752f1 (#3219) -- 4 of its 5 files
// selected and completed, the markdown file not selected, 0 findings.
// `ocr review` states its coverage in `manifest.coverage`, not in the
// delegate-preview fields the first version read, so every file it reviewed
// used to be reported `unevidenced` and every real run ended `unknown`.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { OCR_STATUS, summarizeOcrReview } = require('../lib/pr-guardian/ocr-review-check');

const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ocr-review-v1.12.11.json'), 'utf8'));
const CODE = [
  '.github/workflows/pr-guardian-ocr-sarif.yml',
  '.github/workflows/pr-guardian-self.yml',
  'scripts/pr-guardian-self-review.js',
  'test/pr-guardian-ocr-ci.test.js',
];
const DOC = 'docs/pr-guardian-github-actions.md';

function withCoverage(coverage) {
  return { ...REAL, manifest: { ...REAL.manifest, coverage: { ...REAL.manifest.coverage, ...coverage } } };
}

test('a real clean review of code files is clean with full coverage', () => {
  const summary = summarizeOcrReview({ output: REAL, files: CODE });
  assert.equal(summary.status, OCR_STATUS.CLEAN);
  assert.equal(summary.covered, 4);
  assert.deepEqual(summary.skipped, []);
});

test('a file the reviewer does not review by design is named and does not withhold clean', () => {
  // Owner decision (2026-10-01): a .md file OCR has no rules for is reported,
  // not treated as missing coverage; the reviewed code decides.
  const summary = summarizeOcrReview({ output: REAL, files: [...CODE, DOC] });
  assert.equal(summary.status, OCR_STATUS.CLEAN);
  assert.equal(summary.covered, 4);
  assert.equal(summary.total, 5);
  assert.deepEqual(summary.skipped, [{ path: DOC, reason: 'not_selected' }]);
});

test('out-of-scope files never mask a file that should have been reviewed', () => {
  const [first, ...rest] = REAL.manifest.coverage.completed;
  const summary = summarizeOcrReview({ output: withCoverage({ completed: rest, failed: [first] }), files: [...CODE, DOC] });
  assert.equal(summary.status, OCR_STATUS.UNKNOWN);
  assert.equal(summary.reason, 'OCR_INCOMPLETE_COVERAGE');
});

test('reused items count as covered', () => {
  const [first, ...rest] = REAL.manifest.coverage.completed;
  const summary = summarizeOcrReview({ output: withCoverage({ completed: rest, reused: [first] }), files: CODE });
  assert.equal(summary.status, OCR_STATUS.CLEAN);
  assert.equal(summary.covered, 4);
});

test('a failed or waived item is not covered and says why', () => {
  const [first, second, ...rest] = REAL.manifest.coverage.completed;
  const summary = summarizeOcrReview({
    output: withCoverage({ completed: rest, failed: [first], waived: [second] }),
    files: CODE,
  });
  assert.equal(summary.status, OCR_STATUS.UNKNOWN);
  assert.equal(summary.covered, 2);
  assert.deepEqual(summary.skipped.map((item) => [item.path, item.reason]).sort(), [
    [first.path, 'failed'],
    [second.path, 'waived'],
  ].sort());
});

test('a failed or waived item outside the change says nothing about it', () => {
  const outside = { item_id: 'x', path: 'lib/not-in-this-change.js', fingerprint: 'y' };
  const summary = summarizeOcrReview({
    output: withCoverage({ failed: [outside], waived: [{ ...outside, path: 'lib/also-outside.js' }] }),
    files: CODE,
  });
  assert.equal(summary.status, OCR_STATUS.CLEAN);
  assert.equal(summary.covered, 4);
  assert.deepEqual(summary.skipped, []);
});

test('a selected item that never completed is unevidenced', () => {
  const [, ...rest] = REAL.manifest.coverage.completed;
  const summary = summarizeOcrReview({ output: withCoverage({ completed: rest }), files: CODE });
  assert.equal(summary.status, OCR_STATUS.UNKNOWN);
  assert.equal(summary.covered, 3);
  assert.deepEqual(summary.skipped, [{ path: REAL.manifest.coverage.completed[0].path, reason: 'unevidenced' }]);
});
