'use strict';

/**
 * Experience E5 at the runtime effect boundary (#3033).
 *
 * Unit cases drive `runStepEffect` against the operation ledger directly;
 * the production cases go through `createAgent`, and the crash case kills a
 * real child process after the effect and before the checkpoint, then resumes
 * the run in this process.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const KernelV2 = require('../kernel.v2');
const HuqanStorage = require('../storage');
const { createAgent } = require('../agentRuntime');
const { createOperationLedger, TABLE } = require('../lib/experience/reconciliation');
const { runStepEffect, CODES } = require('../lib/experience/effect-boundary');

const LEARN_STEP = Object.freeze({ id: 's1', action: 'learn', tool: 'learn', input: 'water is wet', attempt: 1 });
const RUN_STATE = Object.freeze({ runId: 'run-1', workspaceId: 'ws' });

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-effect-'));
}

function sqliteStore(dbPath) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (_) {
    return null;
  }
  const db = new Database(dbPath);
  return { db, withTransaction: (fn) => db.transaction(fn)() };
}

function counted(result) {
  const calls = { n: 0 };
  return { calls, perform: () => { calls.n += 1; return typeof result === 'function' ? result() : result; } };
}

const OK = Object.freeze({ ok: true, type: 'learn', data: { learned: 1 }, evidence: [], error: null, meta: {} });

test('a read-only tool runs without touching the ledger', () => {
  const ledger = createOperationLedger();
  const { calls, perform } = counted(OK);
  const result = runStepEffect({ ledger, state: RUN_STATE, step: { ...LEARN_STEP, tool: 'ask' }, perform });
  assert.equal(result, OK);
  assert.equal(calls.n, 1);
  assert.deepEqual(ledger.reconcile(), []);
  assert.equal(ledger.claim('run-1:step:s1:attempt:1:effect').ok, false);
});

test('without a ledger or a run identity the effect runs as before', () => {
  for (const args of [{ ledger: null, state: RUN_STATE }, { ledger: createOperationLedger(), state: {} }]) {
    const { calls, perform } = counted(OK);
    assert.equal(runStepEffect({ ...args, step: LEARN_STEP, perform }), OK);
    assert.equal(calls.n, 1);
  }
});

test('a learn step records intent, runs once and records a completed outcome', () => {
  const ledger = createOperationLedger();
  const { calls, perform } = counted(OK);
  const result = runStepEffect({ ledger, state: RUN_STATE, step: LEARN_STEP, perform });
  assert.equal(result, OK);
  assert.equal(calls.n, 1);
  const claimed = ledger.claim('run-1:step:s1:attempt:1:effect');
  assert.deepEqual(claimed, { ok: true, state: 'completed', outcome: { ok: true, code: null } });
});

test('a step in flight at the crash is refused as uncertain and not run again', () => {
  const ledger = createOperationLedger();
  // The first process recorded the intent and died before the outcome.
  const begun = ledger.begin({
    operationId: 'run-1:step:s1:attempt:1:effect',
    runId: 'run-1',
    workspaceId: 'ws',
    intent: { tool: 'learn', stepId: 's1', attempt: 1, inputSha256: require('node:crypto').createHash('sha256').update('water is wet').digest('hex') },
  });
  assert.equal(begun.ok, true);
  const { calls, perform } = counted(OK);
  const result = runStepEffect({ ledger, state: RUN_STATE, step: LEARN_STEP, perform });
  assert.equal(calls.n, 0, 'an uncertain effect must not be retried');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, CODES.UNCERTAIN);
  assert.equal(result.meta.blocked, true);
  assert.equal(result.meta.experienceOperation.retry, false);
  assert.equal(ledger.claim('run-1:step:s1:attempt:1:effect').state, 'pending', 'refusing must not complete the operation');
});

test('a finished step replays its recorded outcome instead of running again', () => {
  const ledger = createOperationLedger();
  runStepEffect({ ledger, state: RUN_STATE, step: LEARN_STEP, perform: () => OK });
  const failedStep = { ...LEARN_STEP, id: 's2' };
  runStepEffect({ ledger, state: RUN_STATE, step: failedStep, perform: () => ({ ok: false, error: { code: 'LEARN_REJECTED', message: 'no' } }) });

  const { calls, perform } = counted(OK);
  const replayed = runStepEffect({ ledger, state: RUN_STATE, step: LEARN_STEP, perform });
  assert.equal(calls.n, 0);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.meta.experienceOperation.replayed, true);
  assert.equal(replayed.meta.blocked, undefined, 'a replayed success is not a block');

  const replayedFailure = runStepEffect({ ledger, state: RUN_STATE, step: failedStep, perform });
  assert.equal(calls.n, 0);
  assert.equal(replayedFailure.ok, false);
  assert.equal(replayedFailure.error.code, 'LEARN_REJECTED');
  assert.equal(replayedFailure.meta.blocked, undefined, 'a known failure stays retryable as a new attempt');
});

test('a retry after a known failure is a new attempt and runs', () => {
  const ledger = createOperationLedger();
  runStepEffect({ ledger, state: RUN_STATE, step: LEARN_STEP, perform: () => ({ ok: false, error: { code: 'TRANSIENT' } }) });
  const { calls, perform } = counted(OK);
  const result = runStepEffect({ ledger, state: RUN_STATE, step: { ...LEARN_STEP, attempt: 2 }, perform });
  assert.equal(calls.n, 1);
  assert.equal(result, OK);
});

test('an intent that cannot be recorded stops the effect', () => {
  const ledger = createOperationLedger({ store: { withTransaction() { throw new Error('disk gone'); } } });
  const { calls, perform } = counted(OK);
  const result = runStepEffect({ ledger, state: RUN_STATE, step: LEARN_STEP, perform });
  assert.equal(calls.n, 0);
  assert.equal(result.error.code, CODES.INTENT_UNRECORDED);
  assert.equal(result.meta.blocked, true);
});

test('the same attempt with a different input is a conflict, not a replay', () => {
  const ledger = createOperationLedger();
  runStepEffect({ ledger, state: RUN_STATE, step: LEARN_STEP, perform: () => OK });
  const { calls, perform } = counted(OK);
  const result = runStepEffect({ ledger, state: RUN_STATE, step: { ...LEARN_STEP, input: 'fire is cold' }, perform });
  assert.equal(calls.n, 0);
  assert.equal(result.error.code, CODES.OPERATION_CONFLICT);
});

test('a thrown effect is recorded as failed and rethrown', () => {
  const ledger = createOperationLedger();
  const boom = Object.assign(new Error('boom'), { code: 'E_BOOM' });
  assert.throws(() => runStepEffect({ ledger, state: RUN_STATE, step: LEARN_STEP, perform: () => { throw boom; } }), boom);
  assert.deepEqual(ledger.claim('run-1:step:s1:attempt:1:effect'), { ok: true, state: 'failed', outcome: { ok: false, code: 'E_BOOM' } });
});

test('an async effect is recorded once it settles', async () => {
  const ledger = createOperationLedger();
  const result = await runStepEffect({ ledger, state: RUN_STATE, step: LEARN_STEP, perform: () => Promise.resolve(OK) });
  assert.equal(result, OK);
  assert.equal(ledger.claim('run-1:step:s1:attempt:1:effect').state, 'completed');
});

test('the ledger follows a handle its owner reopened after restore', (t) => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'ops.db');
  const first = sqliteStore(dbPath);
  if (!first) { t.skip('better-sqlite3 unavailable'); return; }
  const owner = { db: first.db, withTransaction: (fn) => owner.db.transaction(fn)() };
  const ledger = createOperationLedger({ store: owner });
  try {
    runStepEffect({ ledger, state: RUN_STATE, step: LEARN_STEP, perform: () => OK });
    // Restore closes the handle and opens a new one on the same file.
    owner.db.close();
    owner.db = null;
    const whileClosed = runStepEffect({ ledger, state: RUN_STATE, step: { ...LEARN_STEP, id: 's2' }, perform: () => OK });
    assert.equal(whileClosed.error.code, CODES.INTENT_UNRECORDED, 'a closed store fails closed');
    owner.db = sqliteStore(dbPath).db;
    assert.equal(ledger.claim('run-1:step:s1:attempt:1:effect').state, 'completed');
    const { calls, perform } = counted(OK);
    runStepEffect({ ledger, state: RUN_STATE, step: { ...LEARN_STEP, id: 's3' }, perform });
    assert.equal(calls.n, 1);
    assert.equal(ledger.claim('run-1:step:s3:attempt:1:effect').state, 'completed');
  } finally {
    try { if (owner.db) owner.db.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Production path: createAgent wires the ledger beside the journal.
// ---------------------------------------------------------------------------

const GOAL = 'learn that water is wet';

function makeKernel(dir) {
  return new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'graph-memory.json') });
}

function learnPlan(agent) {
  agent.baseAgent.plan = (goal) => ({
    ok: true,
    type: 'plan',
    data: {
      goal,
      objective: 'learn one fact',
      selectedTools: ['learn'],
      steps: [{ id: 's1', action: 'learn', tool: 'learn', input: 'water is wet' }],
      maxSteps: 1,
    },
  });
}

function operationRows(dbPath) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT operation_id, state FROM ${TABLE} ORDER BY operation_id`).all();
  } finally {
    db.close();
  }
}

test('createAgent runs a learn step through the operation ledger (SQLite)', (t) => {
  if (!sqliteStore(':memory:')) { t.skip('better-sqlite3 unavailable'); return; }
  const dir = tempDir();
  const dbPath = path.join(dir, 'agent.db');
  const storage = new HuqanStorage({ dbPath });
  try {
    const kernel = makeKernel(dir);
    const agent = createAgent({ kernel, storage, maxSteps: 1, maxIterations: 1, timeBudgetMs: 5000, dreamExperimentLoop: false });
    assert.ok(agent.baseAgent.experienceOperationLedger, 'the production factory must hand the agent a ledger');
    learnPlan(agent);
    let learned = 0;
    kernel.learn = () => { learned += 1; return OK; };
    const result = agent.run(GOAL);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(learned, 1);
    const rows = operationRows(dbPath);
    assert.equal(rows.length, 1);
    assert.match(rows[0].operation_id, /:step:s1:attempt:1:effect$/);
    assert.equal(rows[0].state, 'completed');
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('turning Experience off turns the ledger off too', () => {
  const dir = tempDir();
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'off.db') });
  try {
    const agent = createAgent({ kernel: makeKernel(dir), storage, experienceJournal: null });
    assert.equal(agent.baseAgent.experienceOperationLedger, null);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run killed after its effect resumes without repeating it (SQLite, real process)', (t) => {
  if (!sqliteStore(':memory:')) { t.skip('better-sqlite3 unavailable'); return; }
  const dir = tempDir();
  const dbPath = path.join(dir, 'crash.db');
  const marker = path.join(dir, 'effects.log');
  const repoRoot = path.resolve(__dirname, '..');
  // The child performs the effect and dies before the step's checkpoint:
  // exactly the window in which a blind resume would learn the fact twice.
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const Storage = require('./storage');
    const KernelV2 = require('./kernel.v2');
    const { createAgent } = require('./agentRuntime');
    const [dbPath, dir, marker, goal] = process.argv.slice(1);
    const storage = new Storage({ dbPath });
    const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'graph-memory.json') });
    const agent = createAgent({ kernel, storage, maxSteps: 1, maxIterations: 1, timeBudgetMs: 10000, dreamExperimentLoop: false });
    agent.baseAgent.plan = (g) => ({ ok: true, type: 'plan', data: { goal: g, objective: 'learn one fact', selectedTools: ['learn'], steps: [{ id: 's1', action: 'learn', tool: 'learn', input: 'water is wet' }], maxSteps: 1 } });
    kernel.learn = () => { fs.appendFileSync(marker, 'child\\n'); process.exit(0); };
    agent.run(goal);
  `;
  const child = spawnSync(process.execPath, ['-e', script, dbPath, dir, marker, GOAL], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'child\n', 'the child must have performed the effect');
  const pending = operationRows(dbPath);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'pending', 'the kill must leave the intent without an outcome');

  const storage = new HuqanStorage({ dbPath });
  try {
    const kernel = makeKernel(dir);
    const agent = createAgent({ kernel, storage, maxSteps: 1, maxIterations: 1, timeBudgetMs: 5000, dreamExperimentLoop: false });
    learnPlan(agent);
    kernel.learn = () => { fs.appendFileSync(marker, 'parent\n'); return OK; };
    const result = agent.run(GOAL);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'child\n', 'the resumed run must not repeat the effect');
    assert.equal(result.ok, false);
    assert.equal(result.data.resumed, true, 'the second run must be the resume of the killed one');
    const last = result.data.steps[result.data.steps.length - 1];
    assert.equal(last.status, 'blocked');
    assert.equal(last.result.error.code, CODES.UNCERTAIN);
    assert.equal(operationRows(dbPath)[0].state, 'pending', 'the resume must not claim the outcome is known');
    // The journal names the same attempt as a failure, so the read surfaces
    // show the refusal rather than a silent gap.
    const events = kernel.experienceJournal.read(result.data.observabilityRunId, { workspaceId: result.data.workspaceId });
    const failure = events.find((e) => e.type === 'failure' && e.payload && e.payload.code === CODES.UNCERTAIN);
    assert.ok(failure, JSON.stringify(events.map((e) => e.type)));
    assert.equal(`${failure.attemptId}:effect`, pending[0].operation_id);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
