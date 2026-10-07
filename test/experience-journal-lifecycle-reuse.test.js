'use strict';

/**
 * Issue #3495 characterization — journal/step lifecycle reuse and the trace
 * cost bound, as they already ship. No runtime behavior is added here; this
 * file locks two absences the issue names so future wiring cannot silently
 * cross them:
 *
 *  - the raw journal trace (event bodies and payloads) is never carried into
 *    the artifact the compiler hands forward, so it cannot reach a prompt or an
 *    execution automatically. The reusable artifact is the compiled procedure,
 *    whose only trace representation is the sealed source hash;
 *  - a measurement/verification gap is not a task failure. A run whose
 *    execution completed but whose measurement is `unknown` is `ineligible`,
 *    never `negative_example`; only a run that actually failed is admitted to
 *    the failure pool, and neither is ever proposed as a procedure.
 *
 * The other two claims in the issue are already pinned elsewhere and are cited,
 * not duplicated: the deterministic write/read cost bound (`writeCostGuard`) in
 * test/experience-write-cost-budget.test.js, the production budget wiring in
 * test/experience-production-budget.test.js, and the Cognitive Lab's separate
 * `measurement_error` bucket in test/cognitive-lab-comparison.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createExperienceJournal } = require('../lib/experience/journal');
const { buildLearningProposal } = require('../lib/experience/learning-intake');
const { runExperienceLearnCommand } = require('../lib/cli-experience-learn');

const WORKSPACE = 'workspace-a';
const PARAMS = { path: 'notes.txt', oldText: 'draft', newText: 'final' };
const PROOFS = Object.freeze({
  integrity: true, coverage: true, verification: true, provenance: true, permission: true,
});

// A value that exists only inside a raw event payload. If any reusable artifact
// or rendered surface ever contains it, the raw trace leaked forward.
const SENTINEL = 'RAW-TRACE-SENTINEL-3495';

const PROCEDURE_KEYS = Object.freeze([
  'evidenceRefs', 'hash', 'kind', 'params', 'parentHash',
  'postconditions', 'preconditions', 'revision', 'scope', 'version',
]);

function append(journal, event) {
  const result = journal.append({ workspaceId: WORKSPACE, ...event });
  assert.equal(result.ok, true, `${event.type} was refused: ${result.code || 'unknown'}`);
  return result;
}

/** The step-lifecycle vocabulary the runtime writer emits (#3033, #3151). */
function seedLifecycleRun(journal, runId) {
  append(journal, { runId, eventId: 'e1', type: 'run_started' });
  append(journal, { runId, eventId: 'e2', type: 'action_proposed', payload: { tool: 'learn', raw: SENTINEL } });
  append(journal, { runId, eventId: 'e3', type: 'policy_decided', causedByEventId: 'e2', payload: { decision: 'allow', raw: SENTINEL } });
  append(journal, { runId, eventId: 'e4', type: 'execution_started', causedByEventId: 'e3', payload: { tool: 'learn' } });
  append(journal, { runId, eventId: 'e5', type: 'memory_update', causedByEventId: 'e4', payload: { learned: 2, raw: SENTINEL } });
  append(journal, { runId, eventId: 'e6', type: 'verification', causedByEventId: 'e5', verdict: 'verified', proofs: PROOFS, payload: { record: { note: SENTINEL } } });
  append(journal, { runId, eventId: 'e7', type: 'execution_finished', causedByEventId: 'e6', executionStatus: 'completed' });
  append(journal, { runId, eventId: 'e8', type: 'run_closed', causedByEventId: 'e7', executionStatus: 'completed', outcomeStatus: 'verified' });
}

/** Execution completed, but the measurement could not be scored: `unknown`. */
function seedMeasurementGapRun(journal, runId) {
  append(journal, { runId, eventId: 'm1', type: 'run_started' });
  append(journal, { runId, eventId: 'm2', type: 'execution_started', payload: { raw: SENTINEL } });
  append(journal, { runId, eventId: 'm3', type: 'verification', causedByEventId: 'm2', verdict: 'unknown', payload: { record: { note: SENTINEL } } });
  append(journal, { runId, eventId: 'm4', type: 'execution_finished', causedByEventId: 'm3', executionStatus: 'completed' });
  append(journal, { runId, eventId: 'm5', type: 'run_closed', causedByEventId: 'm4', executionStatus: 'completed', outcomeStatus: 'unknown' });
}

