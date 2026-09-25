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
