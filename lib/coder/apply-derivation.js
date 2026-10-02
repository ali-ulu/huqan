'use strict';

/**
 * HUQAN Coder — the pipeline that lets a deterministic transform touch disk.
 *
 * lib/deterministic-task-runner.js is a pure function: files in, patch out. It
 * has never been wired to anything but benchmark tests, so nothing it produced
 * could reach a working tree. This module is that wiring, and it deliberately
 * routes every write through the same gate that governs any other code change
 * in this system:
 *
 *   read declared inputs -> run transform -> evaluateCodeChange -> write
 *
 * The gate is not advisory here. If it answers anything other than `allow`,
 * nothing is written, and the refusal is recorded with its reason. A transform
 * that produced a perfectly good patch still does not get to land it.
 *
 * Note which party reports the outcome. The transform does not tell us it
 * succeeded; we observe the patch it returned. The gate does not apply its own
 * verdict; this module applies it. Whoever decides must not also be the only
 * one who records the decision.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { performance } = require('node:perf_hooks');

const { STATUS, runTask } = require('../deterministic-task-runner');
const { evaluateCodeChange, CODE_CHANGE_GATE_DECISIONS } = require('../code-change-gate');
const { resolvePathWithinRoot } = require('../path-safety');
const { DERIVATION_OUTCOMES, buildDerivationRecord, verifyDerivationHash } = require('./derivation-record');
const { runObservedVerification } = require('./observed-verification');
const { OUTCOME_STATUSES } = require('../experience/contract');
const { createCoderReporter, coderRunId, sha256 } = require('./experience-reporter');
const { routeCoderProcedure } = require('../experience/coder-routing-runtime');

const REFUSAL_REASONS = Object.freeze({
  PATH_ESCAPES_ROOT: 'PATH_ESCAPES_ROOT',
  READ_FAILED: 'READ_FAILED',
  TRANSFORM_REFUSED: 'TRANSFORM_REFUSED',
  GATE_REFUSED: 'GATE_REFUSED',
  EMPTY_PATCH: 'EMPTY_PATCH',
  WRITE_FAILED: 'WRITE_FAILED',
});

/**
 * Task paths are repo-relative, but resolvePathWithinRoot() resolves its
 * candidate against process.cwd(). Joining to `root` first is what makes the
 * containment check mean what it looks like it means -- without it, a task run
 * from a different working directory would be checked against the wrong tree.
 * `allowMissing` is required because several transforms create new files.
 */
function resolveTaskPath(root, declared) {
  return resolvePathWithinRoot(root, nodePath.resolve(root, String(declared || '')), { allowMissing: true });
}

function countLines(content) {
  if (typeof content !== 'string' || content === '') return 0;
  return content.split('\n').length;
}

/**
 * Line counts, not a real diff. The gate uses additions/deletions only for
 * breadth thresholds, so a whole-file count is the honest conservative answer:
 * it can over-report the size of a change, never under-report it.
 */
function summarizeChange(change) {
  const before = countLines(change.before);
  const after = countLines(change.after);
  return {
    path: change.path,
    status: change.before === null || change.before === undefined ? 'added' : 'modified',
    additions: Math.max(0, after - Math.min(before, after)) || after,
    deletions: before,
  };
}

/**
 * Read every path the task declared. A declared path that is missing is left
 * out of `files` rather than treated as an error: several transforms
 * legitimately create a file that does not exist yet, and the runner's own
 * PATH_NOT_ALLOWED_OR_MISSING check is the right place to reject the cases
 * where absence is actually wrong.
 */
