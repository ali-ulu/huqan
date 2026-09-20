#!/usr/bin/env node
'use strict';

/**
 * Orchestrates `npm run verify` (issue #2651, task M6).
 *
 * The verify gate used to be a shell one-liner in package.json. That shape is
 * what let the gate rot: every new check had to be manually appended to the
 * chain, so checks added later (action pins, license compliance) silently did
 * not run, and the ordering — environment first, slow tests last — lived only
 * in the reader's memory of the line. It also ran every check even after an
 * early one failed, burning minutes of CI before reporting the first error.
 *
 * This module owns the manifest instead. A check participates in the gate by
 * appearing in STAGES below; nothing else needs editing. Stages run in order,
 * the run stops at the first failing stage, and a per-stage pass/fail summary
 * with timings is printed at the end. The exit code is non-zero if any stage
 * failed.
 *
 * Ordering contract: fast checks first (environment, lint, architecture and
 * boundary checks), slow checks last (the full test suite). A new check
 * belongs with its speed class, not at the end.
 *
 * The tests stage walks the filesystem: a scratch test file under test/ that
 * git ignores (see .gitignore) still runs locally and turns the stage red
 * with no tracked change at fault. Keep personal scratch tests as local-*.js
 * at the repo root, the way .gitignore prescribes.
 */

const { spawnSyncWindowsAware } = require('./spawn-windows-aware');

// A fast check that is still running after ten minutes is hung; the test
// suite gets a full hour because it legitimately runs long.
const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60 * 1000;
const TEST_STAGE_TIMEOUT_MS = 60 * 60 * 1000;

const STAGES = [
  { name: 'environment', command: ['node', 'scripts/verify-test-environment.js'] },
  { name: 'lint', command: ['npm', 'run', 'lint', '--silent'] },
  { name: 'cycles', command: ['npm', 'run', 'check:cycles', '--silent'] },
  { name: 'module-boundary', command: ['npm', 'run', 'check:module-boundary', '--silent'] },
  { name: 'layers', command: ['npm', 'run', 'check:layers', '--silent'] },
  { name: 'file-size', command: ['npm', 'run', 'check:file-size', '--silent'] },
  { name: 'action-pins', command: ['npm', 'run', 'check:action-pins', '--silent'] },
  { name: 'licenses', command: ['npm', 'run', 'check:licenses', '--silent'] },
  { name: 'docs-drift', command: ['npm', 'run', 'check:docs-drift', '--silent'] },
  // The tracker check compares the committed artifact against the live tree
  // relative to a git ref; without one it refuses to guess. origin/main is
  // the drift baseline a local pre-push run actually wants.
  { name: 'architecture-trackers', command: ['node', 'scripts/architecture-snapshot.js', '--check', '--base-ref=origin/main'] },
  { name: 'package-closure', command: ['npm', 'run', 'check:package-closure', '--silent'] },
  { name: 'property-tests', command: ['npm', 'run', 'test:property', '--silent'] },
  { name: 'tests', command: ['npm', 'test'], slow: true },
];

/**
 * Run one stage and normalize its result.
 *
 * Windows note: `npm` is an `npm.cmd` shim there, which spawnSync refuses to
 * launch directly (CVE-2024-27980 hardening) and a bare `shell: true` breaks
 * again on executable paths that contain spaces (for example
 * `C:\Program Files\nodejs\node.exe`). spawnSyncWindowsAware carries the
 * working workaround and is what every other script-invoking call site uses.
 *
 * @param {{name: string, command: string[], slow?: boolean}} stage
 * @param {{timeoutMs?: number}} [opts]
 * @returns {{name: string, ok: boolean, timedOut: boolean, abnormal: string|null, durationMs: number, output: string}}
 */
function runStage(stage, opts = {}) {
  const timeoutMs = opts.timeoutMs || (stage.slow ? TEST_STAGE_TIMEOUT_MS : DEFAULT_STAGE_TIMEOUT_MS);
  const command = stage.command.slice();
  if (process.platform === 'win32' && command[0] === 'npm') command[0] = 'npm.cmd';
  const startedAt = Date.now();
  const result = spawnSyncWindowsAware(command[0], command.slice(1), {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  // A stage can end without a usable exit code: killed from outside (signal)
  // or never started (spawn error). Both are failures, but a plain FAIL hides
  // the difference between "the checker found a problem" and "the checker was
  // killed mid-run", which is exactly the difference a red gate must show.
  const abnormal = result.error
    ? `spawn error: ${result.error.message}`
    : result.signal
      ? `killed by signal ${result.signal}`
      : null;
  return {
    name: stage.name,
    ok: !result.error && result.status === 0,
    timedOut,
    abnormal,
    durationMs: Date.now() - startedAt,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

/**
 * Run stages in order, stopping at the first failure.
 *
 * @param {Array<{name: string, command: string[], slow?: boolean}>} [stages]
 * @returns {Array<ReturnType<typeof runStage>>} results for the stages that ran
 */
function runVerify(stages = STAGES) {
  const results = [];
  for (const stage of stages) {
    const result = runStage(stage);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Human-readable pass/fail summary with per-stage timings. A failing stage's
 * own output is included (tail only, so one hung checker cannot flood the
 * console) followed by an explicit list of stages that did not run.
 *
 * @param {Array<ReturnType<typeof runStage>>} results
 * @param {Array<{name: string}>} [stages] full manifest, for the skipped list
 * @returns {string}
 */
function renderSummary(results, stages = STAGES) {
  const lines = [];
  for (const result of results) {
    const verdict = result.ok ? 'PASS' : result.timedOut ? 'TIMEOUT' : 'FAIL';
    const reason = result.abnormal ? `, ${result.abnormal}` : '';
    lines.push(`${verdict} ${result.name} (${formatSeconds(result.durationMs)}${reason})`);
    if (!result.ok && result.output) {
      const tail = result.output.length > 4000 ? `…${result.output.slice(-4000)}` : result.output;
      lines.push(...tail.split(/\r?\n/).map((textLine) => `  ${textLine}`));
    }
  }
  const ran = new Set(results.map((result) => result.name));
  const skipped = stages.filter((stage) => !ran.has(stage.name));
  if (skipped.length > 0) {
    lines.push(`NOT RUN (stopped at first failure): ${skipped.map((stage) => stage.name).join(', ')}`);
  }
  const passed = results.filter((result) => result.ok).length;
  const totalMs = results.reduce((total, result) => total + result.durationMs, 0);
  lines.push(`verify: ${passed}/${stages.length} checks passed in ${formatSeconds(totalMs)}`);
  return lines.join('\n');
}

if (require.main === module) {
  const results = runVerify();
  console.log(renderSummary(results));
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}

module.exports = { STAGES, runStage, runVerify, renderSummary };
