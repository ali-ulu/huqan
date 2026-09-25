'use strict';

/**
 * Experience Core E3 runtime seam (#2378).
 *
 * The acceptance criterion is behavioural, not structural: a real run through
 * the production factory produces a complete, ordered, closed Experience whose
 * manifest a person can read, and a run killed mid-flight is recorded as
 * incomplete rather than as one that looks finished. These tests drive
 * `createAgent` and read the result back through the same journal the
 * CLI/HTTP/MCP surfaces use.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KernelV2 = require('../kernel.v2');
const HuqanStorage = require('../storage');
const { createAgent, resolveExperienceJournal } = require('../agentRuntime');
const { createExperienceJournal } = require('../lib/experience/journal');
const { emitRunLifecycle } = require('../lib/experience/runtime-seam');
const { buildExperienceRead } = require('../lib/experience/read-model');

function makeKernel(dir) {
  return new KernelV2({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(dir, 'graph-memory.json'),
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-seam-'));
}

function cleanup(dir, storage) {
  try { if (storage && storage.db) storage.db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('resolveExperienceJournal returns null without a durable store', () => {
  // Fail-closed: an ephemeral journal a restart erases is not a durable
  // history, so the factory refuses to pretend it has one.
  assert.equal(resolveExperienceJournal({}, null), null);
  assert.equal(resolveExperienceJournal({}, { db: null }), null);
});

test('resolveExperienceJournal honours an injected journal', () => {
  const injected = createExperienceJournal();
  const kernel = {};
  assert.equal(resolveExperienceJournal({ experienceJournal: injected, kernel }, null), injected);
  // The injected journal is still attached to the kernel, because the run
  // lifecycle hub reads it from there.
  assert.equal(kernel.experienceJournal, injected);
});

test('the seam is a no-op when no journal is configured', () => {
  const { emitRunLifecycle } = require('../lib/experience/runtime-seam');
  // A run with no journal is the pre-wiring state every existing caller is in,
  // and it must stay silent rather than throw into the run loop.
  assert.equal(emitRunLifecycle('beforeAgentRun', { runId: 'r', goal: 'g' }, null), null);
  assert.equal(emitRunLifecycle('beforeAgentRun', { runId: 'r', goal: 'g' }, {}), null);
  // A signal with no run identity records nothing rather than inventing one.
  assert.equal(emitRunLifecycle('beforeAgentRun', { goal: 'g' }, createExperienceJournal()), null);
});

test('a real run produces a complete, ordered, closed Experience (SQLite)', () => {
  const dir = tempDir();
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'seam.db') });
  try {
    const kernel = makeKernel(dir);
    const agent = createAgent({
      kernel,
      storage,
      maxSteps: 1,
      maxIterations: 1,
      timeBudgetMs: 5000,
      dreamExperimentLoop: false,
    });
    // The factory attached a production journal to the kernel.
    assert.ok(kernel.experienceJournal, 'the kernel must hold the production journal');
    const journal = kernel.experienceJournal;

    // A deterministic single-step plan keeps the run offline and bounded.
    agent.baseAgent.plan = (goal) => ({
      ok: true,
      type: 'plan',
      data: {
        goal,
        objective: 'record an experience',
        selectedTools: ['ask'],
        steps: [{ id: 's1', action: 'ask', tool: 'ask', input: 'what is water' }],
        maxSteps: 1,
      },
    });
    kernel.ask = () => ({ ok: true, type: 'ask', data: { summary: 'water is wet' }, evidence: [] });

    const result = agent.run('record one experience end to end');
    const runId = result?.data?.observabilityRunId;
    assert.ok(runId, 'the run must carry an identity');

    const closed = journal.read(runId, { workspaceId: result.data.workspaceId });
    const types = closed.map((e) => e.type);
    assert.equal(types[0], 'run_started', 'the first event must open the run');
    assert.equal(types[types.length - 1], 'run_closed', 'the last event must close the run');
    assert.equal(types.filter((x) => x === 'run_started').length, 1);

    // Ordered and gapless: sequence is the reader's ordering authority.
    closed.forEach((e, i) => assert.equal(e.sequence, i + 1));

    const manifest = journal.manifest(runId);
    assert.equal(manifest.closed, true);
    assert.equal(manifest.eventCount, closed.length);

    // The shared projection a person reads is available and non-empty.
    const projection = buildExperienceRead(journal, { runId, workspaceId: result.data.workspaceId });
    assert.equal(projection.ok, true, JSON.stringify(projection));
    assert.ok(projection.events.length >= 2);
  } finally {
    cleanup(dir, storage);
  }
});

test('an unfinished run stays open rather than looking finished (SQLite)', () => {
  const dir = tempDir();
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'seam.db') });
  try {
    const kernel = makeKernel(dir);
    const agent = createAgent({ kernel, storage, maxSteps: 1 });
    const journal = kernel.experienceJournal;
    // Simulate a process killed mid-run: the open event is durable, the close
    // event never arrives. The manifest must not claim the run finished.
    agent.baseAgent._emit('beforeAgentRun', { goal: 'killed mid-run', workspaceId: 'default', runId: 'run-killed' });
    const manifest = journal.manifest('run-killed');
    assert.equal(manifest.closed, false);
    assert.equal(manifest.eventCount, 1);
    assert.equal(manifest.learningEligibility, 'ineligible');
  } finally {
    cleanup(dir, storage);
  }
});

test('each step is proposed, then closed by what actually happened (SQLite)', () => {
  const dir = tempDir();
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'seam.db') });
  try {
    const journal = createExperienceJournal({ store: storage });
    const state = { runId: 'run-steps', workspaceId: 'ws-1' };
    journal.append({ runId: 'run-steps', eventId: 'run-steps:run_started', type: 'run_started', workspaceId: 'ws-1' });

    // A step that ran.
    emitRunLifecycle('beforeTask', { step: { id: 's1', action: 'ask', tool: 'ask', attempt: 1 }, state }, journal);
    emitRunLifecycle('afterTask', { step: { id: 's1', tool: 'ask', attempt: 1, status: 'done', summary: 'water is wet' }, state }, journal);

    // A step the firewall refused: proposed, then a failure -- never a
    // finished execution, because it never executed.
    emitRunLifecycle('beforeTask', { step: { id: 's2', action: 'reason', tool: 'external-http', attempt: 1 }, state }, journal);
    emitRunLifecycle('afterTask', {
      step: { id: 's2', tool: 'external-http', attempt: 1, status: 'blocked', result: { error: { code: 'EXTERNAL_TOOL_BLOCKED', message: 'External tool blocked required.' } } },
      state,
    }, journal);

    const events = journal.read('run-steps', { workspaceId: 'ws-1' });
    assert.deepEqual(events.map((e) => e.type), [
      'run_started',
      'action_proposed',
      'execution_finished',
      'action_proposed',
      'failure',
    ]);

    const [proposal1, finished1, proposal2, failure] = events.slice(1);
    // Causality: each terminal event names the proposal that caused it.
    assert.equal(finished1.causedByEventId, proposal1.eventId);
    assert.equal(failure.causedByEventId, proposal2.eventId);
    assert.equal(finished1.executionStatus, 'completed');
    // A refusal is a failure, so it must not claim an execution status.
    assert.equal(failure.executionStatus, undefined);

    // Invocation correlation: a step's proposal and its terminal event are the
    // same attempt, so they share both ids; retries differ by attemptId (the
    // retry test below pins that).
    assert.equal(proposal1.invocationId, finished1.invocationId);
    assert.equal(proposal1.attemptId, finished1.attemptId);
    assert.deepEqual(journal.runsForAttempt(proposal1.attemptId), ['run-steps']);
    assert.deepEqual(journal.runsForAttempt(failure.attemptId), ['run-steps']);

    // The failure carries bounded evidence, so the event stays under the
    // per-event byte ceiling the write-cost budget sets.
    assert.equal(failure.payload.code, 'EXTERNAL_TOOL_BLOCKED');
    assert.ok(Buffer.byteLength(JSON.stringify(failure)) <= 4096);
  } finally {
    cleanup(dir, storage);
  }
});

test('a retried step records one attempt per try, not one colliding event', () => {
  const journal = createExperienceJournal();
  const state = { runId: 'run-retry', workspaceId: 'default' };
  journal.append({ runId: 'run-retry', eventId: 'run-retry:run_started', type: 'run_started', workspaceId: 'default' });
  // executeStepWithRetry re-enters the same step id with attempt 1 then 2, and
  // the attempt rides beside the report (the production emit shape), not
  // inside it.
  emitRunLifecycle('beforeTask', { step: { id: 's1', action: 'ask', tool: 'ask', attempt: 1 }, state }, journal);
  emitRunLifecycle('afterTask', { step: { id: 's1', tool: 'ask', status: 'error', result: { error: { code: 'TIMEOUT', message: 'aborted' } } }, state, attempt: 1 }, journal);
  emitRunLifecycle('beforeTask', { step: { id: 's1', action: 'ask', tool: 'ask', attempt: 2 }, state }, journal);
  emitRunLifecycle('afterTask', { step: { id: 's1', tool: 'ask', status: 'done', summary: 'ok' }, state, attempt: 2 }, journal);

  const events = journal.read('run-retry');
  assert.deepEqual(events.map((e) => e.type), [
    'run_started',
    'action_proposed',
    'execution_finished',
    'action_proposed',
    'execution_finished',
  ]);
  // Same invocation, distinct attempts: the retry is visible rather than
  // silently collapsing into the first try.
  assert.equal(events[1].invocationId, events[3].invocationId);
  assert.notEqual(events[1].attemptId, events[3].attemptId);
  assert.equal(events[2].executionStatus, 'failed');
  assert.equal(events[4].executionStatus, 'completed');
  // The journal's sequence is the reader's ordering authority, and it is
  // gapless across both attempts.
  events.forEach((e, i) => assert.equal(e.sequence, i + 1));
});

test('a step with no id records nothing rather than inventing an identity', () => {
  const journal = createExperienceJournal();
  const state = { runId: 'run-noid', workspaceId: 'default' };
  journal.append({ runId: 'run-noid', eventId: 'run-noid:run_started', type: 'run_started', workspaceId: 'default' });
  assert.equal(emitRunLifecycle('beforeTask', { step: { action: 'ask', tool: 'ask' }, state }, journal), null);
  assert.equal(emitRunLifecycle('afterTask', { step: { tool: 'ask', status: 'done' }, state }, journal), null);
  assert.equal(journal.read('run-noid').length, 1);
});

test('a step signal with no run identity records nothing', () => {
  const journal = createExperienceJournal();
  assert.equal(emitRunLifecycle('beforeTask', { step: { id: 's1', action: 'ask' } }, journal), null);
  assert.equal(emitRunLifecycle('afterTask', { step: { id: 's1', status: 'done' } }, journal), null);
});

test('the step seam is a no-op without a journal', () => {
  assert.equal(emitRunLifecycle('beforeTask', { step: { id: 's1' }, state: { runId: 'r' } }, null), null);
  assert.equal(emitRunLifecycle('afterTask', { step: { id: 's1', status: 'done' }, state: { runId: 'r' } }, undefined), null);
});

test('a blocked step is never recorded as a finished execution', () => {
  // The rule this slice exists for: a refusal did not execute, so recording it
  // as `execution_finished` would be the "unmeasured effect is not no effect"
  // error. Mutating the seam to route `blocked` through the finished branch
  // must fail this test.
  const journal = createExperienceJournal();
  const state = { runId: 'run-blocked', workspaceId: 'default' };
  journal.append({ runId: 'run-blocked', eventId: 'run-blocked:run_started', type: 'run_started', workspaceId: 'default' });
  emitRunLifecycle('beforeTask', { step: { id: 's1', action: 'reason', tool: 'external-http', attempt: 1 }, state }, journal);
  emitRunLifecycle('afterTask', {
    step: { id: 's1', tool: 'external-http', attempt: 1, status: 'blocked', result: { error: { code: 'EXTERNAL_TOOL_BLOCKED', message: 'blocked' } } },
    state,
  }, journal);
  const types = journal.read('run-blocked').map((e) => e.type);
  assert.deepEqual(types, ['run_started', 'action_proposed', 'failure']);
  assert.equal(types.includes('execution_finished'), false);
});

test('long free text is cut, not stored whole, on both step outcomes', () => {
  const journal = createExperienceJournal();
  const state = { runId: 'run-long', workspaceId: 'default' };
  journal.append({ runId: 'run-long', eventId: 'run-long:run_started', type: 'run_started', workspaceId: 'default' });
  const long = 'x'.repeat(20000);

  // A refused step: the failure message is the free text.
  emitRunLifecycle('beforeTask', { step: { id: 's1', action: 'reason', tool: 'external-http', attempt: 1 }, state }, journal);
  emitRunLifecycle('afterTask', {
    step: { id: 's1', tool: 'external-http', attempt: 1, status: 'blocked', result: { error: { code: 'BLOCKED', message: long } } },
    state,
  }, journal);

  // A step that ran and failed: the finished event carries the summary.
  emitRunLifecycle('beforeTask', { step: { id: 's2', action: 'ask', tool: 'ask', attempt: 1 }, state }, journal);
  emitRunLifecycle('afterTask', {
    step: { id: 's2', tool: 'ask', attempt: 1, status: 'error', summary: long, result: { error: { code: 'BOOM', message: long } } },
    state,
  }, journal);

  const events = journal.read('run-long');
  const failure = events.find((e) => e.type === 'failure');
  const finished = events.find((e) => e.type === 'execution_finished');
  assert.equal(failure.payload.code, 'BLOCKED');
  assert.ok(failure.payload.message.length < long.length);
  assert.ok(finished.payload.summary.length < long.length);
  // Both stay under the per-event byte ceiling the write-cost budget sets.
  for (const event of [failure, finished]) {
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 4096, `${event.type} exceeds the byte ceiling`);
  }
});

test('a journal that throws does not derail the run loop', () => {
  // The seam itself propagates a store throw; the guard is the try/catch in
  // `Agent._emit`, which is what keeps a failing journal from breaking a run.
  // This drives that guard through a real run rather than asserting it exists.
  const dir = tempDir();
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'seam.db') });
  try {
    const kernel = makeKernel(dir);
    const exploding = { append: () => { throw new Error('store exploded'); } };
    const agent = createAgent({
      kernel,
      storage,
      experienceJournal: exploding,
      maxSteps: 1,
      maxIterations: 1,
      timeBudgetMs: 5000,
      dreamExperimentLoop: false,
    });
    agent.baseAgent.plan = (goal) => ({
      ok: true,
      type: 'plan',
      data: {
        goal,
        objective: 'survive a broken journal',
        selectedTools: ['ask'],
        steps: [{ id: 's1', action: 'ask', tool: 'ask', input: 'what is water' }],
        maxSteps: 1,
      },
    });
    kernel.ask = () => ({ ok: true, type: 'ask', data: { summary: 'water is wet' }, evidence: [] });

    const result = agent.run('a broken journal must not break the run');
    assert.equal(result.ok, true);
    assert.ok(result.data.observabilityRunId);
  } finally {
    cleanup(dir, storage);
  }
});

test('a real retried step keeps both attempts distinct in the journal (SQLite)', () => {
  // The unit test above pins the seam; this drives the production retry loop
  // so the `attempt` plumbing is proven end to end. The first try fails with a
  // retryable error, the retry succeeds, and the journal must show two
  // attempts rather than one collapsed event.
  const dir = tempDir();
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'seam.db') });
  try {
    const kernel = makeKernel(dir);
    const agent = createAgent({ kernel, storage, maxSteps: 1, maxIterations: 1, timeBudgetMs: 5000, dreamExperimentLoop: false });
    const journal = kernel.experienceJournal;
    agent.baseAgent.plan = (goal) => ({
      ok: true,
      type: 'plan',
      data: {
        goal,
        objective: 'retry one step',
        selectedTools: ['ask'],
        steps: [{ id: 's1', action: 'ask', tool: 'ask', input: 'what is water' }],
        maxSteps: 1,
      },
    });
    let calls = 0;
    kernel.ask = () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, type: 'ask', data: null, evidence: [], error: { code: 'ETIMEDOUT', message: 'fetch timeout' } };
      }
      return { ok: true, type: 'ask', data: { summary: 'water is wet' }, evidence: [] };
    };

    const result = agent.run('retry the flaky step');
    const runId = result?.data?.observabilityRunId;
    assert.equal(calls, 2, 'the retry must actually have run twice');

    const events = journal.read(runId, { workspaceId: result.data.workspaceId });
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'run_started',
      'action_proposed',
      'execution_finished',
      'action_proposed',
      'execution_finished',
      'run_closed',
    ]);
    // Same invocation, two attempts: the first failed, the second completed.
    const [p1, f1, p2, f2] = events.slice(1, 5);
    assert.equal(p1.invocationId, p2.invocationId);
    assert.notEqual(p1.attemptId, p2.attemptId);
    assert.equal(f1.executionStatus, 'failed');
    assert.equal(f2.executionStatus, 'completed');
    assert.equal(f1.causedByEventId, p1.eventId);
    assert.equal(f2.causedByEventId, p2.eventId);
    assert.deepEqual(journal.runsForAttempt(p1.attemptId), [runId]);
    assert.deepEqual(journal.runsForAttempt(p2.attemptId), [runId]);
  } finally {
    cleanup(dir, storage);
  }
});

test('a real run records every step and still closes complete and ordered (SQLite)', () => {
  const dir = tempDir();
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'seam.db') });
  try {
    const kernel = makeKernel(dir);
    const agent = createAgent({ kernel, storage, maxSteps: 2, maxIterations: 2, timeBudgetMs: 5000, dreamExperimentLoop: false });
    const journal = kernel.experienceJournal;
    agent.baseAgent.plan = (goal) => ({
      ok: true,
      type: 'plan',
      data: {
        goal,
        objective: 'record two steps',
        selectedTools: ['ask'],
        steps: [
          { id: 's1', action: 'ask', tool: 'ask', input: 'what is water' },
          { id: 's2', action: 'ask', tool: 'ask', input: 'what is ice' },
        ],
        maxSteps: 2,
      },
    });
    kernel.ask = () => ({ ok: true, type: 'ask', data: { summary: 'a short answer' }, evidence: [] });

    const result = agent.run('record two steps end to end');
    const runId = result?.data?.observabilityRunId;
    assert.ok(runId);

    const events = journal.read(runId, { workspaceId: result.data.workspaceId });
    const types = events.map((e) => e.type);
    assert.equal(types[0], 'run_started');
    assert.equal(types[types.length - 1], 'run_closed');
    // Both steps contributed a proposal and a terminal event, in order.
    assert.equal(types.filter((t) => t === 'action_proposed').length, 2);
    assert.equal(types.filter((t) => t === 'execution_finished').length, 2);
    assert.equal(types.filter((t) => t === 'failure').length, 0);
    events.forEach((e, i) => assert.equal(e.sequence, i + 1));

    // Every terminal step event resolves its cause to a proposal in this run.
    const seenIds = new Set(events.map((e) => e.eventId));
    for (const e of events.filter((x) => x.causedByEventId)) {
      assert.ok(seenIds.has(e.causedByEventId), `${e.eventId} points at a missing cause`);
    }

    const manifest = journal.manifest(runId);
    assert.equal(manifest.closed, true);
    assert.equal(manifest.executionStatus, 'completed');
    // The run executed and closed, but nothing verified it: outcomeStatus is
    // still unknown, so it is not learning-eligible. Success is not
    // verification -- the axis separation the epic is built on.
    assert.equal(manifest.outcomeStatus, 'unknown');
    assert.equal(manifest.learningEligibility, 'ineligible');

    const projection = buildExperienceRead(journal, { runId, workspaceId: result.data.workspaceId });
    assert.equal(projection.ok, true, JSON.stringify(projection));
  } finally {
    cleanup(dir, storage);
  }
});
