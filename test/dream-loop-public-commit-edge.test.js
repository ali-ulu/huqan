'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  createInitialState,
  startFromDreamResult,
  advanceAfterVerification,
} = require('../lib/dream-experiment-loop');

// #2177: the dream experiment loop committed a verified hypothesis through the
// Kernel's private `_commitBackgroundEdge`. `commitBackgroundEdge` is already
// public on Kernel and KernelV2, and the private name only forwards to it, so
// the loop uses the public name instead.

function publicOnlyKernel() {
  const journal = new Map();
  const edges = [];
  return {
    edges,
    kernel: {
      graph: {
        runMutationOnce(operationId, mutate) {
          if (journal.has(operationId)) return { replayed: true, result: journal.get(operationId) };
          const result = mutate();
          journal.set(operationId, result);
          return { replayed: false, result, persisted: true };
        },
        appendAuditEvent(event) { return { auditId: 'audit-1', ...event }; },
      },
      commitBackgroundEdge(from, to, relation, source, opts) {
        const result = { decision: 'allow', edge: { from, to, relation, source, workspaceId: opts.workspaceId }, admission: { outcome: 'allow' } };
        edges.push({ from, to, relation, source });
        return result;
      },
      _commitBackgroundEdge() { throw new Error('private Kernel#_commitBackgroundEdge used'); },
    },
  };
}

test('a verified hypothesis is committed through the public commitBackgroundEdge', () => {
  const { kernel, edges } = publicOnlyKernel();
  const initial = createInitialState({ workspaceId: 'ws-2177', goal: 'test', maxHypotheses: 1, maxCycles: 1 });
  const generated = startFromDreamResult(kernel, initial, [
    { from: 'kedi', to: 'hayvan', relation: 'tür', confidence: 0.91 },
  ], { workspaceId: 'ws-2177', goal: 'test' });

  const observed = advanceAfterVerification(kernel, generated.state, {
    step: generated.nextStep,
    status: 'done',
    result: { ok: true, data: { status: 'verified', confidence: 0.88 }, evidence: [{ kind: 'edge' }] },
  }, {
    workspaceId: 'ws-2177',
    goal: 'test',
    causalSimulator: {
      simulateChange: () => ({
        ok: true, mode: 'causal-backed', confidence: 0.9, causalChains: 1,
        affectedNodes: [{ nodeId: 'hayvan', confidence: 0.85, impact: 0.8 }],
      }),
    },
  });

  // A reach for the private name throws inside the commit; the loop then
  // blocks with DREAM_EXPERIMENT_EDGE_COMMIT_FAILED and records no observation.
  assert.equal(observed.blocked, false, `loop blocked: ${JSON.stringify(observed.state.lastError)}`);
  assert.equal(observed.state.observations[0].signal, 'support');
  assert.equal(observed.state.observations[0].commitDecision, 'allow');
  assert.deepEqual(edges, [{ from: 'kedi', to: 'hayvan', relation: 'tür', source: 'dreamExperiment' }]);
});

test('the dream experiment loop source names no private _commitBackgroundEdge', () => {
  // #2120 split: the loop is composed of the entry file plus its
  // ./dream-experiment-loop-* require chain; every part must stay public-only.
  const entry = path.join(__dirname, '..', 'lib', 'dream-experiment-loop.js');
  const entrySource = fs.readFileSync(entry, 'utf8');
  const chain = [...entrySource.matchAll(/require\('(\.\/dream-experiment-loop-[^']+)'\)/g)]
    .map(match => path.join(__dirname, '..', 'lib', `${match[1].slice(2)}.js`));
  assert.ok(chain.length > 0, 'expected the entry to require its ./dream-experiment-loop-* chain');
  const source = [entry, ...chain].map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /_commitBackgroundEdge/);
});
