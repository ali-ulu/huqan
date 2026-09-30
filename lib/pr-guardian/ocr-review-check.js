'use strict';

/**
 * PR Guardian — OpenCodeReview signal (#3198).
 *
 * The second external signal next to the derivation signal, in the same shape:
 * computed outside the policy (running a reviewer is I/O) and consumed as a
 * snapshot field, so `evaluatePullRequest` stays pure.
 *
 * Three deliberate asymmetries with `derivation-check.js`:
 *
 *   1. An LLM finding is not evidence enough for a block. Findings at or above
 *      High send the change to `review`; anything else is reported only; an
 *      unavailable or failing reviewer is `unknown` (reported, never a
 *      failure). This module never produces `block`.
 *   2. "0 findings" is not a result on its own. The summary carries the number
 *      of files actually covered, and every changed file the reviewer did not
 *      look at is listed with its reason (`secret`, `too_large`, `extension`,
 *      `default_path`, `user_rule`, budget/timeout, or `unevidenced` when the
 *      output accounts for a file nowhere at all).
 *   3. The rules come from the base tree. `ocr` reads `.opencodereview/rule.json`
 *      from the working tree, so the CI step passes `--rule` pointing at the
 *      base checkout -- never at the head under review. That wiring lives with
 *      the caller (`buildOcrArgs` takes the path; it does not resolve it).
 */

const childProcess = require('node:child_process');

const OCR_STATUS = Object.freeze({
  REVIEW: 'review',
  CLEAN: 'clean',
  UNKNOWN: 'unknown',
});

const DEFAULT_BLOCKING_SEVERITIES = Object.freeze(['critical', 'high']);

