'use strict';

/**
 * HUQAN Coder — OpenCodeReview verifier for the observed-verification seam (#3196).
 *
 * `ocr review` is an LLM review: it is not deterministic, so it can only ever
 * be an observed signal next to the derivation, never part of it. The seam
 * already guarantees that (it never touches the outcome or the derivationHash);
 * this module only turns one `ocr` run into `{ ok, command, evidenceRef }`.
 *
 * The seam has a single boolean, and two very different reasons to say false:
 * the review found something, or the review could not be run or could not cover
 * the change. The second is not a finding about the code, so evidenceRef always
 * starts with which one it is -- `findings:` or `unverifiable:` -- and a reader
 * never has to guess (same distinction as UNVERIFIABLE_REASONS in
 * lib/pr-guardian/derivation-check.js).
 *
 * Only findings on the task's own allowedPaths count: the working tree may hold
 * untracked files the derivation did not write, and a finding there says
 * nothing about this change.
 */

const childProcess = require('node:child_process');

const OCR_ARGS = Object.freeze(['review', '--format', 'json', '--audience', 'agent']);
const OCR_COMMAND = `ocr ${OCR_ARGS.join(' ')}`;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_BLOCKING_SEVERITIES = Object.freeze(['critical', 'high']);
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function unverifiable(reason) {
  return { ok: false, command: OCR_COMMAND, evidenceRef: `unverifiable: ${reason}` };
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function firstLine(text) {
  return String(text || '').trim().split(/\r?\n/u)[0] || '';
}

function sessionSuffix(output) {
  return output && output.session_id ? `; session ${output.session_id}` : '';
}

/**
 * Pure reduction of one `ocr review --format json` result. Kept apart from the
 * process call so every branch is testable without an LLM.
 */
function classifyOcrOutput(output, { paths = [], blockingSeverities = DEFAULT_BLOCKING_SEVERITIES } = {}) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return unverifiable('ocr output is not a JSON object');
  const manifest = output.manifest && typeof output.manifest === 'object' ? output.manifest : null;
  const state = manifest && manifest.terminal_state ? manifest.terminal_state : output.status;
  if (state === 'failed') return unverifiable(`ocr review failed${output.message ? ` — ${output.message}` : ''}`);
  if (state === 'skipped') return unverifiable('ocr selected no reviewable file (unsupported extension or excluded path)');

  const scope = new Set(paths.map(normalizePath));
  const blocking = new Set(blockingSeverities);
  const comments = Array.isArray(output.comments) ? output.comments : [];
  const inScope = comments.filter((comment) => comment && scope.has(normalizePath(comment.path)));
  const blockers = inScope.filter((comment) => blocking.has(String(comment.severity || '').toLowerCase()));

  if (blockers.length > 0) {
    return {
      ok: false,
      command: OCR_COMMAND,
      evidenceRef: `findings: ${blockers.length} blocking (${[...blocking].join('/')}) of ${inScope.length} on the change${sessionSuffix(output)}`,
    };
  }
  // Nothing blocking, but a partial run did not look at everything: absence of
  // findings on files it never reviewed is not a pass.
  if (state === 'partial') return unverifiable(`ocr covered the change only partially${sessionSuffix(output)}`);
  return {
    ok: true,
    command: OCR_COMMAND,
    evidenceRef: `findings: 0 blocking of ${inScope.length} on the change${sessionSuffix(output)}`,
  };
}

/**
 * Build the synchronous `verify(root, task)` the seam expects.
 *
 * On Windows `ocr` is an npm `.cmd` shim, which a shell-less spawn cannot start
 * (and Node refuses to spawn `.cmd` without a shell). The arguments are the
 * fixed constants above, so running through the shell there injects nothing.
 */
function createOcrVerifier({
  spawnSync = childProcess.spawnSync,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  blockingSeverities = DEFAULT_BLOCKING_SEVERITIES,
  platform = process.platform,
} = {}) {
  return function verifyWithOcr(root, task) {
    const paths = task && Array.isArray(task.allowedPaths) ? task.allowedPaths : [];
    const run = spawnSync('ocr', [...OCR_ARGS], {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: platform === 'win32',
      windowsHide: true,
    });
    if (run.error) {
      const timedOut = run.error.code === 'ETIMEDOUT';
      return unverifiable(timedOut ? `ocr timed out after ${timeoutMs} ms` : `ocr unavailable — ${run.error.message}`);
    }
    let output;
    try {
      output = JSON.parse(run.stdout);
    } catch {
      const detail = firstLine(run.stderr) || firstLine(run.stdout) || 'no output';
      return unverifiable(`ocr exited ${run.status} without a JSON result — ${detail}`);
    }
    return classifyOcrOutput(output, { paths, blockingSeverities });
  };
}

module.exports = {
  OCR_COMMAND,
  classifyOcrOutput,
  createOcrVerifier,
};