function readDeclaredFiles(allowedPaths, root, fs) {
  const files = {};
  for (const declared of allowedPaths) {
    let absolute;
    try {
      absolute = resolveTaskPath(root, declared);
    } catch {
      return { ok: false, reason: REFUSAL_REASONS.PATH_ESCAPES_ROOT, detail: String(declared) };
    }
    try {
      files[declared] = fs.readFileSync(absolute, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      return { ok: false, reason: REFUSAL_REASONS.READ_FAILED, detail: `${declared}: ${error.message}` };
    }
  }
  return { ok: true, files };
}

/**
 * Apply the patch, rolling back everything already written if any single write
 * fails. A half-applied deterministic change is worse than no change: it is
 * neither the old state nor the derived one, and its derivationHash would
 * describe a tree that does not exist.
 *
 * NOTE for anyone auditing this file: these are real filesystem writes. The
 * calls arrive through the injected `fs` handle rather than the imported
 * `nodeFs`, and scripts/enforcement-coverage.js follows that indirection: the
 * destructuring default `fs = nodeFs` binds the handle to the required
 * `node:fs` namespace, so `fs.mkdirSync`, `fs.writeFileSync` and `fs.rmSync`
 * here are recorded under this file in coverage-manifest.json. The injection
 * exists because the rollback test has to force a write failure; it is no
 * longer a blind spot, and the manifest is where that is checked.
 */
function writePatch(patch, root, fs) {
  const written = [];
  for (const change of patch) {
    const absolute = resolveTaskPath(root, change.path);
    try {
      fs.mkdirSync(nodePath.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, change.after, 'utf8');
      written.push(change);
    } catch (error) {
      rollback(written, root, fs);
      return { ok: false, reason: REFUSAL_REASONS.WRITE_FAILED, detail: `${change.path}: ${error.message}` };
    }
  }
  return { ok: true };
}

function rollback(written, root, fs) {
  for (const change of written.slice().reverse()) {
    const absolute = resolveTaskPath(root, change.path);
    try {
      if (change.before === null || change.before === undefined) fs.rmSync(absolute, { force: true });
      else fs.writeFileSync(absolute, change.before, 'utf8');
    } catch {
      // Rollback is best-effort by nature: if the filesystem is refusing writes
      // there is nothing further this process can do, and swallowing here keeps
      // the original write failure as the reported cause rather than masking it.
    }
  }
}

function refusal(reason, detail, context) {
  return {
    ok: false,
    outcome: DERIVATION_OUTCOMES.REFUSED,
    reason,
    detail: detail || '',
    record: buildDerivationRecord({ ...context, outcome: DERIVATION_OUTCOMES.REFUSED }),
  };
}

/**
 * Attach the Experience pilot report to a result. A null reporter (no
 * journal) adds nothing — the pipeline runs exactly as before.
 */
function withExperience(result, reporter) {
  if (!reporter) return result;
  return {
    ...result,
    experience: { runId: reporter.runId, failed: reporter.failed, events: reporter.events, writeCost: reporter.writeCost },
  };
}

/**
 * Disk re-read: compare what is on disk now against the patch the transform
 * produced. Independence here means memory-vs-disk, not transform-vs-itself —
 * the bytes compared are read back through the same fs handle that wrote
 * them, so a test double that lies about writes is caught by the same lie
 * only if it also lies about reads.
 */
function verifyWrittenPatch(patch, root, fs) {
  const checks = [];
  for (const change of patch) {
    let absolute;
    try {
      absolute = resolveTaskPath(root, change.path);
    } catch {
      checks.push({ path: change.path, match: false, detail: 'PATH_ESCAPES_ROOT' });
      continue;
    }
    let onDisk;
    try {
      onDisk = fs.readFileSync(absolute, 'utf8');
    } catch (error) {
      checks.push({ path: change.path, match: false, detail: `READ_FAILED: ${error.message}` });
      continue;
    }
    const expected = sha256(change.after);
    const actual = sha256(onDisk);
    checks.push({
      path: change.path,
      match: expected === actual,
      expectedSha256: expected,
      actualSha256: actual,
    });
  }
  return checks;
}

/**
 * Run one deterministic coding task against a working tree.
 *
 * `verify` (#3031) is an optional caller-injected seam, run after the write
 * lands and before the record is finalized; see observed-verification.js.
 * The coder core itself never spawns a process.
 */
function applyDerivation(options = {}) {
  const {
    task,
    root,
    repoState = {},
    dryRun = false,
    workspaceId = 'default',
    fs = nodeFs,
    now = () => new Date().toISOString(),
    policy = null,
    journal = null,
    runId: requestedRunId = null,
    verify = null,
    verifyCommand = null,
  } = options;

  if (!task || typeof task !== 'object') throw new TypeError('applyDerivation requires a task object');
  if (!root) throw new TypeError('applyDerivation requires a root directory');

  const allowedPaths = Array.isArray(task.allowedPaths) ? task.allowedPaths : [];
  const operationType = task.operation && task.operation.type ? String(task.operation.type) : '';
  const createdAt = now();
  const runId = requestedRunId || coderRunId(task, createdAt);
  const reporter = createCoderReporter(journal, { runId, workspaceId, task });
  const baseContext = {
    taskId: task.id,
    workspaceId,
    operationType,
    operation: task.operation,
    allowedPaths,
    createdAt,
  };

  function refuseWithExperience(reason, detail, context, causeEventId, extra = {}) {
    if (reporter) {
      reporter.failedRefusal({ reason, detail, causeEventId });
      return withExperience({ ...refusal(reason, detail, context), ...extra }, reporter);
    }
    return { ...refusal(reason, detail, context), ...extra };
  }

  if (reporter) {
    reporter.started({ repoState, createdAt });
    reporter.proposed();
  }

  const read = readDeclaredFiles(allowedPaths, root, fs);
  if (!read.ok) {
    return refuseWithExperience(read.reason, read.detail, {
      ...baseContext,
      inputFiles: {},
      patch: [],
      runnerStatus: STATUS.UNSUPPORTED_TASK,
      runnerReason: read.reason,
    });
  }

  const routingStarted = performance.now();
  const routed = routeCoderProcedure({ task, root, journal, workspaceId, requestId: runId, files: read.files });
  const routingMs = performance.now() - routingStarted;
  if (!routed.ok) return refuseWithExperience(routed.code, '', { ...baseContext, inputFiles: read.files, patch: [] });
  const result = runTask({ ...routed.task, files: read.files });
  const context = {
    ...baseContext,
    operation: routed.task.operation,
    inputFiles: read.files,
    patch: result.patch,
    runnerStatus: result.status,
    runnerReason: result.reason,
  };

  if (result.status !== STATUS.COMPLETED) {
    return refuseWithExperience(REFUSAL_REASONS.TRANSFORM_REFUSED, result.reason, context);
  }
  if (!result.patch.length) {
    return refuseWithExperience(REFUSAL_REASONS.EMPTY_PATCH, 'transform completed without changing any file', context);
  }

  const changes = result.patch.map(summarizeChange);
  const gate = evaluateCodeChange({
    files: changes,
    intent: task.intent || `deterministic transform: ${operationType}`,
    operationType: 'write',
    diffSummary: `${changes.length} file(s) derived by ${operationType}`,
    patchMetadata: {
      fileCount: changes.length,
      totalAdditions: changes.reduce((sum, change) => sum + change.additions, 0),
      totalDeletions: changes.reduce((sum, change) => sum + change.deletions, 0),
    },
    repoState,
    metadata: { workspaceId },
    policyOverride: policy,
  });

  const gated = { ...context, gate };

  if (reporter) reporter.decided(gate);

  if (gate.decision !== CODE_CHANGE_GATE_DECISIONS.ALLOW) {
    return refuseWithExperience(REFUSAL_REASONS.GATE_REFUSED, gate.reason, gated, `${runId}:policy_decided`, { gate });
  }
  if (reporter && routed.decision) {
    const recorded = reporter.routed(routed.decision, routingMs);
    if (!recorded.ok) return refuseWithExperience('routing_record_failed', '', gated, `${runId}:policy_decided`, { gate });
  }
  if (dryRun) {
    if (reporter) {
      reporter.closed({
        executionStatus: 'completed',
        outcomeStatus: OUTCOME_STATUSES.UNKNOWN,
        verdict: 'dry_run',
        causeEventId: `${runId}:policy_decided`,
      });
    }
    return withExperience({
      ok: true,
      outcome: DERIVATION_OUTCOMES.DRY_RUN,
      reason: null,
      detail: '',
      gate,
      patch: result.patch,
      record: buildDerivationRecord({ ...gated, outcome: DERIVATION_OUTCOMES.DRY_RUN }),
    }, reporter);
  }

  if (reporter) reporter.executionStarted();
  const writeCost = typeof journal?.writeCost === 'function' ? journal.writeCost(runId) : null;
  if (writeCost?.decision === 'refuse') {
    return refuseWithExperience('WRITE_COST_BUDGET_REFUSED', writeCost.reason, gated,
      `${runId}:execution_started`, { gate, writeCost });
  }
  const written = writePatch(result.patch, root, fs);
  if (!written.ok) {
    return refuseWithExperience(written.reason, written.detail, gated, `${runId}:execution_started`, { gate });
  }

  const record = buildDerivationRecord({
    ...gated,
    outcome: DERIVATION_OUTCOMES.APPLIED,
    observedVerification: runObservedVerification({ verify, verifyCommand, root, task }),
  });
  if (reporter) {
    reporter.executionFinished({ changes: result.patch, derivationHash: record.derivationHash });
    reporter.verificationStarted();
    const checks = verifyWrittenPatch(result.patch, root, fs);
    const allVerified = checks.length > 0 && checks.every((check) => check.match === true);
    const verification = reporter.verified({
      verified: allVerified, checks,
      nativeReadback: fs === nodeFs,
      provenance: verifyDerivationHash(record).ok
        && record.inputs.length > 0
        && record.inputs.every((input) => input.sha256 !== 'absent'),
      permission: gate.decision === CODE_CHANGE_GATE_DECISIONS.ALLOW,
    });
    // Observed classes: the run wrote to the filesystem, so `filesystem`
    // observed. Nothing else was installed, so nothing else is claimed.
    reporter.closed({
      outcomeStatus: verification.outcomeStatus,
      observed: ['filesystem'],
    });
  }

  return withExperience({
    ok: true,
    outcome: DERIVATION_OUTCOMES.APPLIED,
    reason: null,
    detail: '',
    gate,
    patch: result.patch,
    record,
    observedVerification: record.observedVerification,
  }, reporter);
}

module.exports = {
  REFUSAL_REASONS,
  applyDerivation,
};
