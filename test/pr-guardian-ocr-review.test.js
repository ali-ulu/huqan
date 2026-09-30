'use strict';

/**
 * #3198. OpenCodeReview as the Guardian's second external signal: findings at
 * or above High send the change to review, anything else is reported only, and
 * an unavailable reviewer is `unknown` -- reported, never a failure, never a
 * block. "0 findings" is always shown with the number of files actually
 * covered, and every unreviewed file is named with its reason.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OCR_STATUS,
  hasOcrEndpoint,
  summarizeOcrReview,
  buildOcrArgs,
  createOcrRunner,
  toSarif,
} = require('../lib/pr-guardian/ocr-review-check');
const { evaluatePullRequest, normalizeOcrSignal } = require('../lib/pr-guardian/policy');
const { reviewOcr, ocrLine, sarifPathFor } = require('../scripts/pr-guardian-self-review');

const FILES = ['lib/a.js', 'lib/b.js'];

function ocrOutput(overrides = {}) {
  return {
    status: 'completed',
    reviewable_files: FILES.map(path => ({ path })),
    excluded_files: [],
    comments: [],
    ...overrides,
  };
}

test('blocking findings send the change to review with coverage', () => {
  const summary = summarizeOcrReview({
    files: FILES,
    output: ocrOutput({ comments: [
      { path: 'lib/a.js', severity: 'high', category: 'security', content: 'unsanitized sink', start_line: 10 },
      { path: 'lib/b.js', severity: 'low', category: 'style', content: 'nit' },
    ] }),
  });
  assert.equal(summary.status, OCR_STATUS.REVIEW);
  assert.equal(summary.covered, 2);
  assert.equal(summary.blockers.length, 1);
  assert.equal(summary.advisories.length, 1);
  assert.deepEqual(summary.skipped, []);
});

test('advisories alone are clean when everything is covered', () => {
  const summary = summarizeOcrReview({
    files: FILES,
    output: ocrOutput({ comments: [{ path: 'lib/a.js', severity: 'medium', category: 'performance', content: 'slow loop' }] }),
  });
  assert.equal(summary.status, OCR_STATUS.CLEAN);
  assert.equal(summary.covered, 2);
  assert.equal(summary.advisories.length, 1);
});

test('a failed or skipped run is unknown, never a verdict', () => {
  for (const output of [{ status: 'failed', message: 'boom' }, { status: 'skipped' }, null, 'nope']) {
    const summary = summarizeOcrReview({ files: FILES, output });
    assert.equal(summary.status, OCR_STATUS.UNKNOWN, JSON.stringify(output));
  }
});

test('a partial run without blockers is unknown, with blockers is review', () => {
  const partial = summarizeOcrReview({ files: FILES, output: ocrOutput({ status: 'partial' }) });
  assert.equal(partial.status, OCR_STATUS.UNKNOWN);
  const blocker = summarizeOcrReview({
    files: FILES,
    output: ocrOutput({ status: 'partial', comments: [{ path: 'lib/a.js', severity: 'critical', content: 'rce' }] }),
  });
  assert.equal(blocker.status, OCR_STATUS.REVIEW);
});

test('excluded files are named with normalized reasons and keep the result unknown', () => {
  const summary = summarizeOcrReview({
    files: [...FILES, 'asset/logo.png', 'huge/data.json'],
    output: ocrOutput({
      reviewable_files: FILES.map(path => ({ path })),
      excluded_files: [
        { path: 'asset/logo.png', exclude_reason: 'unsupported_ext' },
        { path: 'huge/data.json', exclude_reason: 'file_too_large' },
      ],
    }),
  });
  assert.equal(summary.status, OCR_STATUS.UNKNOWN);
  assert.deepEqual(summary.skipped, [
    { path: 'asset/logo.png', reason: 'extension' },
    { path: 'huge/data.json', reason: 'too_large' },
  ]);
});

test('a changed file the output accounts for nowhere is unevidenced, not covered', () => {
  const summary = summarizeOcrReview({ files: [...FILES, 'lib/ghost.js'], output: ocrOutput() });
  assert.equal(summary.status, OCR_STATUS.UNKNOWN);
  assert.deepEqual(summary.skipped, [{ path: 'lib/ghost.js', reason: 'unevidenced' }]);
  assert.equal(summary.covered, 2);
});

test('the endpoint check reads the documented variables only', () => {
  assert.equal(hasOcrEndpoint({}), false);
  assert.equal(hasOcrEndpoint({ OCR_LLM_TOKEN: 'x' }), true);
  assert.equal(hasOcrEndpoint({ ANTHROPIC_MODEL: 'x' }), true);
  assert.equal(hasOcrEndpoint({ OCR_LLM_TOKEN: '  ' }), false);
  assert.equal(hasOcrEndpoint(null), false);
});

test('the rule path is passed through, never resolved', () => {
  // Base-only is a caller property: this asserts the callee cannot substitute
  // a head-side path, because it never sees anything but the given string.
  const args = buildOcrArgs({ from: 'base', to: 'head', rulePath: '/base/.opencodereview/rule.json' });
  assert.ok(args.includes('--rule'));
  assert.equal(args[args.indexOf('--rule') + 1], '/base/.opencodereview/rule.json');
  assert.ok(args.includes('--from') && args.includes('--to'));
  assert.ok(args.includes('--format') && args.includes('json'));
});

test('the runner reduces transport failures to unknown', () => {
  const timeoutRunner = createOcrRunner({ spawnSync: () => { const error = new Error('x'); error.code = 'ETIMEDOUT'; return { error }; } });
  const timedOut = timeoutRunner({ cwd: '/x', from: 'b', to: 'h', rulePath: '' });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.summary.status, OCR_STATUS.UNKNOWN);
  assert.equal(timedOut.summary.reason, 'OCR_TIMEOUT');

  const badJson = createOcrRunner({ spawnSync: () => ({ status: 0, stdout: 'not json', stderr: '' }) });
  assert.equal(badJson({ cwd: '/x', from: 'b', to: 'h', rulePath: '' }).summary.reason, 'OCR_OUTPUT_INVALID');

  const good = createOcrRunner({ spawnSync: () => ({ status: 0, stdout: JSON.stringify(ocrOutput()), stderr: '' }) });
  const ran = good({ cwd: '/x', from: 'b', to: 'h', rulePath: '' });
  assert.equal(ran.ok, true);
  assert.deepEqual(ran.output.reviewable_files.length, 2);
});

test('sarif carries evidenced findings with mapped levels', () => {
  const sarif = toSarif({
    blockers: [{ path: 'lib/a.js', severity: 'high', category: 'security', content: 'sink', startLine: 10 }],
    advisories: [{ path: 'lib/b.js', severity: 'low', category: 'style', content: 'nit', startLine: 0 }],
  });
  assert.equal(sarif.version, '2.1.0');
  const levels = Object.fromEntries(sarif.runs[0].results.map(r => [r.locations[0].physicalLocation.artifactLocation.uri, r.level]));
  assert.deepEqual(levels, { 'lib/a.js': 'error', 'lib/b.js': 'note' });
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine, 10);
  assert.deepEqual(toSarif({ blockers: [], advisories: [] }).runs[0].results, []);
});

test('policy: review escalates, unknown surfaces, clean and absent stay silent', () => {
  const base = { repo: 'a/b', headSha: 'x', workspaceId: 'w' };
  const review = evaluatePullRequest({ ...base, ocrReview: { status: 'review', total: 1, covered: 1, blockers: [{}] } });
  assert.equal(review.decision, 'review');
  assert.ok(review.reasons.includes('ocr_review_findings'));

  const unknown = evaluatePullRequest({ ...base, ocrReview: { status: 'unknown', reason: 'OCR_NO_LLM_ENDPOINT' } });
  assert.equal(unknown.decision, 'allow');
  assert.ok(unknown.reasons.includes('ocr_review_unknown'));

  assert.equal(evaluatePullRequest({ ...base, ocrReview: { status: 'clean', total: 2, covered: 2 } }).decision, 'allow');
  assert.equal(evaluatePullRequest(base).decision, 'allow');
  // Never a block from the signal itself: with findings the decision stops at
  // review, and the block below comes only from the merge executor.
  const merged = evaluatePullRequest({ ...base, ocrReview: { status: 'review', blockers: [{}] } }, { action: 'github.merge.execute' });
  assert.equal(merged.decision, 'block');
  assert.ok(merged.reasons.includes('ocr_review_findings'));
  assert.ok(merged.reasons.includes('merge_executor_disabled_in_mvp'));
});

test('policy: a malformed signal is unknown, not clean', () => {
  assert.equal(normalizeOcrSignal('nope').status, 'unknown');
  assert.equal(normalizeOcrSignal({ status: 'bogus' }).status, 'unknown');
  assert.equal(normalizeOcrSignal(null).status, 'none');
});

test('self-review: without an endpoint nothing spawns and the signal is unknown', async () => {
  let spawned = false;
  const { summary, sarifPath } = await reviewOcr({
    cwd: '/nonexistent', repo: 'a/b', number: 1, baseSha: 'b', token: 't',
    files: [{ filename: 'lib/a.js' }], env: {},
    spawnSync: () => { spawned = true; throw new Error('must not spawn'); },
  });
  assert.equal(spawned, false);
  assert.equal(summary.status, OCR_STATUS.UNKNOWN);
  assert.equal(summary.reason, 'OCR_NO_LLM_ENDPOINT');
  assert.equal(sarifPath, null);
  // The comment says so without counting it either way.
  const line = ocrLine({ ocrReview: summary });
  assert.match(line, /not checkable/);
  assert.match(line, /not counted either way/);
});

test('self-review: a failed head fetch is unknown with the cause attached', async () => {
  const { summary } = await reviewOcr({
    cwd: '/nonexistent', repo: 'a/b', number: 1, baseSha: 'b', token: 't',
    files: [], env: { OCR_LLM_TOKEN: 'x' },
    spawnSync: () => ({ status: 128, stdout: '', stderr: 'not found' }),
  });
  assert.equal(summary.status, OCR_STATUS.UNKNOWN);
  assert.equal(summary.reason, 'OCR_HEAD_UNAVAILABLE');
});

test('self-review: a clean run writes sarif beside the summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ocr-'));
  const calls = [];
  const { summary, sarifPath } = await reviewOcr({
    cwd: dir, repo: 'a/b', number: 1, baseSha: 'b', token: 't',
    files: [{ filename: 'lib/a.js' }], env: { OCR_LLM_TOKEN: 'x', RUNNER_TEMP: dir },
    spawnSync: (cmd, args) => {
      calls.push(cmd);
      if (cmd === 'git') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: JSON.stringify(ocrOutput({ reviewable_files: [{ path: 'lib/a.js' }] })), stderr: '' };
    },
  });
  assert.equal(summary.status, OCR_STATUS.CLEAN);
  assert.ok(sarifPath && fs.existsSync(sarifPath));
  assert.deepEqual(JSON.parse(fs.readFileSync(sarifPath, 'utf8')).runs.length, 1);
  assert.ok(calls.includes('git') && calls.includes('ocr'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the sarif path is private: runner temp or a fresh mkdtemp dir', () => {
  assert.equal(sarifPathFor({ RUNNER_TEMP: '/run/123' }), path.join('/run/123', 'ocr-findings.sarif'));
  const fallback = sarifPathFor({});
  assert.match(path.dirname(fallback), /huqan-ocr-/);
  assert.ok(fs.statSync(path.dirname(fallback)).isDirectory());
  fs.rmSync(path.dirname(fallback), { recursive: true, force: true });
});

test('comment lines cover clean, review and capped skip lists', () => {
  assert.equal(ocrLine({}), null);
  assert.match(ocrLine({ ocrReview: { status: 'clean', total: 2, covered: 2, skipped: [] } }), /0 blocking findings, 2\/2 files covered/);
  const reviewLine = ocrLine({ ocrReview: {
    status: 'review', total: 1, covered: 1,
    blockers: [{ path: 'lib/a.js', severity: 'high', content: 'sink' }], skipped: [],
  } });
  assert.match(reviewLine, /1 blocking finding\(s\)/);
  const long = ocrLine({ ocrReview: {
    status: 'unknown', total: 12, covered: 0, reason: 'x',
    skipped: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.js`, reason: 'unevidenced' })),
  } });
  assert.match(long, /and 2 more/);
});
