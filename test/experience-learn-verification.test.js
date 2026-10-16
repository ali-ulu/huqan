'use strict';

/**
 * #3151: a `learn` step is verified by reading the written edges back from the
 * graph, and the verdict reaches the journal as a `verification` event.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const HuqanStorage = require('../storage');
const { createAgent } = require('../agentRuntime');
const { assessLearnReadBack, EXECUTOR, CHANNEL } = require('../lib/experience/learn-read-back');
const { assessOutcome, checkIndependence } = require('../lib/experience/verifier');
const { verificationEvent } = require('../lib/experience/step-lifecycle');

const WS = 'ws-verify';
const STATE = Object.freeze({ runId: 'run-1', workspaceId: WS });
const STEP = Object.freeze({ id: 's1', action: 'learn', tool: 'learn', input: 'kedi hayvandir', attempt: 1 });

function kernelIn(dir) {
  return new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'graph-memory.json') });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A real write: the admission bypass is the test fixture seed, so the edge
 * genuinely lands in the graph. */
function learnForReal(kernel, text = STEP.input) {
  return kernel.learn(text, { ...Kernel.createAdmissionBypassOpts('test_fixture_seed'), workspaceId: WS });
}

test('the verifier and the executor do not share a failure mode', () => {
  assert.deepEqual(checkIndependence({ executor: EXECUTOR, channel: CHANNEL }), { ok: true });
});

test('a result that names no edge is unknown, not failed', (t) => {
  const kernel = kernelIn(tempDir(t));
  const assessment = assessLearnReadBack({ graph: kernel.graph, step: STEP, state: STATE, result: { ok: true, data: { learned: 1 }, evidence: [] } });
  assert.equal(assessment.verdict, 'unknown');
  assert.equal(assessOutcome({ executionStatus: 'completed', assessments: [assessment] }).outcomeStatus, 'unknown');
});

test('nothing written, nothing to verify', (t) => {
  const kernel = kernelIn(tempDir(t));
  const reviewed = { ok: true, data: { learned: 0, admission: { graphWrite: false } }, evidence: [] };
  assert.equal(assessLearnReadBack({ graph: kernel.graph, step: STEP, state: STATE, result: reviewed }), null);
  assert.equal(assessLearnReadBack({ graph: kernel.graph, step: { ...STEP, tool: 'ask' }, state: STATE, result: learnForReal(kernel) }), null);
  assert.equal(assessLearnReadBack({ graph: null, step: STEP, state: STATE, result: learnForReal(kernel) }), null);
});

test('a write that reads back with its text and provenance is verified', (t) => {
  const kernel = kernelIn(tempDir(t));
  const result = learnForReal(kernel);
  const assessment = assessLearnReadBack({ graph: kernel.graph, step: STEP, state: STATE, result });
  assert.equal(assessment.verdict, 'verified');
  assert.deepEqual(assessment.proofs, { verification: true, coverage: true, integrity: true, provenance: true, permission: true, failureEvidence: false });
  const outcome = assessOutcome({ executionStatus: 'completed', assessments: [assessment] });
  assert.equal(outcome.outcomeStatus, 'verified');
  assert.equal(outcome.learningEligibility, 'positive_procedure');
});

test('a claimed edge that is not in the graph fails verification', (t) => {
  const kernel = kernelIn(tempDir(t));
  const result = learnForReal(kernel);
  const overclaim = { ...result, evidence: [...result.evidence, { edges: [{ from: 'kedi', to: 'bitki', relation: 'tür' }] }] };
  const assessment = assessLearnReadBack({ graph: kernel.graph, step: STEP, state: STATE, result: overclaim });
  assert.equal(assessment.verdict, 'failed');
  assert.equal(assessment.proofs.failureEvidence, true);
  assert.deepEqual(assessment.evidence.missing, ['kedi|tür|bitki']);
  assert.equal(assessOutcome({ executionStatus: 'completed', assessments: [assessment] }).outcomeStatus, 'failed');
});

test('an edge that is not this write is not verified', (t) => {
  const kernel = kernelIn(tempDir(t));
  const result = learnForReal(kernel);
  // Same endpoints, different step text: the edge exists but this step did not write it.
  const other = assessLearnReadBack({ graph: kernel.graph, step: { ...STEP, input: 'kediler hayvandir' }, state: STATE, result });
  assert.equal(other.proofs.integrity, false);
  assert.equal(assessOutcome({ executionStatus: 'completed', assessments: [other] }).outcomeStatus, 'unknown');
  // Provenance the write did not report is not this write's either.
  const foreign = { ...result, meta: { ...result.meta, provenance: { provenanceId: 'prov_someone_else' } } };
  const unproven = assessLearnReadBack({ graph: kernel.graph, step: STEP, state: STATE, result: foreign });
  assert.equal(unproven.proofs.provenance, false);
  assert.equal(assessOutcome({ executionStatus: 'completed', assessments: [unproven] }).outcomeStatus, 'unknown');
});

