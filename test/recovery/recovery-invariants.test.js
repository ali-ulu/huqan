'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const Graph = require('../../graph');
const RustGraph = require('../../rustGraph');
const { applyStorageSchema } = require('../../lib/storage/schema');
const { buildCanonicalReceiptPayload } = require('../../lib/receipt/canonical-receipt');
const { createTrustEvidenceLedger } = require('../../lib/trust-evidence-ledger');
const {
  createHumanOversightApprovalRuntime,
  RUNTIME_REASONS,
} = require('../../lib/human-oversight-approval-runtime');
const { emitGateTelemetry } = require('../../lib/gate-telemetry');
const {
  assertJournalConsistent,
  assertRecoveryInvariants,
  assertRollback,
  snapshotGraph,
} = require('./recovery-invariants');

function fixture(prefix = 'huqan-recovery-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const memoryPath = path.join(root, 'memory.json');
  const graph = new Graph({ memoryPath, useSQLite: false, noLoad: true });
  return {
    root,
    memoryPath,
    journalPath: memoryPath.replace(/\.json$/, '.mutations.json'),
    graph,
  };
}

function cleanup(root, graph) {
  try { graph?.close?.(); } catch (_) {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

function receiptFor(operationId, workspaceId = 'default') {
  return buildCanonicalReceiptPayload({
    receiptId: `receipt-${operationId}`,
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `admission-${operationId}`,
    workspaceId,
    provenanceId: `prov-${operationId}`,
    trustPolicyVersion: 'recovery-test',
    createdAt: '2026-09-21T00:00:00.000Z',
  }, { verdict: 'allow' });
}

function commitBaseline(graph, operationId = 'baseline') {
  return graph.runMutationOnce(operationId, () => {
    graph.addNode('baseline-a', 'baseline A');
    graph.addNode('baseline-b', 'baseline B');
    graph.addEdge('baseline-a', 'baseline-b', 'supports');
    return { applied: true };
  }, { buildCanonicalReceipt: () => receiptFor(operationId) });
}

function runtimeFixture(graph) {
  const ledger = createTrustEvidenceLedger({ graph });
  const clockState = { now: Date.parse('2026-09-21T10:00:00.000Z') };
  const resolveIdentity = ({ role, context, action }) => ({
    decision: 'allow',
    identity: {
      identityRef: context?.identityRef || (role === 'requester' ? 'agent:worker-a' : 'human:operator-a'),
      identityHash: context?.identityHash || (role === 'requester' ? 'hash-worker-a' : 'hash-operator-a'),
      workspaceId: action.workspaceId,
      agentId: role === 'requester' ? 'agent-a' : '',
      ownerActorId: role === 'requester' ? 'owner-a' : context?.identityRef || 'operator-a',
      authorityRef: 'authority:workspace-a',
    },
  });
  const createRuntime = () => createHumanOversightApprovalRuntime({
    graph,
    ledger,
    resolveIdentity,
    firewallEvaluator: () => ({
      decision: 'allow',
      metadata: { firewallVersion: 'agent-action-firewall-v1' },
    }),
    clock: () => clockState.now,
  });
  return { ledger, createRuntime };
}

function governedAction(overrides = {}) {
  return {
    workspaceId: 'workspace-a',
    actionFingerprint: 'action:recovery:001',
    connectorRef: 'connector:test',
    resourceRef: 'resource:test',
    policyVersion: 'policy-v1',
    firewallVersion: 'agent-action-firewall-v1',
    requestedVerdict: 'review',
    requestedEffect: 'one bounded recovery-test mutation',
    actionType: 'test_mutation',
    toolName: 'huqan.test.mutate',
    target: 'recovery-fixture',
    agentId: 'agent-a',
    evidenceRefs: ['evidence:recovery'],
    provenanceRefs: ['provenance:recovery'],
    ...overrides,
  };
}

function runProcess(args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('recovery child timed out'));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

test('T5/T4 SQLite crash mid-transaction rolls back state and journal atomically', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process-kill semantics are required');
  try {
    require.resolve('better-sqlite3');
  } catch (_) {
    return t.skip('better-sqlite3 is unavailable');
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-recovery-sqlite-crash-'));
  const dbPath = path.join(root, 'memory.db');
  const memoryPath = path.join(root, 'memory.json');
  const prime = new Graph({ memoryPath, dbPath, useSQLite: true });
  prime.runMutationOnce('sqlite-baseline', () => {
    prime.addNode('baseline-survives', 'committed before crash', null, { workspaceId: 'w' });
    return { applied: true };
  }, { buildCanonicalReceipt: () => receiptFor('sqlite-baseline', 'w') });
  prime.close();

  const script = `
    const Graph = require(process.argv[1]);
    const graph = new Graph({ memoryPath: process.argv[2], dbPath: process.argv[3], useSQLite: true });
    graph.runMutationOnce('sqlite-crash', () => {
      graph.addNode('must-roll-back', 'mid transaction crash', null, { workspaceId: 'w' });
      process.kill(process.pid, 'SIGKILL');
      return { applied: true };
    });
  `;

  try {
    const result = await runProcess(['-e', script, path.join(__dirname, '..', '..', 'graph.js'), memoryPath, dbPath]);
    assert.equal(result.signal, 'SIGKILL');
    const recovered = new Graph({ memoryPath, dbPath, useSQLite: true });
    recovered.load();
    try {
      assert.ok(recovered.getNode('baseline-survives', 'w'), 'pre-fault committed state must survive');
      assert.equal(recovered.getNode('must-roll-back', 'w'), null);
      assert.equal(recovered.getCommittedMutationReceiptByOperation('sqlite-crash'), null);
      assertRecoveryInvariants({ graph: recovered, workspaceId: 'w' });
    } finally {
      recovered.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T5/T4 receipt append failure leaves no mutation, receipt, or journal completion', () => {
  const { root, graph, journalPath } = fixture('huqan-recovery-receipt-');
  try {
    commitBaseline(graph);
    const before = snapshotGraph(graph);

    assert.throws(() => graph.runMutationOnce('receipt-failure', () => {
      graph.addNode('must-roll-back', 'receipt append failed');
      return { applied: true };
    }, {
      buildCanonicalReceipt: () => {
        const error = new Error('ENOSPC: receipt append');
        error.code = 'ENOSPC';
        throw error;
      },
    }), /ENOSPC/);

    const after = assertRecoveryInvariants({ graph, journalPath, before });
    assertRollback(before, after);
    assert.equal(graph.getNode('must-roll-back'), null);
    assert.equal(assertJournalConsistent(journalPath).operations['receipt-failure'], undefined);
  } finally {
    cleanup(root, graph);
  }
});

test('T5/T4 approval survives runtime restart and cannot be bypassed before approval', async () => {
  const { root, graph, journalPath } = fixture('huqan-recovery-approval-');
  try {
    const { createRuntime } = runtimeFixture(graph);
    const action = governedAction();
    const runtime = createRuntime();
    const created = runtime.createReviewCase({
      action,
      firewallDecision: 'review',
      requesterContext: {},
    });
    assert.equal(created.ok, true);

    let executions = 0;
    const denied = await runtime.executeApproved({
      caseId: created.case.caseId,
      action,
      requesterContext: {},
      executor: () => {
        executions += 1;
        graph.addNode('bypass-node', 'must never be admitted');
        return { ok: true };
      },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, RUNTIME_REASONS.APPROVAL_REQUIRED);
    assert.equal(executions, 0);
    assert.equal(graph.getNode('bypass-node'), null);

    const approved = runtime.decide({
      caseId: created.case.caseId,
      decisionType: 'approve',
      approverContext: { identityRef: 'human:operator-a', identityHash: 'hash-operator-a' },
      reason: 'operator reviewed bounded recovery action',
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.equal(approved.ok, true);

    const restarted = createRuntime();
    const admitted = await restarted.executeApproved({
      caseId: created.case.caseId,
      action,
      requesterContext: {},
      executor: () => {
        executions += 1;
        graph.addNode('approved-node', 'approved mutation');
        return { ok: true };
      },
    });
    assert.equal(admitted.ok, true);
    assert.equal(executions, 1);
    assert.ok(graph.getNode('approved-node'));
    assertRecoveryInvariants({ graph, journalPath, workspaceId: 'workspace-a' });
    assertJournalConsistent(journalPath);
  } finally {
    cleanup(root, graph);
  }
});

test('T5/T4 Rust accelerator process loss rejects in-flight work without touching durable graph state', async () => {
  const { root, graph, journalPath, memoryPath } = fixture('huqan-recovery-rust-');
  try {
    commitBaseline(graph);
    const before = snapshotGraph(graph);

    const rust = new RustGraph({ memoryPath, requestTimeoutMs: 100 });
    const noop = () => {};
    rust._proc = {
      ref: noop,
      unref: noop,
      stdin: { ref: noop, unref: noop, write: noop },
      stdout: { ref: noop, unref: noop },
      stderr: { unref: noop },
    };

    const pending = rust.send({ cmd: 'add_node', id: 'accelerator-only' });
    rust._proc = null;
    rust._rejectAll('process_exited');
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, 'process_exited');

    const after = assertRecoveryInvariants({ graph, journalPath, before });
    assertRollback(before, after);
  } finally {
    cleanup(root, graph);
  }
});

test('T5/T4 corrupt SQLite database fails closed without damaging pre-fault JSON state', (t) => {
  try {
    require.resolve('better-sqlite3');
  } catch (_) {
    return t.skip('better-sqlite3 is unavailable');
  }

  const { root, graph, journalPath } = fixture('huqan-recovery-corrupt-db-');
  try {
    commitBaseline(graph);
    const before = snapshotGraph(graph);
    const dbPath = path.join(root, 'corrupt.db');
    fs.writeFileSync(dbPath, 'not a sqlite database');

    assert.throws(
      () => new Graph({ memoryPath: path.join(root, 'sqlite-memory.json'), dbPath, useSQLite: true }),
      (error) => error?.code === 'SQLITE_PERSISTENCE_INIT_FAILED',
    );

    const after = assertRecoveryInvariants({ graph, journalPath, before });
    assertRollback(before, after);
  } finally {
    cleanup(root, graph);
  }
});

test('T5/T4 invalid migration rolls back the entire migration unit', () => {
  const executed = [];
  const db = {
    executed,
    exec(sql) {
      const text = String(sql).trim();
      if (/UPDATE agent_runs SET iterations_delta/.test(text)) throw new Error('simulated migration failure');
      executed.push(text);
    },
    prepare(sql) {
      const match = /PRAGMA table_info\((\w+)\)/.exec(sql);
      return { all: () => (match ? [] : []) };
    },
  };
  db.transaction = (work) => () => {
    const mark = executed.length;
    try {
      work();
    } catch (error) {
      executed.length = mark;
      throw error;
    }
  };

  assert.throws(() => applyStorageSchema(db), /simulated migration failure/);
  assert.equal(executed.some((sql) => /ALTER TABLE/i.test(sql)), false);
  assert.equal(executed.some((sql) => /CREATE INDEX/i.test(sql)), false);
});

test('T5/T4 network disconnect records unknown outcome and prevents silent success', async () => {
  const { root, graph, journalPath } = fixture('huqan-recovery-network-');
  try {
    const { createRuntime } = runtimeFixture(graph);
    const runtime = createRuntime();
    const action = governedAction({ actionFingerprint: 'action:network:001' });
    const created = runtime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
    const approved = runtime.decide({
      caseId: created.case.caseId,
      decisionType: 'approve',
      approverContext: { identityRef: 'human:operator-a', identityHash: 'hash-operator-a' },
      reason: 'operator approved bounded network action',
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.equal(approved.ok, true);

    let calls = 0;
    const result = await runtime.executeApproved({
      caseId: created.case.caseId,
      action,
      requesterContext: {},
      executor: () => {
        calls += 1;
        const error = new Error('connection reset');
        error.code = 'ECONNRESET';
        throw error;
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.reason, RUNTIME_REASONS.EXECUTION_RECONCILIATION_REQUIRED);
    assert.equal(runtime.getReviewCase(created.case.caseId).case.status, 'reconciliation_required');
    assertJournalConsistent(journalPath);
  } finally {
    cleanup(root, graph);
  }
});

test('T5/T4 partial JSON write fault rolls back and preserves all pre-fault graph data', () => {
  const { root, graph, journalPath } = fixture('huqan-recovery-partial-');
  try {
    commitBaseline(graph);
    const before = snapshotGraph(graph);
    graph._jsonTransactionFault = (point) => {
      if (point === 'before-prepared') throw new Error('partial write interrupted');
    };

    assert.throws(() => graph.runMutationOnce('partial-write', () => {
      graph.addNode('partial-node', 'must roll back');
      return { applied: true };
    }, { buildCanonicalReceipt: () => receiptFor('partial-write') }), /partial write interrupted/);

    graph._jsonTransactionFault = null;
    const after = assertRecoveryInvariants({ graph, journalPath, before });
    assertRollback(before, after);
    assert.equal(graph.getNode('partial-node'), null);
    assert.equal(assertJournalConsistent(journalPath).operations['partial-write'], undefined);
  } finally {
    cleanup(root, graph);
  }
});

test('T5 receipt-chain tampering is detected instead of being accepted silently', () => {
  const { root, graph, journalPath } = fixture('huqan-recovery-tamper-');
  try {
    commitBaseline(graph);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const operationId = Object.keys(journal.receipts)[0];
    journal.receipts[operationId].canonicalPayload.provenanceId = 'tampered';
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));

    assert.throws(
      () => assertJournalConsistent(journalPath),
      /receipt content tampered/,
    );
  } finally {
    cleanup(root, graph);
  }
});

test('T5 gate telemetry and trust evidence remain observable around a failed effect', () => {
  const { root, graph, journalPath } = fixture('huqan-recovery-audit-');
  try {
    const events = [];
    const kernel = {
      plugins: {
        emit(name, event) {
          events.push({ name, event });
        },
      },
    };
    emitGateTelemetry(kernel, 'recovery-test', {
      decision: 'block',
      reason: 'fault injected',
      metadata: { workspaceId: 'default', tool: 'huqan.test' },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'afterGateDecision');
    assert.equal(events[0].event.decision, 'block');

    const ledger = createTrustEvidenceLedger({ graph });
    const written = ledger.append({
      operationId: 'trust-evidence:recovery-fault',
      event: {
        workspaceId: 'default',
        decision: 'block',
        reason: 'fault injected',
        actionFingerprint: 'action:fault',
        policyVersion: 'recovery-test',
        createdAt: '2026-09-21T00:00:00.000Z',
        metadata: { eventType: 'recovery_fault_observed' },
      },
      mutate: () => ({ recorded: true }),
    });
    assert.equal(written.verification.valid, true);
    assert.equal(ledger.readByOperation('trust-evidence:recovery-fault').verification.valid, true);
    assertJournalConsistent(journalPath);
  } finally {
    cleanup(root, graph);
  }
});
