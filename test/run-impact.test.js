'use strict';

// An agent run's cumulative impact: the recorded firewall risk of its steps,
// summed and persisted with the run (#2505). Recorded only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Storage = require('../storage');
const { finalizeAgentRun } = require('../lib/agent-run-finalization');
const { summarizeRunImpact } = require('../lib/run-impact');

const step = (score) => ({ tool: 'kernel.ask', actionFirewall: score === undefined ? null : { decision: 'allow', risk: { score } } });

test('the run total sums every step firewall score on the 0-100 scale', () => {
  const impact = summarizeRunImpact([step(0.05), step(0.55), step(1)]);
  assert.equal(impact.steps, 3);
  assert.equal(impact.scoredSteps, 3);
  assert.equal(impact.recordedScoreTotal, 5 + 55 + 100);
  assert.equal(impact.maxScore, 100);
  assert.equal(impact.status, 'computed');
  assert.equal(impact.enforced, false);
});

test('a step the firewall never scored is unscored, never 0', () => {
  const impact = summarizeRunImpact([step(0.3), step(undefined)]);
  assert.equal(impact.scoredSteps, 1);
  assert.equal(impact.unscoredSteps, 1);
  assert.equal(impact.recordedScoreTotal, 30);
  assert.equal(impact.status, 'partial');
  assert.deepEqual(impact.reasons, ['1 step(s) carry no firewall risk score']);
});

test('a run with no steps is a measured zero; a run with no step records is unknown', () => {
  const empty = summarizeRunImpact([]);
  assert.equal(empty.recordedScoreTotal, 0);
  assert.equal(empty.maxScore, null);
  assert.equal(empty.status, 'computed');
  const missing = summarizeRunImpact(undefined);
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.recordedScoreTotal, null);
});

test('finalizing a run persists its impact with the run and on the returned state', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-run-impact-'));
  const storage = new Storage({ dbPath: path.join(dir, 'memory.db') });
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const state = {
    runId: 'run-impact-1', goal: 'goal', workspaceId: 'w', checkpointId: 'cp-1',
    status: 'completed', iteration: 2, iterationsDelta: 2, completedSteps: 2,
    steps: [step(0.2), step(0.7)],
  };
  const result = finalizeAgentRun({
    storage, state, goalMemory: state,
    saveCheckpoint: (current) => storage.saveCheckpoint({ ...current, id: 'cp-1', state: current }),
  });
  assert.equal(result.ok, true);
  assert.equal(state.impact.recordedScoreTotal, 90);
  assert.equal(state.impact.maxScore, 70);
  const persisted = JSON.parse(storage.db.prepare('SELECT state_json FROM agent_runs WHERE id = ?').get('run-impact-1').state_json);
  assert.deepEqual(persisted.impact, JSON.parse(JSON.stringify(state.impact)));
  assert.equal(persisted.impact.enforced, false);
});
