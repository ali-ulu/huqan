'use strict';

/**
 * Experience Core E0-c — write-cost budget tests (#2375).
 *
 * Two halves:
 *
 * 1. the pure budget check, including the test that fails when the ceiling is
 *    exceeded — the acceptance `#2375` states ("a budget with a number in it,
 *    and a test that fails when the number is exceeded");
 * 2. the measurement harness, which appends to a real journal over SQLite and
 *    feeds the median into the same check. This is the design-phase harness
 *    the issue allows; it is not live-run evidence and does not claim to be.
 *
 * The harness cases skip when `better-sqlite3` is unavailable, matching
 * test/experience-journal.test.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MEASURED_DURABILITY_COST,
  WRITE_COST_CEILING,
  WRITE_COST_DECISIONS,
  WRITE_COST_REASONS,
  evaluateWriteCostBudget,
  summarizeWriteCost,
} = require('../lib/experience/write-cost-budget');
const { createExperienceJournal } = require('../lib/experience/journal');
const { applySqliteDurability } = require('../lib/sqlite-durability');

function sampleEvent(i, type) {
  return {
    runId: 'run-1',
    workspaceId: 'ws-1',
    eventId: `evt-${i}`,
    type,
    payload: { step: i, tool: 'apply_patch', path: 'lib/example.js', outcome: 'ok' },
  };
}

const LIFECYCLE = [
  'run_started',
  'action_proposed',
  'policy_decided',
  'execution_started',
  'execution_finished',
  'verification',
];

/**
 * Appends `n` events to a journal over a real SQLite file and returns the
 * measured per-append cost in milliseconds.
 */
