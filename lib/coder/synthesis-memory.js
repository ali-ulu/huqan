'use strict';

const { selectCandidate, readTarget } = require('./learned-candidate');
const { readArithmeticTarget } = require('../experience/expression-adaptation');
const { readArrayFoldTarget } = require('../experience/array-fold-program');
const { runFixLoop, MAX_LOOP_CANDIDATES } = require('./fix-loop');
const { randomUUID } = require('node:crypto');

const refused = reason => ({ ok: false, outcome: 'needs_human_decision', reason, attempts: [], kept: [], record: null });
function candidateBudget(options) {
  return Number.isInteger(options.maxCandidates) && options.maxCandidates > 0
    ? Math.min(options.maxCandidates, MAX_LOOP_CANDIDATES) : MAX_LOOP_CANDIDATES;
}

function runMemoryFirstSynthesis(options, { inspect, runFresh }) {
  const budget = candidateBudget(options);
  const reuse = { requested: true, attempted: false, budget };
  const attach = result => ({ ...result, synthesis: { family: options.task?.synthesis?.family,
    searchBudget: 0, enumerated: 0, ...result.synthesis, memoryReuse: { ...reuse } } });
  let context;
  try { context = inspect({ task: options.task, content: readTarget(options.root, options.task?.operation?.path) }); }
  catch (error) { return attach(refused(error.code || 'SYNTHESIS_TARGET_UNAVAILABLE')); }
  if (!context.ok) return attach(refused(context.reason));
  if (!options.journal) return attach(refused('SYNTHESIS_MEMORY_REQUIRES_JOURNAL'));
  if (options.dryRun === true) {
    reuse.reason = 'dry_run';
    return attach(runFresh(options));
  }
  let proposedExpression;
  const selected = selectCandidate({ ...options, workspaceId: options.workspaceId || 'default',
    allowTransfer: true, allowAdaptation: true,
    acceptCandidate: (resolved, content) => {
      const params = resolved.task.experience.candidates[0].params;
      const readProposed = options.task.synthesis.family === 'array-fold' ? readArrayFoldTarget : readArithmeticTarget;
      const proposed = readProposed(content.replace(params.oldText, () => params.newText),
        { allowLeaf: true, functionName: options.task.synthesis.functionName });
      let matches;
      try { matches = proposed && context.examples.every(row => Object.is(proposed.evaluate(row.input), row.expected)); }
      catch { return false; }
      if (matches) proposedExpression = proposed.canonicalExpression;
      return matches;
    } });
  if (!selected.ok) {
    reuse.reason = selected.reason;
    return attach(selected.reason === 'no_applicable_candidate' ? runFresh(options) : refused(selected.reason));
  }
  reuse.attempted = true;
  const runId = options.runId || `synthesis:${randomUUID()}`;
  const memoryRunId = `${runId}:memory`;
  const trial = runFixLoop({ ...options, task: selected.task, maxCandidates: 1, runId: memoryRunId });
  const params = selected.task.experience.candidates[0].params;
  if (trial.ok) {
    reuse.outcome = 'applied_tested';
    const operation = { type: 'replace_text', path: params.path, find: params.oldText, replace: params.newText };
    const sourceRunId = `${memoryRunId}:c1`;
    const memory = options.task.synthesis.rememberFile !== undefined
      ? { ok: true, state: 'reused_existing_candidate', selectedFile: selected.selectedFile,
        requestedFile: options.task.synthesis.rememberFile } : null;
    return attach({ ...trial, synthesis: { family: options.task.synthesis.family,
      searchBudget: 0, enumerated: 0, candidateLimit: budget, exampleCount: context.examples.length,
      baselineMatches: context.baselineMatches, candidateMatches: context.examples.length,
      operation, sourceRunId, selectedCandidate: 1, memory } });
  }
  const attempt = trial.attempts[0];
  // Only an actually failed independent test with verified rollback may lead
  // to another strategy. Gate/source/readback failures never trigger fallback.
  if (!attempt?.test?.ran || attempt.test.ok !== false || attempt.test.reason !== 'TEST_FAILED'
    || !Number.isInteger(attempt.test.exitCode)
    || attempt.test.exitCode === 0 || attempt.rolledBack !== true
    || trial.reason === 'ROLLBACK_NOT_VERIFIED') return attach(trial);
  reuse.outcome = 'rolled_back';
  if (budget <= 1) return attach({ ...trial, reason: 'SYNTHESIS_BUDGET_EXHAUSTED' });
  const fresh = runFresh({ ...options, maxCandidates: budget - 1, runId: `${runId}:search` },
    { excludeReplacement: proposedExpression });
  reuse.fallback = true;
  return attach({ ...fresh, attempts: [
    { ...attempt, stage: 'memory' },
    ...fresh.attempts.map(row => ({ ...row, candidate: row.candidate + 1, stage: 'search' })),
  ], synthesis: { ...fresh.synthesis,
    searchSelectedCandidate: fresh.synthesis?.selectedCandidate || null,
    selectedCandidate: fresh.synthesis?.selectedCandidate ? fresh.synthesis.selectedCandidate + 1 : null } });
}

module.exports = { runMemoryFirstSynthesis, candidateBudget };
