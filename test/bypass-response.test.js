'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { recordBypassSignal, readBypassState } = require('../lib/bypass-signal-state');

const {
  RESPONSE_VERSION,
  normalizePolicy,
  evaluateBypassResponse,
} = require('../lib/bypass-response');

// The Codex design's proposed starter, kept in tests and docs -- never in
// the module, which takes its policy as an argument.
const STARTER = Object.freeze({ refusedRetry: Object.freeze({ reviewAfter: 2, blockAfter: 3 }) });

function state(fingerprints) {
  const byFingerprint = {};
  for (const [print, entry] of Object.entries(fingerprints)) {
    byFingerprint[print] = { count: entry.count, kinds: entry.kinds, lastAt: '2026-01-01T00:00:00.000Z' };
  }
  return {
    workspaceId: 'workspace-a',
    agentId: 'agent-1',
    windowMs: 600000,
    at: '2026-01-01T00:10:00.000Z',
    total: Object.keys(fingerprints).length,
    byFingerprint,
  };
}

test('retry counts map to none, review and block-and-propose', () => {
  const result = evaluateBypassResponse(state({
    once: { count: 1, kinds: ['refused-retry'] },
    twice: { count: 2, kinds: ['refused-retry'] },
    thrice: { count: 3, kinds: ['refused-retry'] },
  }), STARTER);
  assert.equal(result.version, RESPONSE_VERSION);
  assert.equal(result.responses.once.response, 'none');
  assert.equal(result.responses.twice.response, 'review');
  assert.equal(result.responses.thrice.response, 'block-and-propose');
  assert.equal(result.recommendReview, true);
  assert.equal(result.recommendStop, true);
  assert.ok(Object.isFrozen(result));
});

test('one escape or widening blocks and proposes, egress stays deployment-defined', () => {
  const result = evaluateBypassResponse(state({
    esc: { count: 1, kinds: ['sandbox-escape'] },
    wide: { count: 1, kinds: ['identity-widening'] },
    egr: { count: 5, kinds: ['unexpected-egress'] },
  }), STARTER);
  assert.equal(result.responses.esc.response, 'block-and-propose');
  assert.equal(result.responses.wide.response, 'block-and-propose');
  assert.equal(result.responses.egr.response, 'none');
  assert.equal(result.recommendStop, true);
});

test('policy has no defaults: missing or disordered bands throw', () => {
  assert.throws(() => evaluateBypassResponse(state({}), null), /policy must be an object/);
  assert.throws(() => evaluateBypassResponse(state({}), {}), /refusedRetry is required/);
  assert.throws(
    () => evaluateBypassResponse(state({}), { refusedRetry: { reviewAfter: 3, blockAfter: 2 } }),
    /reviewAfter <= blockAfter/,
  );
  assert.throws(() => evaluateBypassResponse(null, STARTER), /readBypassState result/);
  const empty = evaluateBypassResponse(state({}), STARTER);
  assert.equal(empty.recommendReview, false);
  assert.equal(empty.recommendStop, false);
  assert.deepEqual(empty.responses, {});
});

test('recorded signals flow into the evaluator unchanged', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-bypass-eval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  const digest = 'c'.repeat(64);
  recordBypassSignal(graph, {
    kind: 'refused-retry', workspaceId: 'workspace-a', agentId: 'agent-1',
    fingerprint: digest, at: '2026-01-01T00:01:00.000Z',
  });
  recordBypassSignal(graph, {
    kind: 'refused-retry', workspaceId: 'workspace-a', agentId: 'agent-1',
    fingerprint: digest, at: '2026-01-01T00:02:00.000Z',
  });
  const stored = readBypassState(graph, {
    workspaceId: 'workspace-a', agentId: 'agent-1', at: '2026-01-01T00:10:00.000Z',
  });
  const result = evaluateBypassResponse(stored, STARTER);
  assert.equal(result.responses[digest].response, 'review');
  assert.equal(result.responses[digest].count, 2);
});