function measureAppends({ durability, n }) {
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-writecost-'));
  const db = new Database(path.join(dir, 'journal.sqlite'));
  applySqliteDurability(db, durability);
  const store = { db, withTransaction: (fn) => db.transaction(fn)() };
  try {
    const journal = createExperienceJournal({ store });
    let firstBytes = 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i += 1) {
      const event = sampleEvent(i, i === 0 ? 'run_started' : 'action_proposed');
      if (i === 0) firstBytes = Buffer.byteLength(JSON.stringify(event));
      const res = journal.append(event);
      assert.equal(res.ok, true, `append ${i} refused: ${res.code}`);
    }
    const t1 = process.hrtime.bigint();
    return { msPerEvent: Number(t1 - t0) / 1e6 / n, bytesPerEvent: firstBytes, eventsPerRun: n };
  } finally {
    try { db.close(); } catch (_) { /* best effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

describe('E0-c write-cost budget: the check', () => {
  it('allows a measured run within every ceiling', () => {
    const res = evaluateWriteCostBudget({
      msPerEvent: MEASURED_DURABILITY_COST.EVIDENCE.msPerAppend,
      bytesPerEvent: 165,
      eventsPerRun: 61,
    });
    assert.equal(res.decision, WRITE_COST_DECISIONS.ALLOW);
    assert.equal(res.reason, WRITE_COST_REASONS.WITHIN_BUDGET);
  });

  it('refuses when the per-event cost exceeds the ceiling', () => {
    const res = evaluateWriteCostBudget({
      msPerEvent: WRITE_COST_CEILING.MAX_MS_PER_EVENT + 0.001,
      bytesPerEvent: 165,
      eventsPerRun: 61,
    });
    assert.equal(res.decision, WRITE_COST_DECISIONS.REFUSE);
    assert.equal(res.reason, WRITE_COST_REASONS.EVENT_TOO_SLOW);
    assert.match(res.detail, /msPerEvent/);
  });

  it('refuses when the per-event size exceeds the ceiling', () => {
    const res = evaluateWriteCostBudget({
      msPerEvent: 1,
      bytesPerEvent: WRITE_COST_CEILING.MAX_JSON_BYTES_PER_EVENT + 1,
      eventsPerRun: 61,
    });
    assert.equal(res.decision, WRITE_COST_DECISIONS.REFUSE);
    assert.equal(res.reason, WRITE_COST_REASONS.EVENT_TOO_LARGE);
  });

  it('refuses when a run exceeds the event-count ceiling', () => {
    const res = evaluateWriteCostBudget({
      msPerEvent: 1,
      bytesPerEvent: 165,
      eventsPerRun: WRITE_COST_CEILING.MAX_EVENTS_PER_RUN + 1,
    });
    assert.equal(res.decision, WRITE_COST_DECISIONS.REFUSE);
    assert.equal(res.reason, WRITE_COST_REASONS.TOO_MANY_EVENTS);
  });

  it('refuses an unmeasured run rather than treating absence as compliance', () => {
    const res = evaluateWriteCostBudget({ msPerEvent: 1, bytesPerEvent: 165 });
    assert.equal(res.decision, WRITE_COST_DECISIONS.REFUSE);
    assert.equal(res.reason, WRITE_COST_REASONS.UNMEASURED);
    assert.match(res.detail, /eventsPerRun/);
  });

  it('refuses a non-numeric measurement instead of coercing it to zero', () => {
    const res = evaluateWriteCostBudget({ msPerEvent: '0', bytesPerEvent: 165, eventsPerRun: 61 });
    assert.equal(res.decision, WRITE_COST_DECISIONS.REFUSE);
    assert.equal(res.reason, WRITE_COST_REASONS.UNMEASURED);
  });

  it('a ceiling override is honoured, so the bound is a knob not a slogan', () => {
    const tight = evaluateWriteCostBudget(
      { msPerEvent: 2, bytesPerEvent: 165, eventsPerRun: 61 },
      { ceiling: { MAX_MS_PER_EVENT: 1 } },
    );
    assert.equal(tight.decision, WRITE_COST_DECISIONS.REFUSE);
    assert.equal(tight.reason, WRITE_COST_REASONS.EVENT_TOO_SLOW);
  });
});

describe('E0-c write-cost budget: summarizing measured runs', () => {
  it('reports median and p99 and drops non-numeric samples', () => {
    const summary = summarizeWriteCost([1, 2, 3, 4, 5, null, 'x', undefined, NaN]);
    assert.equal(summary.count, 5);
    assert.equal(summary.median, 3);
    assert.equal(summary.min, 1);
    assert.equal(summary.max, 5);
    assert.ok(summary.p99 >= 4.9 && summary.p99 <= 5);
  });

  it('an empty sample set summarizes to nulls, not zeroes', () => {
    const summary = summarizeWriteCost([]);
    assert.equal(summary.count, 0);
    assert.equal(summary.median, null);
    assert.equal(summary.p99, null);
  });
});

describe('E0-c write-cost budget: measured against a real journal', () => {
  it('a real SQLite journal append stays within the per-event budget', (t) => {
    let available = true;
    try {
      require('better-sqlite3');
    } catch (_) {
      available = false;
    }
    if (!available) {
      t.skip('better-sqlite3 unavailable');
      return;
    }

    const runs = [
      measureAppends({ durability: 'RESUMABLE', n: 500 }),
      measureAppends({ durability: 'RESUMABLE', n: 500 }),
      measureAppends({ durability: 'RESUMABLE', n: 500 }),
    ];
    const summary = summarizeWriteCost(runs.map((r) => r.msPerEvent));
    const res = evaluateWriteCostBudget({
      msPerEvent: summary.median,
      bytesPerEvent: runs[0].bytesPerEvent,
      eventsPerRun: runs[0].eventsPerRun,
    }, { ceiling: { MAX_EVENTS_PER_RUN: 2 * runs[0].eventsPerRun } });

    assert.equal(res.decision, WRITE_COST_DECISIONS.ALLOW,
      `median ${summary.median} ms/append, p99 ${summary.p99} exceeded the ceiling: ${res.reason} (${res.detail})`);
  });
});

/**
 * Drives a real run through the production factory and measures it, rather than
 * appending synthetic events. `#2375` decision 1 asks for median/p99 on real
 * runs — a simple run, a ten-step run and a run with repairs — and decision 3
 * asks for the added wall-clock as a percentage. Timing the factory's own
 * journal is the only way to answer either, so this is the harness the issue
 * actually names; the synthetic one above only proves the ceiling is
 * enforceable.
 *
 * `retrySteps` makes that many steps fail once with a retryable error, which is
 * the repair path the third profile covers.
 */
function measureRealRun({ steps, retrySteps = 0 }) {
  const KernelV2 = require('../kernel.v2');
  const HuqanStorage = require('../storage');
  const { createAgent } = require('../agentRuntime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-realrun-'));
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'real-run.db') });
  // The off switch must not be inherited from a sibling test.
  const previousEnabled = process.env.HUQAN_EXPERIENCE_ENABLED;
  delete process.env.HUQAN_EXPERIENCE_ENABLED;
  try {
    const kernel = new KernelV2({
      noLoad: true, useSQLite: false, loadPlugins: false,
      memoryPath: path.join(dir, 'graph-memory.json'),
    });
    const agent = createAgent({
      kernel, storage, maxSteps: steps, maxIterations: steps + 2,
      timeBudgetMs: 20000, dreamExperimentLoop: false,
    });
    const journal = kernel.experienceJournal;
    assert.ok(journal, 'the production factory must build the journal');

    // Time the journal's own transaction, which is the fail-closed write the
    // budget is about. The journal looks the method up per call, so wrapping it
    // here measures the real appends without reaching into the journal.
    const withTransaction = storage.withTransaction.bind(storage);
    const appendMs = [];
    storage.withTransaction = (fn) => {
      const t0 = process.hrtime.bigint();
      try {
        return withTransaction(fn);
      } finally {
        appendMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    };

    agent.baseAgent.plan = (goal) => ({
      ok: true,
      type: 'plan',
      data: {
        goal,
        objective: 'measure a real run',
        selectedTools: ['ask'],
        steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i + 1}`, action: 'ask', tool: 'ask', input: `q${i + 1}` })),
        maxSteps: steps,
      },
    });
    const failedOnce = new Set();
    kernel.ask = (question) => {
      const index = Number(String(question).replace('q', ''));
      if (index <= retrySteps && !failedOnce.has(index)) {
        failedOnce.add(index);
        return { ok: false, type: 'ask', data: null, evidence: [], error: { code: 'ETIMEDOUT', message: 'fetch timeout' } };
      }
      return { ok: true, type: 'ask', data: { summary: `answer for ${question}` }, evidence: [] };
    };

    const runStart = process.hrtime.bigint();
    const result = agent.run('measure a real run end to end');
    const runMs = Number(process.hrtime.bigint() - runStart) / 1e6;

    const runId = result?.data?.observabilityRunId;
    const events = journal.read(runId, { workspaceId: result.data.workspaceId });
    const bytes = events.map((e) => Buffer.byteLength(JSON.stringify(e))).sort((a, b) => a - b);
    const appendSummary = summarizeWriteCost(appendMs);
    const journalMs = appendMs.reduce((sum, ms) => sum + ms, 0);

    return {
      eventsPerRun: events.length,
      bytesPerEvent: bytes[Math.floor(bytes.length / 2)],
      msPerEvent: appendSummary.median,
      msPerEventP99: appendSummary.p99,
      runMs,
      journalMs,
      addedPercent: (journalMs / runMs) * 100,
      closed: journal.manifest(runId).closed,
    };
  } finally {
    if (previousEnabled === undefined) delete process.env.HUQAN_EXPERIENCE_ENABLED;
    else process.env.HUQAN_EXPERIENCE_ENABLED = previousEnabled;
    try { storage.db.close(); } catch (_) { /* best effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

describe('E0-c write-cost budget: real integrated runs (#2375 decision 1 and 3)', () => {
  it('a simple, a ten-step and a repaired run each stay inside the budget', (t) => {
    let available = true;
    try {
      require('better-sqlite3');
    } catch (_) {
      available = false;
    }
    if (!available) {
      t.skip('better-sqlite3 unavailable');
      return;
    }

    const simple = measureRealRun({ steps: 1 });
    const tenStep = measureRealRun({ steps: 10 });
    const repaired = measureRealRun({ steps: 10, retrySteps: 3 });

    // The event profile the module header documents, pinned to reality so the
    // two cannot drift apart again.
    assert.equal(simple.eventsPerRun, 4);
    assert.equal(tenStep.eventsPerRun, 22);
    assert.equal(repaired.eventsPerRun, 28);
    for (const run of [simple, tenStep, repaired]) {
      assert.equal(run.closed, true, 'a completed run must close its Experience');
    }

    const eventsPerRun = summarizeWriteCost([simple.eventsPerRun, tenStep.eventsPerRun, repaired.eventsPerRun]);
    const msPerEvent = summarizeWriteCost([simple.msPerEvent, tenStep.msPerEvent, repaired.msPerEvent]);
    const bytesPerEvent = summarizeWriteCost([simple.bytesPerEvent, tenStep.bytesPerEvent, repaired.bytesPerEvent]);

    const res = evaluateWriteCostBudget({
      msPerEvent: msPerEvent.median,
      bytesPerEvent: bytesPerEvent.median,
      eventsPerRun: eventsPerRun.max,
    });
    assert.equal(res.decision, WRITE_COST_DECISIONS.ALLOW,
      `real runs: median ${msPerEvent.median} ms/event (p99 ${msPerEvent.p99}), `
      + `${eventsPerRun.max} events/run — ${res.reason} (${res.detail})`);

    // Decision 3: the added wall-clock as a percentage, at both medians. The
    // simple run is the worst case because it has the least work to hide the
    // write behind, so it is the one worth asserting.
    assert.ok(simple.addedPercent < 100,
      `the journal added ${simple.addedPercent.toFixed(1)}% to a simple run`);
  });
});