/** The task itself failed and the failure was evidenced as a measurement. */
function seedTaskFailureRun(journal, runId) {
  append(journal, { runId, eventId: 'f1', type: 'run_started' });
  append(journal, { runId, eventId: 'f2', type: 'execution_started', payload: { raw: SENTINEL } });
  append(journal, { runId, eventId: 'f3', type: 'failure', causedByEventId: 'f2', payload: { reason: 'task failed', raw: SENTINEL } });
  append(journal, { runId, eventId: 'f4', type: 'verification', causedByEventId: 'f3', verdict: 'failed', proofs: { failureEvidence: true, permission: true } });
  append(journal, { runId, eventId: 'f5', type: 'execution_finished', causedByEventId: 'f4', executionStatus: 'failed' });
  append(journal, { runId, eventId: 'f6', type: 'run_closed', causedByEventId: 'f5', executionStatus: 'failed', outcomeStatus: 'failed' });
}

test('a sealed run is reused as a compiled procedure carrying only its sealed hash, never the raw trace', () => {
  const journal = createExperienceJournal();
  seedLifecycleRun(journal, 'run-positive');

  const proposal = buildLearningProposal(journal, {
    runId: 'run-positive', workspaceId: WORKSPACE, params: PARAMS,
  });

  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  assert.equal(proposal.eligibility, 'positive_procedure');
  assert.equal(proposal.admission.decision, 'admitted');
  assert.equal(proposal.registered, false, 'reuse proposes, it never installs');

  // The only representation of the trace is the sealed projection hash.
  assert.deepEqual(proposal.candidate.trace.sources, [proposal.sourceHash]);
  assert.deepEqual(proposal.procedure.evidenceRefs, [proposal.sourceHash]);
  assert.deepEqual(proposal.procedure.scope, { workspaceId: WORKSPACE });
  assert.deepEqual(proposal.procedure.params, PARAMS);

  // The raw trace is not a field on the reused artifact, and no raw payload
  // value survives into it.
  assert.equal(proposal.events, undefined, 'the proposal must not expose the raw events');
  assert.deepEqual(Object.keys(proposal.procedure).sort(), [...PROCEDURE_KEYS].sort());
  assert.equal(JSON.stringify(proposal.procedure).includes(SENTINEL), false, 'raw trace leaked into the procedure');
  assert.equal(JSON.stringify(proposal.candidate).includes(SENTINEL), false, 'raw trace leaked into the candidate');
});

test('the production CLI surface renders the sealed reuse and never the raw trace', () => {
  const journal = createExperienceJournal();
  seedLifecycleRun(journal, 'run-cli');

  const text = runExperienceLearnCommand({
    experienceJournal: journal,
    args: { runId: 'run-cli', workspaceId: WORKSPACE, params: PARAMS },
  });

  assert.match(text, /procedure: replace_text v1 [0-9a-f]{64}/u);
  assert.match(text, /registered: false/u);
  assert.equal(text.includes(SENTINEL), false, 'the raw trace leaked onto the production surface');
});

test('a measurement gap is ineligible, not a task failure, and neither reaches a procedure', () => {
  const journal = createExperienceJournal();
  seedMeasurementGapRun(journal, 'run-gap');
  seedTaskFailureRun(journal, 'run-fail');

  const gap = journal.manifest('run-gap');
  const fail = journal.manifest('run-fail');
  assert.equal(gap.executionStatus, 'completed');
  assert.equal(gap.outcomeStatus, 'unknown');
  assert.equal(gap.learningEligibility, 'ineligible', 'a measurement gap is not a task failure');
  assert.notEqual(gap.learningEligibility, fail.learningEligibility);
  assert.equal(fail.learningEligibility, 'negative_example');

  const gapProposal = buildLearningProposal(journal, { runId: 'run-gap', workspaceId: WORKSPACE, params: PARAMS });
  assert.equal(gapProposal.admission.decision, 'rejected');
  assert.equal(gapProposal.candidate, null);
  assert.equal(gapProposal.procedure, null);

  const failProposal = buildLearningProposal(journal, { runId: 'run-fail', workspaceId: WORKSPACE, params: PARAMS });
  assert.equal(failProposal.candidate, null, 'a task failure is never proposed as a procedure');
  assert.equal(failProposal.procedure, null);
});