// How long one `ocr review` may take before the finding becomes "the reviewer
// is unavailable" rather than a verdict about the change.
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// Environment variables that evidence an LLM endpoint OCR can use. Any one of
// them present means "attempt the run and reduce whatever comes back"; none
// present means "do not spawn at all" -- the fast path the offline test suite
// and key-less CI legs take.
const OCR_ENDPOINT_VARS = Object.freeze([
  'OCR_LLM_TOKEN',
  'OCR_LLM_URL',
  'OCR_LLM_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value == null ? '' : value).trim();
}

function normalizePath(value) {
  return text(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[ab]\//, '');
}

function hasOcrEndpoint(env = process.env) {
  if (!env || typeof env !== 'object') return false;
  return OCR_ENDPOINT_VARS.some(name => text(env[name]) !== '');
}

function unknownSummary(total, reason, detail = '') {
  return {
    status: OCR_STATUS.UNKNOWN,
    total,
    covered: 0,
    blockers: [],
    advisories: [],
    skipped: [],
    reason,
    detail: text(detail),
  };
}

/**
 * Map an OCR skip reason into the vocabulary the Guardian comment speaks.
 * Anything unrecognised passes through verbatim: inventing a mapping for a
 * reason OCR never emits would be worse than showing the raw one.
 */
function normalizeSkipReason(reason) {
  const raw = text(reason).toLowerCase();
  if (!raw) return 'unevidenced';
  if (raw.includes('secret')) return 'secret';
  if (raw.includes('budget')) return 'budget';
  if (raw.includes('timeout')) return 'timeout';
  if (raw.includes('large') || raw.includes('size') || raw.includes('token')) return 'too_large';
  if (raw.includes('ext')) return 'extension';
  if (raw.includes('default')) return 'default_path';
  if (raw.includes('rule') || raw.includes('exclud') || raw.includes('ignore')) return 'user_rule';
  return text(reason);
}

/**
 * Pure reduction of one `ocr review --format json` result over the change's
 * file list. Kept apart from the process call so every branch is testable
 * without an LLM.
 *
 * @param {object} input
 * @param {object} input.output parsed `ocr review` JSON (or null when the run failed)
 * @param {Array<string|{filename:string}>} input.files the change's files
 * @param {Array<string>} [input.blockingSeverities] severities that send the change to review
 * @param {string} [input.runError] transport-level failure (timeout, bad JSON) when output is null
 */
function summarizeOcrReview({ output, files = [], blockingSeverities = DEFAULT_BLOCKING_SEVERITIES } = {}) {
  const prFiles = (Array.isArray(files) ? files : [])
    .map(file => normalizePath(typeof file === 'string' ? file : file?.filename))
    .filter(Boolean);
  const total = prFiles.length;
  const blocking = new Set((Array.isArray(blockingSeverities) ? blockingSeverities : []).map(s => String(s).toLowerCase()));

  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return unknownSummary(total, 'OCR_OUTPUT_INVALID', 'the reviewer returned no parseable result');
  }
  const manifest = output.manifest && typeof output.manifest === 'object' ? output.manifest : null;
  const state = text(manifest?.terminal_state || output.status).toLowerCase();
  if (state === 'failed' || state === 'error') {
    return { ...unknownSummary(total, 'OCR_RUN_FAILED'), detail: text(output.message) || 'the reviewer reported failure' };
  }
  if (state === 'skipped') {
    return { ...unknownSummary(total, 'OCR_NOTHING_REVIEWABLE'), detail: 'the reviewer selected no file (unsupported extension or excluded path)' };
  }

  const comments = (Array.isArray(output.comments) ? output.comments : [])
    .map(comment => ({
      path: normalizePath(comment?.path),
      severity: text(comment?.severity).toLowerCase() || 'unknown',
      category: text(comment?.category).toLowerCase() || 'other',
      content: text(comment?.content),
      startLine: Number(comment?.start_line) || 0,
    }))
    .filter(comment => comment.path && comment.content);
  const blockers = comments.filter(comment => blocking.has(comment.severity));
  const advisories = comments.filter(comment => !blocking.has(comment.severity));

  // Coverage evidence, from every shape OCR emits it in. `reviewable_files`
  // and `excluded_files` come from the delegate preview shape; `files` with a
  // reviewed flag and `skipped_files` from review runs. A file the output
  // accounts for nowhere is `unevidenced`, never silently covered.
  const reviewed = new Set();
  for (const entry of [...(output.reviewable_files || []), ...(output.reviewed_files || [])]) {
    const path = normalizePath(typeof entry === 'string' ? entry : entry?.path);
    if (path) reviewed.add(path);
  }
  if (Array.isArray(output.files)) {
    for (const entry of output.files) {
      const path = normalizePath(typeof entry === 'string' ? entry : entry?.path);
      if (!path) continue;
      const flagged = typeof entry === 'object' && (entry.reviewed === false || /skip|exclud/i.test(text(entry.status)));
      if (!flagged) reviewed.add(path);
    }
  }
  for (const comment of comments) reviewed.add(comment.path);

  const skipped = [];
  for (const entry of [...(output.excluded_files || []), ...(output.skipped_files || [])]) {
    const path = normalizePath(typeof entry === 'string' ? entry : entry?.path);
    if (!path) continue;
    skipped.push({ path, reason: normalizeSkipReason(typeof entry === 'string' ? '' : (entry.exclude_reason || entry.skip_reason || entry.reason || entry.status)) });
  }
  const skippedPaths = new Set(skipped.map(item => item.path));
  for (const path of prFiles) {
    if (!reviewed.has(path) && !skippedPaths.has(path)) skipped.push({ path, reason: 'unevidenced' });
  }
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (blockers.length > 0) {
    return {
      status: OCR_STATUS.REVIEW,
      total,
      covered: [...reviewed].filter(path => prFiles.includes(path)).length,
      blockers,
      advisories,
      skipped,
      reason: 'OCR_FINDINGS',
      detail: `${blockers.length} blocking finding(s) at or above ${[...blocking].join('/')}`,
    };
  }
  // Nothing blocking, but a partial run did not look at everything: absence of
  // findings on files it never reviewed is not a pass.
  if (state === 'partial') {
    return {
      status: OCR_STATUS.UNKNOWN,
      total,
      covered: [...reviewed].filter(path => prFiles.includes(path)).length,
      blockers: [],
      advisories,
      skipped,
      reason: 'OCR_PARTIAL_COVERAGE',
      detail: 'the reviewer covered the change only partially',
    };
  }
  if (skipped.length > 0) {
    return {
      status: OCR_STATUS.UNKNOWN,
      total,
      covered: [...reviewed].filter(path => prFiles.includes(path)).length,
      blockers: [],
      advisories,
      skipped,
      reason: 'OCR_INCOMPLETE_COVERAGE',
      detail: `${skipped.length} changed file(s) not reviewed`,
    };
  }
  return {
    status: OCR_STATUS.CLEAN,
    total,
    covered: [...reviewed].filter(path => prFiles.includes(path)).length,
    blockers: [],
    advisories,
    skipped: [],
    reason: '',
    detail: total === 0 ? 'no changed files' : `${total}/${total} files covered, 0 blocking findings`,
  };
}

/**
 * Arguments for one `ocr review` over a pull request. The rule path is taken
 * as given: the caller resolves it against the BASE checkout, because a pull
 * request must never supply its own review rules.
 */
function buildOcrArgs({ from, to, rulePath }) {
  const args = ['review', '--format', 'json', '--audience', 'agent', '--color', 'never'];
  if (text(from)) args.push('--from', text(from));
  if (text(to)) args.push('--to', text(to));
  if (text(rulePath)) args.push('--rule', text(rulePath));
  return args;
}

/**
 * Run `ocr review` over a base-to-head range and reduce the result. The spawn
 * is injectable so the wiring is testable without an LLM; every failure --
 * missing binary, timeout, unparseable output -- reduces to `unknown`, never
 * to a verdict about the change.
 */
function createOcrRunner({ spawnSync = childProcess.spawnSync, platform = process.platform, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return function runOcrReview({ cwd, from, to, rulePath }) {
    if (!text(from) || !text(to)) return { ok: false, summary: unknownSummary(0, 'OCR_RANGE_INVALID', 'base and head refs are required') };
    const run = spawnSync('ocr', buildOcrArgs({ from, to, rulePath }), {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: platform === 'win32',
      windowsHide: true,
    });
    if (run.error) {
      const timedOut = run.error.code === 'ETIMEDOUT';
      return {
        ok: false,
        summary: unknownSummary(0, timedOut ? 'OCR_TIMEOUT' : 'OCR_UNAVAILABLE',
          timedOut ? `the reviewer timed out after ${timeoutMs} ms` : `the reviewer could not start: ${run.error.message}`),
      };
    }
    let output = null;
    try {
      output = JSON.parse(run.stdout);
    } catch {
      const detail = text(run.stderr).split(/\r?\n/)[0] || text(run.stdout).split(/\r?\n/)[0] || 'no output';
      return { ok: false, summary: unknownSummary(0, 'OCR_OUTPUT_INVALID', `exit ${run.status} without a JSON result: ${detail}`) };
    }
    return { ok: true, output };
  };
}

const SARIF_LEVEL = Object.freeze({ critical: 'error', high: 'error', medium: 'warning', low: 'note' });

/**
 * Render a Guardian OCR summary as SARIF 2.1.0 for Code Scanning. Pure, so the
 * upload step can be wired (and tested) independently of the LLM run. Only
 * evidenced findings become results; coverage gaps are not findings.
 */
function toSarif(summary = {}, { tool = 'huqan-pr-guardian-ocr' } = {}) {
  const findings = [...(summary.blockers || []), ...(summary.advisories || [])];
  const rules = [];
  const seen = new Set();
  for (const finding of findings) {
    const id = `ocr/${finding.category || 'other'}/${finding.severity || 'unknown'}`;
    if (!seen.has(id)) {
      seen.add(id);
      rules.push({ id, name: id, shortDescription: { text: `OpenCodeReview ${finding.severity} finding (${finding.category})` } });
    }
  }
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: { name: tool, version: '1', rules } },
      results: findings.map(finding => ({
        ruleId: `ocr/${finding.category || 'other'}/${finding.severity || 'unknown'}`,
        level: SARIF_LEVEL[finding.severity] || 'note',
        message: { text: finding.content },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: finding.path },
            ...(finding.startLine > 0 ? { region: { startLine: finding.startLine } } : {}),
          },
        }],
      })),
    }],
  };
}

module.exports = Object.freeze({
  OCR_STATUS,
  DEFAULT_BLOCKING_SEVERITIES,
  DEFAULT_TIMEOUT_MS,
  OCR_ENDPOINT_VARS,
  hasOcrEndpoint,
  summarizeOcrReview,
  buildOcrArgs,
  createOcrRunner,
  toSarif,
});
