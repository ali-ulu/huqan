'use strict';

/**
 * The operator verdict on an uncertain Experience operation (#3033).
 *
 * A step that was in flight when a run stopped is refused on resume and its
 * operation stays pending. `experience-reconcile` is where a person who checked
 * the outside world records whether the effect happened; the resume then skips
 * the step (performed) or runs it once more (not performed).
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
const { createOperationLedger, NOT_PERFORMED } = require('../lib/experience/reconciliation');
const { runStepEffect, CODES } = require('../lib/experience/effect-boundary');
const { runExperienceReconcileCommand } = require('../lib/cli-experience-reconcile');
const { createCliCommandHandlers } = require('../lib/cli-command-handlers');
const { parseCommand } = require('../lib/command-parser');

const OP = 'run-1:step:s1:attempt:1:effect';
const STEP = Object.freeze({ id: 's1', action: 'learn', tool: 'learn', input: 'water is wet', attempt: 1 });
const STATE = Object.freeze({ runId: 'run-1', workspaceId: 'ws' });
const OK = Object.freeze({ ok: true, type: 'learn', data: { learned: 1 }, evidence: [], error: null, meta: {} });

/** A ledger holding one operation that was in flight when the run stopped. */
function uncertainLedger() {
  const ledger = createOperationLedger();
  runStepEffect({ ledger, state: STATE, step: STEP, perform: () => OK });
  // Re-create the crash: same identity, intent recorded, no outcome.
  const crashed = createOperationLedger();
  const intent = { tool: 'learn', stepId: 's1', attempt: 1, inputSha256: require('node:crypto').createHash('sha256').update('water is wet').digest('hex') };
  crashed.begin({ operationId: OP, runId: 'run-1', workspaceId: 'ws', intent });
  return crashed;
}

function counted() {
  const calls = { n: 0 };
  return { calls, perform: () => { calls.n += 1; return OK; } };
}

test('resolve needs a boolean verdict, an actor and a reason', () => {
  const ledger = uncertainLedger();
  for (const bad of [{}, { performed: 'yes', actor: 'a', reason: 'r' }, { performed: true, actor: '', reason: 'r' }, { performed: true, actor: 'a', reason: '' }]) {
    assert.deepEqual(ledger.resolve({ operationId: OP, ...bad }), { ok: false, code: 'invalid_resolution' });
  }
  assert.equal(ledger.claim(OP).state, 'pending', 'a refused verdict changes nothing');
});

test('only a pending operation can be resolved', () => {
  const ledger = uncertainLedger();
  assert.equal(ledger.resolve({ operationId: OP, performed: true, actor: 'operator:test', reason: 'fact is in the graph' }).ok, true);
  assert.deepEqual(ledger.resolve({ operationId: OP, performed: false, actor: 'operator:test', reason: 'changed my mind' }), { ok: false, code: 'bad_transition' });
  assert.deepEqual(ledger.resolve({ operationId: 'nope', performed: true, actor: 'operator:test', reason: 'x' }), { ok: false, code: 'unknown_operation' });
});

test('"performed" completes the operation and the resume skips the step', () => {
  const ledger = uncertainLedger();
  ledger.resolve({ operationId: OP, performed: true, actor: 'operator:test', reason: 'fact is in the graph' });
  const claimed = ledger.claim(OP);
  assert.equal(claimed.state, 'completed');
  assert.equal(claimed.outcome.resolvedBy, 'operator:test');
  assert.equal(claimed.outcome.reason, 'fact is in the graph');
  const { calls, perform } = counted();
  const result = runStepEffect({ ledger, state: STATE, step: STEP, perform });
  assert.equal(calls.n, 0);
  assert.equal(result.ok, true);
  assert.equal(result.meta.experienceOperation.replayed, true);
});

test('"not performed" lets the step run once more and keeps the verdict', () => {
  const ledger = uncertainLedger();
  ledger.resolve({ operationId: OP, performed: false, actor: 'operator:test', reason: 'fact is absent' });
  assert.equal(ledger.claim(OP).outcome.code, NOT_PERFORMED);
  const { calls, perform } = counted();
  assert.equal(runStepEffect({ ledger, state: STATE, step: STEP, perform }), OK);
  assert.equal(calls.n, 1);
  const claimed = ledger.claim(OP);
  assert.equal(claimed.state, 'completed');
  assert.equal(claimed.outcome.reopenedFrom.code, NOT_PERFORMED, 'the row still says why the effect ran again');
  assert.equal(claimed.outcome.reopenedFrom.resolvedBy, 'operator:test');
  // It ran; a further resume replays instead of running a third time.
  runStepEffect({ ledger, state: STATE, step: STEP, perform });
  assert.equal(calls.n, 1);
});

test('only an operator "not performed" verdict can be reopened', () => {
  const ledger = createOperationLedger();
  runStepEffect({ ledger, state: STATE, step: STEP, perform: () => ({ ok: false, error: { code: 'LEARN_REJECTED' } }) });
  assert.deepEqual(ledger.reopen(OP), { ok: false, code: 'bad_transition' });
  const { calls, perform } = counted();
  runStepEffect({ ledger, state: STATE, step: STEP, perform });
  assert.equal(calls.n, 0, "the effect's own failure replays; only a verified absence reruns");
});

test('reconcile lists pending operations, optionally for one workspace', () => {
  const ledger = createOperationLedger();
  ledger.begin({ operationId: 'a', runId: 'r1', workspaceId: 'ws-a' });
  ledger.begin({ operationId: 'b', runId: 'r2', workspaceId: 'ws-b' });
  assert.deepEqual(ledger.reconcile().map((item) => item.operationId).sort(), ['a', 'b']);
  assert.deepEqual(ledger.reconcile({ workspaceId: 'ws-b' }).map((item) => item.operationId), ['b']);
});