test('fewer claimed edges than learned facts is not full coverage', (t) => {
  const kernel = kernelIn(tempDir(t));
  const result = learnForReal(kernel);
  const undercount = { ...result, data: { ...result.data, learned: 3 } };
  const assessment = assessLearnReadBack({ graph: kernel.graph, step: STEP, state: STATE, result: undercount });
  assert.equal(assessment.proofs.coverage, false);
  assert.equal(assessOutcome({ executionStatus: 'completed', assessments: [assessment] }).outcomeStatus, 'unknown');
});

test('a write the admission did not permit is not verified', (t) => {
  const kernel = kernelIn(tempDir(t));
  const result = learnForReal(kernel);
  const unpermitted = { ...result, meta: { ...result.meta, durableMutation: false } };
  const assessment = assessLearnReadBack({ graph: kernel.graph, step: STEP, state: STATE, result: unpermitted });
  assert.equal(assessment.proofs.permission, false);
  assert.equal(assessOutcome({ executionStatus: 'completed', assessments: [assessment] }).outcomeStatus, 'unknown');
});

test('the verification event is caused by the memory update and carries the verdict', (t) => {
  const kernel = kernelIn(tempDir(t));
  const event = verificationEvent(STATE, STEP, learnForReal(kernel), kernel.graph);
  assert.equal(event.type, 'verification');
  assert.equal(event.eventId, 'run-1:step:s1:1:verified');
  assert.equal(event.causedByEventId, 'run-1:step:s1:1:memory');
  assert.equal(event.verdict, 'verified');
  assert.equal(event.payload.record.verifier.name, 'graph-read-back');
  assert.equal(verificationEvent(STATE, STEP, { ok: true, data: { learned: 0 } }, kernel.graph), null);
  // The read-back found the edge, but it is not this step's write: the event
  // records the verifier's degraded outcome, never the raw `verified`.
  const degraded = verificationEvent(STATE, { ...STEP, input: 'kediler hayvandir' }, learnForReal(kernel), kernel.graph);
  assert.equal(degraded.payload.record.verdict, 'verified');
  assert.equal(degraded.verdict, 'unknown');
});

// ---------------------------------------------------------------------------
// Production path: createAgent, a real graph write, the real journal.
// ---------------------------------------------------------------------------

function runLearn(t, wrapLearn) {
  try { require('better-sqlite3'); } catch (_) { t.skip('better-sqlite3 unavailable'); return null; }
  // One after-hook, close then remove: hooks run in registration order and
  // Windows cannot unlink an open database.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-verify-'));
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'verify.db') });
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const kernel = kernelIn(dir);
  const agent = createAgent({ kernel, storage, maxSteps: 1, maxIterations: 1, timeBudgetMs: 5000, dreamExperimentLoop: false });
  agent.baseAgent.plan = (goal) => ({ ok: true, type: 'plan', data: { goal, objective: 'learn', selectedTools: ['learn'], steps: [{ id: 's1', action: 'learn', tool: 'learn', input: STEP.input }], maxSteps: 1 } });
  const original = kernel.learn.bind(kernel);
  kernel.learn = (text, opts = {}) => wrapLearn(original(text, { ...opts, ...Kernel.createAdmissionBypassOpts('test_fixture_seed') }));
  const result = agent.run('learn that a cat is an animal', { workspaceId: WS });
  const journal = kernel.experienceJournal;
  return { result, events: journal.read(result.data.observabilityRunId, { workspaceId: WS }), manifest: journal.manifest(result.data.observabilityRunId) };
}

test('a real learn is verified from the graph and the run becomes learnable (SQLite)', (t) => {
  const run = runLearn(t, (value) => value);
  if (!run) return;
  assert.equal(run.result.ok, true, JSON.stringify(run.result.error));
  const types = run.events.map((e) => e.type);
  assert.deepEqual(types, ['run_started', 'action_proposed', 'policy_decided', 'execution_started', 'memory_update', 'verification', 'execution_finished', 'run_closed']);
  const verification = run.events.find((e) => e.type === 'verification');
  assert.equal(verification.verdict, 'verified');
  assert.equal(run.manifest.outcomeStatus, 'verified');
  assert.equal(run.manifest.learningEligibility, 'positive_procedure');
});

test('a learn that over-claims its write is reported failed, not learnable (SQLite)', (t) => {
  const run = runLearn(t, (value) => ({ ...value, evidence: [...value.evidence, { edges: [{ from: 'kedi', to: 'bitki', relation: 'tür' }] }] }));
  if (!run) return;
  const verification = run.events.find((e) => e.type === 'verification');
  assert.equal(verification.verdict, 'failed');
  assert.deepEqual(verification.payload.record.evidence.missing, ['kedi|tür|bitki']);
  assert.equal(run.manifest.outcomeStatus, 'failed');
  assert.notEqual(run.manifest.learningEligibility, 'positive_procedure');
});
