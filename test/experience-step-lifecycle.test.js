'use strict';

/**
 * Experience lifecycle events inside one step (#3033): `policy_decided`,
 * `execution_started` and `memory_update`, each written only where its owning
 * boundary has real evidence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KernelV2 = require('../kernel.v2');
const HuqanStorage = require('../storage');
const { createAgent } = require('../agentRuntime');
const { createOperationLedger } = require('../lib/experience/reconciliation');
const { runStepEffect } = require('../lib/experience/effect-boundary');
const {
  createStepLifecycleRecorder, policyDecidedEvent, executionStartedEvent, memoryUpdateEvent,
} = require('../lib/experience/step-lifecycle');

const STATE = Object.freeze({ runId: 'run-1', workspaceId: 'ws' });
const LEARN = Object.freeze({ id: 's1', action: 'learn', tool: 'learn', input: 'water is wet', attempt: 1 });
const WROTE = Object.freeze({ ok: true, type: 'learn', data: { learned: 2, admission: { outcome: 'admitted', graphWrite: true, receiptId: 'rcpt-1' } }, evidence: [] });
const REVIEWED = Object.freeze({ ok: true, type: 'learn', data: { learned: 0, skipped: 1, admission: { outcome: 'review', graphWrite: false, receiptId: 'rcpt-2' } }, evidence: [] });

function recordingJournal() {
  const events = [];
  return { events, append: (event) => { events.push(event); return { ok: true }; } };
}

test('no run identity or no step id records nothing', () => {
  assert.equal(policyDecidedEvent({}, LEARN, { decision: 'allow' }), null);
  assert.equal(executionStartedEvent(STATE, { tool: 'learn' }), null);
  assert.equal(memoryUpdateEvent({}, LEARN, WROTE), null);
});

test('policy_decided carries both gates and the blocking gate, caused by the proposal', () => {
  const event = policyDecidedEvent(STATE, LEARN, { decision: 'block', gate: 'tool_policy', actionFirewall: 'allow', toolPolicy: 'block' });
  assert.equal(event.type, 'policy_decided');
  assert.equal(event.eventId, 'run-1:step:s1:1:decided');
  assert.equal(event.causedByEventId, 'run-1:step:s1:1:proposed');
  assert.equal(event.attemptId, 'run-1:step:s1:attempt:1');
  assert.deepEqual(event.payload, { stepId: 's1', tool: 'learn', decision: 'block', gate: 'tool_policy', actionFirewall: 'allow', toolPolicy: 'block' });
});

test('memory_update only for a learn that wrote facts', () => {
  const event = memoryUpdateEvent(STATE, LEARN, WROTE);
  assert.equal(event.type, 'memory_update');
  assert.equal(event.causedByEventId, 'run-1:step:s1:1:started');
  assert.deepEqual(event.payload, { stepId: 's1', tool: 'learn', learned: 2, admission: 'admitted', receiptId: 'rcpt-1' });
  assert.equal(memoryUpdateEvent(STATE, LEARN, REVIEWED), null, 'a learn sent to review wrote nothing');
  assert.equal(memoryUpdateEvent(STATE, LEARN, { ok: true, data: { learned: 3, admission: { graphWrite: false } } }), null);
  assert.equal(memoryUpdateEvent(STATE, LEARN, { ok: false, data: { learned: 1 } }), null);
  assert.equal(memoryUpdateEvent(STATE, LEARN, { ok: true, data: { learned: 0 } }), null, 'nothing learned is no update');
  assert.equal(memoryUpdateEvent(STATE, { ...LEARN, tool: 'ask' }, WROTE), null, 'only learn writes memory');
});

test('execution_started is written just before the call, memory_update after it', () => {
  const journal = recordingJournal();
  const recorder = createStepLifecycleRecorder(() => journal);
  const order = [];
  const perform = recorder.wrapPerform(LEARN, STATE, () => { order.push(`call after ${journal.events.map((e) => e.type).join(',')}`); return WROTE; });
  assert.equal(journal.events.length, 0, 'wrapping writes nothing until the call');
  assert.equal(perform(), WROTE);
  assert.deepEqual(order, ['call after execution_started']);
  assert.deepEqual(journal.events.map((e) => e.type), ['execution_started', 'memory_update']);
});

test('a refused or replayed effect never starts', () => {
  const journal = recordingJournal();
  const recorder = createStepLifecycleRecorder(() => journal);
  const ledger = createOperationLedger();
  // The crash left this attempt pending.
  ledger.begin({
    operationId: 'run-1:step:s1:attempt:1:effect',
    runId: 'run-1',
    workspaceId: 'ws',
    intent: { tool: 'learn', stepId: 's1', attempt: 1, inputSha256: require('node:crypto').createHash('sha256').update('water is wet').digest('hex') },
  });
  let calls = 0;
  const result = runStepEffect({ ledger, state: STATE, step: LEARN, perform: recorder.wrapPerform(LEARN, STATE, () => { calls += 1; return WROTE; }) });
  assert.equal(result.error.code, 'EXPERIENCE_EFFECT_UNCERTAIN');
  assert.equal(calls, 0);
  assert.deepEqual(journal.events, [], 'no execution_started for a step that did not run');
});

test('a journal failure never reaches the step', () => {
  const recorder = createStepLifecycleRecorder(() => ({ append() { throw new Error('disk gone'); } }));
  assert.equal(recorder.recordDecision(LEARN, STATE, { decision: 'allow' }), null);
  assert.equal(recorder.wrapPerform(LEARN, STATE, () => WROTE)(), WROTE);
});

// ---------------------------------------------------------------------------
// Production path through createAgent and the real journal.
// ---------------------------------------------------------------------------

function withAgent(t, steps, learnResult) {
  try { require('better-sqlite3'); } catch (_) { t.skip('better-sqlite3 unavailable'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-life-'));
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'life.db') });
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'graph-memory.json') });
  const agent = createAgent({ kernel, storage, maxSteps: steps.length, maxIterations: steps.length, timeBudgetMs: 5000, dreamExperimentLoop: false });
  agent.baseAgent.plan = (goal) => ({ ok: true, type: 'plan', data: { goal, objective: 'lifecycle', selectedTools: steps.map((s) => s.tool), steps, maxSteps: steps.length } });
  kernel.learn = () => learnResult;
  return { agent, kernel };
}

function journalOf(env, result) {
  return env.kernel.experienceJournal.read(result.data.observabilityRunId, { workspaceId: result.data.workspaceId });
}

test('a learn that writes: proposed, decided, started, memory, finished (SQLite)', (t) => {
  const env = withAgent(t, [{ id: 's1', action: 'learn', tool: 'learn', input: 'water is wet' }], WROTE);
  if (!env) return;
  const result = env.agent.run('learn one fact');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const events = journalOf(env, result);
  // #3151: the write is then read back; this stub result names no edge, so
  // the verification is present but can only say `unknown`.
  assert.deepEqual(events.map((e) => e.type), ['run_started', 'action_proposed', 'policy_decided', 'execution_started', 'memory_update', 'verification', 'execution_finished', 'run_closed']);
  assert.equal(events[5].verdict, 'unknown');
  const [, proposed, decided, started, memory] = events;
  assert.equal(decided.causedByEventId, proposed.eventId);
  assert.equal(decided.payload.decision, 'allow');
  assert.equal(decided.payload.gate, null);
  assert.equal(started.causedByEventId, decided.eventId);
  assert.equal(memory.causedByEventId, started.eventId);
  assert.equal(memory.payload.learned, 2);
  events.forEach((e, i) => assert.equal(e.sequence, i + 1));
});

test('a learn sent to review records no memory update (SQLite)', (t) => {
  const env = withAgent(t, [{ id: 's1', action: 'learn', tool: 'learn', input: 'water is wet' }], REVIEWED);
  if (!env) return;
  const types = journalOf(env, env.agent.run('learn one fact')).map((e) => e.type);
  assert.ok(types.includes('execution_started'));
  assert.ok(!types.includes('memory_update'), types.join(','));
});

test('a blocked step is decided as a block and never starts (SQLite)', (t) => {
  const env = withAgent(t, [{ id: 's1', action: 'shell', tool: 'shell', input: 'rm -rf /' }], WROTE);
  if (!env) return;
  const result = env.agent.run('run a shell command');
  const events = journalOf(env, result);
  const types = events.map((e) => e.type);
  assert.ok(!types.includes('execution_started'), types.join(','));
  const decided = events.find((e) => e.type === 'policy_decided');
  assert.ok(decided, types.join(','));
  assert.equal(decided.payload.decision, 'block');
  assert.ok(['action_firewall', 'tool_policy', 'behavioral_integrity', 'before_task_plugin'].includes(decided.payload.gate), decided.payload.gate);
  const failure = events.find((e) => e.type === 'failure');
  assert.ok(failure);
  assert.ok(decided.sequence < failure.sequence, 'the decision precedes the failure it caused');
});