test('the uncertain refusal names the command that resolves it', () => {
  const ledger = uncertainLedger();
  const result = runStepEffect({ ledger, state: STATE, step: STEP, perform: () => OK });
  assert.equal(result.error.code, CODES.UNCERTAIN);
  assert.match(result.error.message, /experience-reconcile <operationId> --performed\|--not-performed --reason/);
});

// ---------------------------------------------------------------------------
// The CLI command.
// ---------------------------------------------------------------------------

function cliWith(ledger) {
  return { agent: { baseAgent: { experienceOperationLedger: ledger } } };
}

function run(input, ledger) {
  const parsed = parseCommand(input);
  assert.equal(parsed.command, 'experience-reconcile');
  const handlers = createCliCommandHandlers({ callMcpTool: () => null, createApprovalStoreFromKernel: () => null });
  return handlers['experience-reconcile'](cliWith(ledger), parsed.args);
}

test('experience-reconcile lists, validates and records a verdict', () => {
  const ledger = uncertainLedger();
  assert.match(run('experience-reconcile', ledger), new RegExp(`1 uncertain operation\\(s\\)\\n  ${OP} run run-1 \\[ws\\]`));
  assert.match(run('experience-reconcile --workspace other', ledger), /no uncertain operations in workspace other/);
  assert.match(run(`experience-reconcile ${OP} --reason looked`, ledger), /exactly one of --performed or --not-performed/);
  assert.match(run(`experience-reconcile ${OP} --performed --not-performed --reason looked`, ledger), /exactly one of/);
  assert.match(run(`experience-reconcile ${OP} --performed`, ledger), /--reason <text> is required/);
  assert.equal(ledger.claim(OP).state, 'pending', 'no invalid form may record anything');
  assert.match(run(`experience-reconcile ${OP} --performed --reason the fact is in the graph`, ledger), /recorded as performed/);
  const claimed = ledger.claim(OP);
  assert.equal(claimed.outcome.reason, 'the fact is in the graph');
  assert.equal(claimed.outcome.resolvedBy, 'operator:cli');
  assert.match(run(`experience-reconcile ${OP} --not-performed --reason again`, ledger), /bad_transition/);
});

test('experience-reconcile says so when there is no ledger', () => {
  assert.match(runExperienceReconcileCommand({ args: {}, agent: {} }), /unavailable/);
  assert.match(runExperienceReconcileCommand({ args: {} }), /unavailable/);
});

// ---------------------------------------------------------------------------
// Production path: kill, refuse, resolve, resume.
// ---------------------------------------------------------------------------

const GOAL = 'learn that water is wet';

function killAfterEffect(dir, dbPath, marker) {
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
  const child = spawnSync(process.execPath, ['-e', script, dbPath, dir, marker, GOAL], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
}

function resumeAgent(dir, storage, marker) {
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'graph-memory.json') });
  const agent = createAgent({ kernel, storage, maxSteps: 1, maxIterations: 2, timeBudgetMs: 5000, dreamExperimentLoop: false });
  agent.baseAgent.plan = (goal) => ({ ok: true, type: 'plan', data: { goal, objective: 'learn one fact', selectedTools: ['learn'], steps: [{ id: 's1', action: 'learn', tool: 'learn', input: 'water is wet' }], maxSteps: 1 } });
  kernel.learn = () => { fs.appendFileSync(marker, 'parent\n'); return OK; };
  return agent;
}

for (const [flag, expectedEffects] of [['--performed', 'child\n'], ['--not-performed', 'child\nparent\n']]) {
  test(`kill, refuse, resolve ${flag}, resume (SQLite, real process)`, (t) => {
    try { require('better-sqlite3'); } catch (_) { t.skip('better-sqlite3 unavailable'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-resolve-'));
    const dbPath = path.join(dir, 'crash.db');
    const marker = path.join(dir, 'effects.log');
    killAfterEffect(dir, dbPath, marker);
    const storage = new HuqanStorage({ dbPath });
    try {
      const agent = resumeAgent(dir, storage, marker);
      const refused = agent.run(GOAL);
      assert.equal(refused.data.status, 'paused');
      assert.equal(refused.data.pauseReason, 'experience_effect_uncertain');
      const { operationId } = refused.data.uncertainOperation;
      assert.match(operationId, /:step:s1:attempt:1:effect$/);
      // Resuming before a verdict refuses again and still does not run it.
      assert.equal(agent.run(GOAL).data.pauseReason, 'experience_effect_uncertain');
      assert.equal(fs.readFileSync(marker, 'utf8'), 'child\n');

      const listed = run('experience-reconcile', agent.baseAgent.experienceOperationLedger);
      assert.match(listed, new RegExp(operationId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(run(`experience-reconcile ${operationId} ${flag} --reason checked the graph by hand`, agent.baseAgent.experienceOperationLedger), /recorded as/);

      const resumed = agent.run(GOAL);
      assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
      assert.equal(resumed.data.status, 'completed');
      assert.equal(resumed.data.pauseReason, undefined, 'the resolved pause does not linger');
      assert.equal(resumed.data.uncertainOperation, undefined);
      assert.equal(fs.readFileSync(marker, 'utf8'), expectedEffects);
      assert.match(run('experience-reconcile', agent.baseAgent.experienceOperationLedger), /no uncertain operations/);
    } finally {
      storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
