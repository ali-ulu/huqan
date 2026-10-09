'use strict';

/**
 * HUQAN Coder — the bounded fix loop.
 *
 * "Testleri çalıştırır, başarısızsa yeniden dener ve çalışan sonucu bağımsız
 * doğrular" — without a language model. The task declares WHAT might fix the
 * failure (an ordered list of candidate operations) and WHICH command proves
 * it (a `test` block). This module runs the loop between those two:
 *
 *   for each candidate:  apply (deterministic, gated) -> run test ->
 *                        pass: keep | fail: roll back, next candidate
 *
 * The bounds that make it reviewable, all fail-closed:
 *
 *   - The candidate list is capped (MAX_LOOP_CANDIDATES). A task declaring
 *     more candidates than the cap is refused, not truncated: a loop that
 *     silently drops declared candidates is a loop nobody reviewed.
 *   - Each candidate gets exactly one attempt, because the candidates ARE the
 *     retry. A deterministic transform re-run on the same input produces the
 *     same output, so re-attempting a failed candidate could only reproduce
 *     the same failure. "Retrying" here means trying the next declared fix.
 *   - A candidate whose test fails is rolled back before the next candidate
 *     runs: the tree between attempts is the base tree the gate already
 *     requires, and two unproven patches never stack on one file.
 *   - A test that cannot run (gate refusal, command not found) is treated
 *     like a failed test: the candidate's patch is rolled back. An unproven
 *     patch never lands, and the recorded attempt says why.
 *   - A rollback that cannot be verified stops the loop immediately and
 *     reports ROLLBACK_NOT_VERIFIED — the next candidate must not apply on
 *     top of an un-rolled-back patch.
 *   - When every candidate is exhausted the tree is the base tree and the
 *     outcome is needs_human_decision. Nothing is silently kept.
 *
 * A task without a `test` block never reaches this module: the CLI runs the
 * single-derivation path exactly as before, so existing tasks behave the same.
 * The process boundary lives in lib/coder/test-execution.js — applyDerivation
 * still never spawns one.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { resolvePathWithinRoot } = require('../path-safety');
const { applyDerivation, rollback: rollbackPatch } = require('./apply-derivation');
const { runDeclaredTest } = require('./test-execution');

const MAX_LOOP_CANDIDATES = 8;

const LOOP_OUTCOMES = Object.freeze({
  APPLIED_TESTED: 'applied_tested',
  NEEDS_HUMAN_DECISION: 'needs_human_decision',
});

const LOOP_REFUSALS = Object.freeze({
  CANDIDATES_INVALID: 'CANDIDATES_INVALID',
  CANDIDATES_OVER_CAP: 'CANDIDATES_OVER_CAP',
});

function resolveTaskPath(root, declared) {
  return resolvePathWithinRoot(root, nodePath.resolve(root, String(declared || '')), { allowMissing: true });
}

/**
 * The ordered candidate operations. `task.candidates` when present, else the
 * task's own operation as the single candidate. The transform's own validation
 * remains the authoritative check on an operation's shape; this is only the
 * list-level contract (present, an array, bounded).
 */
function candidatesOf(task, cap) {
  if (task.candidates === undefined || task.candidates === null) {
    return { ok: true, candidates: [task.operation] };
  }
  if (!Array.isArray(task.candidates) || task.candidates.length === 0) {
    return { ok: false, reason: LOOP_REFUSALS.CANDIDATES_INVALID };
  }
  if (task.candidates.length > cap) {
    return { ok: false, reason: LOOP_REFUSALS.CANDIDATES_OVER_CAP };
  }
  return { ok: true, candidates: task.candidates };
}

/**
 * Observe whether the rollback restored the base tree. Exact bytes: a restored
 * file is written back by the same process that captured `before`, so byte
 * equality is the honest check — this is the verifyWrittenPatch pattern run
 * against `before` instead of `after`. A created file is restored when it no
 * longer exists.
 */
