'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Graph = require('../graph');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-durable-journal-'));

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

function makeGraph(name, backend) {
  return new Graph({
    memoryPath: path.join(root, `${name}-${backend}.json`),
    dbPath: path.join(root, `${name}-${backend}.db`),
    useSQLite: backend === 'sqlite',
  });
}

// #216: the JSON backend now provides the SAME durable-journal contract as
// SQLite (idempotent replay, rollback-on-error, hash-chained receipts) --
// run the whole scenario set against both backends to prove parity, rather
// than duplicating the assertions in a separate file.
for (const backend of ['sqlite', 'json']) {
  test(`[${backend}] durable journal commits graph mutation, audit and result once`, () => {
    const graph = makeGraph('once', backend);
    let calls = 0;
    const mutate = () => {
      calls += 1;
      graph.addNode('cat', 'Cat', null, { workspaceId: 'w' });
      graph.addNode('animal', 'Animal', null, { workspaceId: 'w' });
      graph.addEdge('cat', 'animal', 'is_a', { workspaceId: 'w' });
      graph.appendAuditEvent({ eventType: 'LEARN', targetType: 'edge', targetId: 'cat|is_a|animal' }, { workspaceId: 'w' });
      return { learned: 1, evidence: ['cat|is_a|animal'] };
    };

    const first = graph.runMutationOnce('approval-1', mutate);
    const second = graph.runMutationOnce('approval-1', mutate);

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.result, first.result);
    assert.equal(calls, 1);
    assert.equal(Object.keys(graph.getNodes('w')).length, 2);
    assert.equal(graph.getEdges('cat', 'w').length, 1);
    assert.equal(graph.getAuditEvents({ workspaceId: 'w' }).length, 1);

    const reloaded = makeGraph('once', backend);
    reloaded.load();
    const replayAfterRestart = reloaded.runMutationOnce('approval-1', () => {
      throw new Error('must not execute after restart');
    });
    assert.equal(replayAfterRestart.replayed, true);
    assert.deepEqual(replayAfterRestart.result, first.result);
  });

  test(`[${backend}] durable journal restores in-memory state when callback rolls back`, () => {
    const graph = makeGraph('rollback', backend);
    assert.throws(() => graph.runMutationOnce('approval-rollback', () => {
      graph.addNode('phantom', 'Phantom', null, { workspaceId: 'w' });
      graph.appendAuditEvent({ eventType: 'LEARN', targetType: 'node', targetId: 'phantom' }, { workspaceId: 'w' });
      throw new Error('forced failure');
    }), /forced failure/);

    assert.equal(graph.getNode('phantom', 'w'), null);
    assert.equal(graph.getAuditEvents({ workspaceId: 'w' }).length, 0);
    const retry = graph.runMutationOnce('approval-rollback', () => ({ learned: 0 }));
    assert.equal(retry.replayed, false);
  });

  test(`[${backend}] durable journal persists one hash-chained canonical receipt with the operation`, () => {
    const graph = makeGraph('receipt', backend);
    const makePayload = (receiptId) => buildCanonicalReceiptPayload({
      receiptId,
      receiptKind: 'memory_admission_receipt',
      decision: 'allow',
      status: 'admitted',
      admissionId: `admission-${receiptId}`,
      workspaceId: 'w',
      provenanceId: `prov-${receiptId}`,
      trustPolicyVersion: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
    }, { verdict: 'allow' });

    const first = graph.runMutationOnce('receipt-operation-1', () => ({ learned: 1 }), {
      buildCanonicalReceipt: () => makePayload('receipt-1'),
    });
    const second = graph.runMutationOnce('receipt-operation-2', () => ({ learned: 1 }), {
      buildCanonicalReceipt: () => makePayload('receipt-2'),
    });
    const replay = graph.runMutationOnce('receipt-operation-1', () => {
      throw new Error('must not replay mutation');
    }, { buildCanonicalReceipt: () => makePayload('receipt-1') });

    assert.equal(first.receipt.receiptId, 'receipt-1');
    assert.equal(second.receipt.previousReceiptHash, first.receipt.receiptHash);
    assert.equal(replay.replayed, true);
    assert.equal(replay.receipt.receiptHash, first.receipt.receiptHash);
    assert.deepEqual(graph.getCommittedMutationReceiptById('receipt-2'), second.receipt);
  });

}

// JSON-only: SQLite's durability comes from its own DB transaction (no
// separate save() call inside runMutationOnce), so this scenario -- a
// failure of the *persistence* step specifically, after mutate() already
// ran in-memory -- only applies to the JSON backend's two-step
// (save-then-mark-journal) design.
test('[json] durable journal never marks an operation completed if save() fails (no phantom completion)', () => {
  const graph = makeGraph('save-fail', 'json');
  const originalSave = graph.save.bind(graph);
  graph.save = () => { throw new Error('simulated disk failure'); };
  let threw = null;
  try {
    graph.runMutationOnce('op-save-fail', () => {
      graph.addNode('fish', 'Fish', null, { workspaceId: 'w' });
      return { learned: 1 };
    });
  } catch (error) {
    threw = error;
  } finally {
    graph.save = originalSave;
  }
  assert.ok(threw, 'save() failure must propagate, not be swallowed');
  assert.equal(graph.getNode('fish', 'w'), null, 'rolled back in-memory state');

  // Retry with the same operationId must re-run the mutation (not replay
  // a phantom "completed" result for data that was never persisted).
  let reran = false;
  const retry = graph.runMutationOnce('op-save-fail', () => {
    reran = true;
    graph.addNode('fish', 'Fish', null, { workspaceId: 'w' });
    return { learned: 1, retried: true };
  });
  assert.equal(reran, true);
  assert.equal(retry.replayed, false);
  assert.ok(graph.getNode('fish', 'w'));
});

// #216: the JSON backend previously had no durable journal at all and
// failed closed. It now provides the same contract as SQLite (proven by the
// parameterized tests above) -- this test locks in that the JSON backend no
// longer throws DURABLE_MUTATION_JOURNAL_UNAVAILABLE.
test('[json] durable journal no longer fails closed (JSON backend parity, #216)', () => {
  const graph = new Graph({ memoryPath: path.join(root, 'json-parity.json'), useSQLite: false });
  const result = graph.runMutationOnce('approval-json', () => ({ learned: 1 }));
  assert.equal(result.replayed, false);
  assert.deepEqual(result.result, { learned: 1 });
});
