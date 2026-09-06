'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const {
  SANDBOX_ESCAPE_OPERATION_PREFIX,
  isEscapeVerdict,
  recordSandboxVerdict,
  readSandboxEscapes,
} = require('../lib/sandbox-escape-ledger');

function makeTempGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-sandbox-escape-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  return { graph, dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('an allow verdict is not an escape and is not recorded', () => {
  assert.equal(isEscapeVerdict({ decision: 'allow', reason: 'SOURCE_VALIDATED_ALLOW' }), false);
});

test('quarantine and block verdicts are escapes', () => {
  assert.equal(isEscapeVerdict({ decision: 'quarantine', reason: 'EXTERNAL_NETWORK_QUARANTINE' }), true);
  assert.equal(isEscapeVerdict({ decision: 'block', reason: 'UNTRUSTED_SOURCE_BLOCK' }), true);
});

test('a malformed verdict is not treated as an escape', () => {
  assert.equal(isEscapeVerdict(null), false);
  assert.equal(isEscapeVerdict({}), false);
  assert.equal(isEscapeVerdict({ decision: 'nonsense' }), false);
});

test('recording an escape makes it readable back under the sandbox prefix', () => {
  const { graph, dir } = makeTempGraph();
  try {
    const recorded = recordSandboxVerdict({
      graph,
      verdict: { decision: 'quarantine', reason: 'EXTERNAL_NETWORK_QUARANTINE' },
      workspaceId: 'workspace-a',
      sourceRef: 'self-healer:source-dogfood',
    });

    assert.ok(recorded, 'an escape must produce a receipt');

    const escapes = readSandboxEscapes(graph);
    assert.equal(escapes.length, 1);
    assert.equal(escapes[0].decision, 'quarantine');
    assert.equal(escapes[0].reason, 'EXTERNAL_NETWORK_QUARANTINE');
    assert.equal(escapes[0].workspaceId, 'workspace-a');
  } finally {
    cleanup(dir);
  }
});

test('an allow verdict writes nothing, so the trail is escapes only', () => {
  const { graph, dir } = makeTempGraph();
  try {
    const recorded = recordSandboxVerdict({
      graph,
      verdict: { decision: 'allow', reason: 'SOURCE_VALIDATED_ALLOW' },
      workspaceId: 'workspace-a',
    });

    assert.equal(recorded, null);
    assert.deepEqual(readSandboxEscapes(graph), []);
  } finally {
    cleanup(dir);
  }
});

test('every recorded operationId carries the sandbox prefix', () => {
  const { graph, dir } = makeTempGraph();
  try {
    recordSandboxVerdict({
      graph,
      verdict: { decision: 'block', reason: 'UNTRUSTED_SOURCE_BLOCK' },
      workspaceId: 'workspace-a',
    });

    const escapes = readSandboxEscapes(graph);
    assert.ok(escapes[0].operationId.startsWith(SANDBOX_ESCAPE_OPERATION_PREFIX));
  } finally {
    cleanup(dir);
  }
});

test('separate escapes accumulate rather than overwriting each other', () => {
  const { graph, dir } = makeTempGraph();
  try {
    recordSandboxVerdict({ graph, verdict: { decision: 'quarantine', reason: 'EXTERNAL_NETWORK_QUARANTINE' } });
    recordSandboxVerdict({ graph, verdict: { decision: 'block', reason: 'TIMEOUT_EXCEEDED_BLOCK' } });

    const escapes = readSandboxEscapes(graph);
    assert.equal(escapes.length, 2);
    assert.deepEqual(escapes.map((entry) => entry.reason).sort(), [
      'EXTERNAL_NETWORK_QUARANTINE',
      'TIMEOUT_EXCEEDED_BLOCK',
    ]);
  } finally {
    cleanup(dir);
  }
});

test('recording without a graph is a no-op, never a throw', () => {
  assert.equal(
    recordSandboxVerdict({ verdict: { decision: 'block', reason: 'UNTRUSTED_SOURCE_BLOCK' } }),
    null,
  );
});

test('a graph that fails mid-write does not propagate the failure to the caller', () => {
  // Recording is observation. A sandbox execution must not start failing
  // because the evidence store had a bad day.
  const brokenGraph = {
    runMutationOnce() { throw new Error('disk on fire'); },
    getCommittedMutationReceiptByOperation() { return null; },
    getCommittedMutationReceiptById() { return null; },
    getCommittedMutationResultsByPrefix() { return []; },
  };

  assert.doesNotThrow(() => {
    recordSandboxVerdict({
      graph: brokenGraph,
      verdict: { decision: 'block', reason: 'UNTRUSTED_SOURCE_BLOCK' },
    });
  });
});

test('reading from a graph without the read API returns empty rather than throwing', () => {
  assert.deepEqual(readSandboxEscapes(null), []);
  assert.deepEqual(readSandboxEscapes({}), []);
});