function verifyRollback(patch, root, fs) {
  const checks = [];
  for (const change of patch) {
    let absolute;
    try {
      absolute = resolveTaskPath(root, change.path);
    } catch {
      checks.push({ path: change.path, restored: false, detail: 'PATH_ESCAPES_ROOT' });
      continue;
    }
    if (change.before === null || change.before === undefined) {
      checks.push({ path: change.path, restored: !fs.existsSync(absolute) });
      continue;
    }
    let onDisk = null;
    try {
      onDisk = fs.readFileSync(absolute, 'utf8');
    } catch {
      onDisk = null;
    }
    checks.push({ path: change.path, restored: onDisk === change.before });
  }
  return {
    ok: checks.length > 0 && checks.every((check) => check.restored === true),
    checks,
  };
}

function attemptRecord(index, apply, test, extra = {}) {
  return {
    candidate: index + 1,
    apply,
    test,
    kept: false,
    ...extra,
  };
}

/**
 * Run the bounded fix loop against a working tree.
 *
 * `spawn` is an optional caller-injected seam for the test step, mirroring
 * applyDerivation's `fs` injection: tests must be able to fake a process
 * without faking the filesystem. `journal` flows through to each candidate's
 * applyDerivation call, so every attempt leaves its own experience events
 * under its own run id — the loop adds no second persistence authority.
 */
function runFixLoop(options = {}) {
  const {
    task,
    root,
    repoState = {},
    dryRun = false,
    authorized = false,
    workspaceId = 'default',
    fs = nodeFs,
    now = () => new Date().toISOString(),
    runId: requestedRunId = null,
    spawn = null,
    maxCandidates = MAX_LOOP_CANDIDATES,
  } = options;

  if (!task || typeof task !== 'object') throw new TypeError('runFixLoop requires a task object');
  if (!root) throw new TypeError('runFixLoop requires a root directory');
  if (!task.test || typeof task.test !== 'object' || Array.isArray(task.test)) {
    throw new TypeError('runFixLoop requires a task with a test block');
  }

  const cap = Number.isInteger(maxCandidates) && maxCandidates > 0
    ? Math.min(maxCandidates, MAX_LOOP_CANDIDATES) : MAX_LOOP_CANDIDATES;
  const candidateList = candidatesOf(task, cap);
  if (!candidateList.ok) {
    return {
      ok: false,
      outcome: LOOP_OUTCOMES.NEEDS_HUMAN_DECISION,
      reason: candidateList.reason,
      attempts: [],
      kept: [],
      record: null,
    };
  }

  const attempts = [];
  for (let index = 0; index < candidateList.candidates.length; index += 1) {
    const operation = candidateList.candidates[index];
    let testResult = null;
    const result = applyDerivation({
      task: { ...task, operation },
      root,
      repoState,
      dryRun,
      authorized,
      workspaceId,
      fs,
      now,
      journal: options.journal || null,
      runId: requestedRunId ? `${requestedRunId}:c${index + 1}` : null,
      verify: () => {
        testResult = runDeclaredTest({ test: task.test, root, spawn });
        return { ok: testResult.ran === true && testResult.ok === true,
          command: task.test.command, evidenceRef: testResult.reason || 'declared_test_passed' };
      },
      verifyCommand: task.test.command,
      deferExperience: true,
    });

    if (!result.ok) {
      attempts.push(attemptRecord(index, {
        ok: false,
        outcome: result.outcome,
        reason: result.reason,
        detail: result.detail,
      }, null));
      continue;
    }

    if (dryRun) {
      // Nothing landed, so there is nothing to test: the loop reports the
      // dry-run derivation per candidate and runs no process. A dry run that
      // executed the test would be testing the unchanged tree and reporting
      // its result as the candidate's — that would be a fabricated pass.
      attempts.push(attemptRecord(index, {
        ok: true,
        outcome: result.outcome,
      }, { ran: false, ok: null, reason: 'dry_run', outputTail: '' }, {
        derivationHash: result.record.derivationHash,
      }));
      continue;
    }

    const patchIntact = result.patch.every((change) => {
      try { return fs.readFileSync(resolveTaskPath(root, change.path), 'utf8') === change.after; }
      catch { return false; }
    });
    if (testResult && testResult.ran === true && testResult.ok === true && patchIntact) {
      result.finalizeExperience({ test: testResult, kept: true, rolledBack: false });
      attempts.push(attemptRecord(index, {
        ok: true,
        outcome: result.outcome,
      }, testResult, {
        kept: true,
        derivationHash: result.record.derivationHash,
        recordHash: result.record.recordHash,
      }));
      return {
        ok: true,
        outcome: LOOP_OUTCOMES.APPLIED_TESTED,
        reason: null,
        attempts,
        kept: result.patch,
        record: result.record,
      };
    }

    if (testResult && testResult.ok === true && !patchIntact) {
      testResult = { ...testResult, ok: false, reason: 'POST_TEST_PATCH_MISMATCH' };
    }

    rollbackPatch(result.patch, root, fs);
    const verifiedRollback = verifyRollback(result.patch, root, fs);
    result.finalizeExperience({ test: testResult, kept: false,
      rolledBack: verifiedRollback.ok, rollbackChecks: verifiedRollback.checks });
    if (!verifiedRollback.ok) {
      // Fail-closed stop: the tree does not demonstrably hold the base state,
      // so the next candidate may not apply on top of it.
      attempts.push(attemptRecord(index, {
        ok: true,
        outcome: result.outcome,
      }, testResult, {
        rolledBack: false,
        rollbackChecks: verifiedRollback.checks,
        derivationHash: result.record.derivationHash,
      }));
      return {
        ok: false,
        outcome: LOOP_OUTCOMES.NEEDS_HUMAN_DECISION,
        reason: 'ROLLBACK_NOT_VERIFIED',
        attempts,
        kept: [],
        record: null,
      };
    }

    attempts.push(attemptRecord(index, {
      ok: true,
      outcome: result.outcome,
    }, testResult, {
      rolledBack: true,
      derivationHash: result.record.derivationHash,
    }));
  }

  return {
    ok: false,
    outcome: LOOP_OUTCOMES.NEEDS_HUMAN_DECISION,
    reason: 'ALL_CANDIDATES_EXHAUSTED',
    attempts,
    kept: [],
    record: null,
  };
}

