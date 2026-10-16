'use strict';

/**
 * #3495 follow-up: the deterministic Experience write-cost guard is a refusal
 * gate for a live agent run, not only an observability signal.
 *
 * `lib/experience/budgeted-journal.js` already measured every append; the new
 * read side (`writeCostStop`) surfaces `writeCostGuard`'s own verdict, and the
 * shared step executor (`lib/agent-step-executor.js`) stops the run blocked
 * when that verdict is `refuse`. Both the V1 loop and AgentV3 loop run through
 * that executor, so one seam covers both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KernelV2 = require('../kernel.v2');
const HuqanStorage = require('../storage');
const { createAgent } = require('../agentRuntime');
const { createExperienceJournal } = require('../lib/experience/journal');
const { budgetExperienceJournal } = require('../lib/experience/budgeted-journal');
const { writeCostStop } = require('../lib/experience/runtime-seam');
const { WRITE_COST_CEILING } = require('../lib/experience/write-cost-budget');

const OVERSIZED = 'x'.repeat(WRITE_COST_CEILING.MAX_JSON_BYTES_PER_EVENT + 1024);

test('the budgeted journal exposes the deterministic guard and attaches it to the append', () => {
  const journal = budgetExperienceJournal(createExperienceJournal(), { now: () => 0 });
  const small = journal.append({ runId: 'run-small', eventId: 'e1', type: 'run_started' });
  assert.equal(small.ok, true);
  assert.equal(small.writeCostGuard.decision, 'allow');
  assert.equal(journal.writeCostGuard('run-small').decision, 'allow');

  const large = journal.append({ runId: 'run-large', eventId: 'e1', type: 'run_started', payload: { content: OVERSIZED } });
  assert.equal(large.ok, true, 'the audit event is still recorded');
  assert.equal(large.writeCostGuard.decision, 'refuse');
  assert.equal(large.writeCostGuard.reason, 'write_cost_event_too_large');
  assert.equal(journal.writeCostGuard('run-large').reason, 'write_cost_event_too_large');
});

test('writeCostStop is a no-op for a plain journal, a missing run and a within-budget run', () => {
  assert.deepEqual(writeCostStop(null, { runId: 'r' }), { stop: false, guard: null });
  assert.deepEqual(writeCostStop(createExperienceJournal(), { runId: 'r' }), { stop: false, guard: null },
    'an unwrapped journal has no guard to read');
  const journal = budgetExperienceJournal(createExperienceJournal(), { now: () => 0 });
  journal.append({ runId: 'r', eventId: 'e1', type: 'run_started' });
  assert.equal(writeCostStop(journal, { runId: 'r' }).stop, false);
  assert.equal(writeCostStop(journal, {}).stop, false, 'no run identity is not a stop');
  assert.equal(writeCostStop(journal, { runId: 'unknown' }).stop, false, 'an unmeasured run is not a stop');
});

// ---------------------------------------------------------------------------
// Production path through createAgent and the real journal.
// ---------------------------------------------------------------------------

function withAgent(t, goalSteps) {
  try { require('better-sqlite3'); } catch (_) { t.skip('better-sqlite3 unavailable'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-cost-'));
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'life.db') });
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'graph-memory.json') });
  const agent = createAgent({ kernel, storage, maxSteps: goalSteps.length, maxIterations: goalSteps.length, timeBudgetMs: 5000, dreamExperimentLoop: false });
  agent.baseAgent.plan = (goal) => ({ ok: true, type: 'plan', data: { goal, objective: 'cost', selectedTools: goalSteps.map((s) => s.tool), steps: goalSteps, maxSteps: goalSteps.length } });
  kernel.learn = () => ({ ok: true, type: 'learn', data: { learned: 1, admission: { outcome: 'admitted', graphWrite: true, receiptId: 'r1' } }, evidence: [] });
  return agent;
}

const ONE_LEARN = [{ id: 's1', action: 'learn', tool: 'learn', input: 'water is wet' }];

test('a real agent run whose trace crosses the bytes ceiling stops blocked, not unbounded', (t) => {
  const agent = withAgent(t, ONE_LEARN);
  if (!agent) return;

  // The goal rides into the run's own `run_started` payload, so a goal larger
  // than the per-event ceiling is exactly the deterministic over-budget case.
  const result = agent.run(OVERSIZED);

  assert.equal(result.ok, false, JSON.stringify(result.error));
  assert.equal(result.error.code, 'AGENT_BLOCKED');
  assert.equal(result.data.status, 'blocked');
  const blocked = result.data.steps.find((step) => step.result?.error?.code === 'WRITE_COST_BUDGET_EXCEEDED');
  assert.ok(blocked, 'the run must carry a write-cost refusal step');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.result.meta.writeCostGuard.decision, 'refuse');
  assert.equal(blocked.result.meta.writeCostGuard.reason, 'write_cost_event_too_large');
});

test('a normal run is not refused: the gate only fires past the ceiling', (t) => {
  const agent = withAgent(t, ONE_LEARN);
  if (!agent) return;

  const result = agent.run('learn one fact');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(!result.data.steps.some((step) => step.result?.error?.code === 'WRITE_COST_BUDGET_EXCEEDED'));
});

test('the V1 loop ends the run at the first write-cost refusal instead of draining the queue', (t) => {
  const Agent = require('../agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-cost-v1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'graph-memory.json') });
  // The V1 run state carries no run identity of its own; in production the
  // kernel's observability service stamps `observabilityRunId` on
  // beforeAgentRun (lib/observability/service-runs.js). Stamp it the same way.
  kernel.observability = { recordLifecycle: (_event, data) => { const state = data.state || data; state.observabilityRunId = state.observabilityRunId || 'run-v1'; } };
  let learnCalls = 0;
  kernel.learn = () => { learnCalls += 1; return { ok: true, type: 'learn', data: { learned: 1 }, evidence: [] }; };
  const steps = [
    { id: 's1', action: 'learn', tool: 'learn', input: 'water is wet' },
    { id: 's2', action: 'learn', tool: 'learn', input: 'fire is hot' },
  ];
  const agent = new Agent({ kernel, maxSteps: steps.length, memoryPath: path.join(dir, 'agent-memory.json') });
  agent.experienceJournal = budgetExperienceJournal(createExperienceJournal(), { now: () => 0 });
  agent.plan = (goal) => ({ ok: true, type: 'plan', data: { goal, objective: 'cost', selectedTools: ['learn'], steps, maxSteps: steps.length } });

  const result = agent.run(OVERSIZED, { resume: false });

  assert.equal(result.ok, false, JSON.stringify(result.error));
  assert.equal(result.error.code, 'AGENT_BLOCKED');
  assert.equal(result.data.status, 'blocked');
  assert.equal(result.data.steps.length, 1, 'the second queued step must not run');
  assert.equal(learnCalls, 1);
  const refused = result.data.steps[0].result;
  assert.equal(refused.error.code, 'WRITE_COST_BUDGET_EXCEEDED');
  assert.deepEqual(refused.data, { learned: 1 }, 'the step ran, so its outcome stays on the report');
  assert.equal(refused.meta.toolOk, true);
  assert.equal(refused.meta.toolError, null);
  assert.deepEqual(result.data.queuedSteps.map((step) => step.id), ['s2'], 'a resume must not re-run the step that already ran');
  assert.equal(result.data.remainingSteps, 1);
});