/**
 * The loop's own output, in the same shape as formatCoderText: a derivation
 * record the tool observed, not a report the tool wrote about itself.
 */
function formatLoopText(result, repoState) {
  const lines = [];
  lines.push(`Loop:       ${result.outcome}${result.reason ? ` — ${result.reason}` : ''}`);
  for (const attempt of result.attempts) {
    const applyText = attempt.apply.ok
      ? `applied (${attempt.apply.outcome})`
      : `not applied — ${attempt.apply.reason}`;
    let testText = 'test not run';
    if (attempt.test) {
      if (attempt.test.ran) {
        testText = attempt.test.ok
          ? `test ok (${attempt.test.exitCode})`
          : `test failed — ${attempt.test.reason || `exit ${attempt.test.exitCode}`}`;
      } else {
        testText = `test not run — ${attempt.test.reason}`;
      }
    }
    const keptText = attempt.kept ? ' KEPT' : '';
    const rollbackText = attempt.rolledBack === false ? ' ROLLBACK_UNVERIFIED' : '';
    lines.push(`  #${attempt.candidate}: ${applyText}; ${testText}${keptText}${rollbackText}`);
  }
  if (!repoState.known) lines.push('Repo state: unknown (git unavailable) — gate saw a clean, non-main tree');
  if (Array.isArray(repoState.untrackedPaths) && repoState.untrackedPaths.length) {
    lines.push('Untracked:  the gate counts these files as dirt (gitignore them or commit them)');
    for (const untracked of repoState.untrackedPaths) lines.push(`  ${untracked}`);
  }
  if (result.ok && result.record) {
    lines.push(`Derivation: ${result.record.derivationHash}`);
    lines.push(`Record:     ${result.record.recordHash}`);
  }
  if (result.ok && Array.isArray(result.kept) && result.kept.length) {
    lines.push('');
    lines.push('Files written:');
    for (const change of result.kept) lines.push(`  ${change.path}`);
  }
  return lines.join('\n');
}

module.exports = {
  LOOP_OUTCOMES,
  LOOP_REFUSALS,
  MAX_LOOP_CANDIDATES,
  formatLoopText,
  runFixLoop,
};
