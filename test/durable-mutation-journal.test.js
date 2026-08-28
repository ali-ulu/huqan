'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, test } = require('node:test');

const Graph = require('../graph');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { GENESIS_PREVIOUS_HASH } = require('../lib/receipt/receipt-chain');
const { LOCK_WAIT_MS, isReclaimableLock, lockPathFor, withMutationJournalLock } = require('../lib/mutation-journal-lock');

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

function journalStatus(journalPath, operationId) {
  if (!fs.existsSync(journalPath)) return null;
  const operation = readMutationJournal(journalPath).operations[operationId];
  return operation ? operation.status : null;
}

function runConcurrentJournalWorker(memoryPath, barrierPath, operationId, tag) {
  const script = `
    const fs = require('node:fs');
    const Graph = require(process.argv[1]);
    const memoryPath = process.argv[2];
    const barrierPath = process.argv[3];
    const operationId = process.argv[4];
    const tag = process.argv[5];
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(barrierPath)) Atomics.wait(sleeper, 0, 0, 5);
    const graph = new Graph({ memoryPath, useSQLite: false });
    const outcome = graph.runMutationOnce(operationId, () => {
      Atomics.wait(sleeper, 0, 0, 150);
      return { tag };
    });
    process.stdout.write(JSON.stringify(outcome));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, path.join(__dirname, '..', 'graph.js'), memoryPath, barrierPath, operationId, tag], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', status => status === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `worker exited ${status}`)));
  });
}

function runProcess(args, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      reject(new Error(`child process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function runJsonCrashWorker(memoryPath, journalWriteMarkerPath, operationId) {
  const script = `
    const fs = require('node:fs');
    const Graph = require(process.argv[1]);
    const memoryPath = process.argv[2];
    const journalWriteMarkerPath = process.argv[3];
    const operationId = process.argv[4];
    const graph = new Graph({ memoryPath, useSQLite: false });
    graph._writeJsonJournal = () => {
      fs.writeFileSync(journalWriteMarkerPath, 'graph-save-complete');
      process.kill(process.pid, 'SIGKILL');
    };
    graph.runMutationOnce(operationId, () => {
      graph.addNode('crashed-node', 'persisted before journal crash');
      return { applied: true };
    });
  `;
  return runProcess(['-e', script, path.join(__dirname, '..', 'graph.js'), memoryPath, journalWriteMarkerPath, operationId]);
}

function runJsonRetryWorker(memoryPath, operationId) {
  const script = `
    const Graph = require(process.argv[1]);
    const memoryPath = process.argv[2];
    const operationId = process.argv[3];
    const graph = new Graph({ memoryPath, useSQLite: false });
    let applications = 0;
    try {
      const outcome = graph.runMutationOnce(operationId, () => {
        applications += 1;
        graph.addNode('retry-node', 'must not execute after stale-lock refusal');
        return { applied: true };
      });
      process.stdout.write(JSON.stringify({ ok: true, outcome, applications }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message, applications }));
    }
  `;
  return runProcess(['-e', script, path.join(__dirname, '..', 'graph.js'), memoryPath, operationId]);
}

function primeSqliteDatabase(dbPath) {
  const graph = new Graph({
    memoryPath: path.join(path.dirname(dbPath), 'sqlite-prime-memory.json'),
    dbPath,
    useSQLite: true,
    busyTimeoutMs: 5_000,
  });
  graph.close();
}

function runSqliteWorker(dbPath, barrierPath, operationId, tag, options = {}) {
  const markerPath = options.markerPath || '';
  const crashAfterMarker = options.crashAfterMarker ? '1' : '0';
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const Graph = require(process.argv[1]);
    const { buildCanonicalReceiptPayload } = require(process.argv[2]);
    const dbPath = process.argv[3];
    const barrierPath = process.argv[4];
    const operationId = process.argv[5];
    const tag = process.argv[6];
    const markerPath = process.argv[7];
    const crashAfterMarker = process.argv[8] === '1';
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    if (barrierPath) while (!fs.existsSync(barrierPath)) Atomics.wait(sleeper, 0, 0, 5);
    const graph = new Graph({
      memoryPath: path.join(path.dirname(dbPath), 'sqlite-worker-memory.json'),
      dbPath,
      useSQLite: true,
      busyTimeoutMs: 5_000,
    });
    let applications = 0;
    const outcome = graph.runMutationOnce(operationId, () => {
      applications += 1;
      graph.addNode('node-' + tag, 'worker ' + tag, null, { workspaceId: 'w' });
      if (markerPath) {
        fs.writeFileSync(markerPath, 'mutation-open');
        if (crashAfterMarker) process.kill(process.pid, 'SIGKILL');
      }
      return { tag };
    }, {
      buildCanonicalReceipt: () => buildCanonicalReceiptPayload({
        receiptId: 'receipt-' + operationId,
        receiptKind: 'memory_admission_receipt',
        decision: 'allow',
        status: 'admitted',
        admissionId: 'admission-' + operationId,
        workspaceId: 'w',
        provenanceId: 'prov-' + operationId,
        trustPolicyVersion: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
      }, { verdict: 'allow' }),
    });
    graph.close?.();
    process.stdout.write(JSON.stringify({ outcome, applications }));
  `;
  return runProcess([
    '-e',
    script,
    path.join(__dirname, '..', 'graph.js'),
    path.join(__dirname, '..', 'lib', 'receipt', 'canonical-receipt.js'),
    dbPath,
    barrierPath || '',
    operationId,
    tag,
    markerPath,
    crashAfterMarker,
  ]);
}

test('[json] durable journal serializes the same operation across processes', async () => {
  const memoryPath = path.join(root, 'multi-process.json');
  const barrierPath = path.join(root, 'multi-process.ready');
  const workers = [
    runConcurrentJournalWorker(memoryPath, barrierPath, 'shared-operation', 'a'),
    runConcurrentJournalWorker(memoryPath, barrierPath, 'shared-operation', 'b'),
  ];
  fs.writeFileSync(barrierPath, 'ready');
  const outcomes = await Promise.all(workers);
  const fresh = new Graph({ memoryPath, useSQLite: false });
  const journal = fresh._readJsonJournal();

  assert.equal(outcomes.filter(outcome => outcome.replayed === false).length, 1);
  assert.equal(outcomes.filter(outcome => outcome.replayed === true).length, 1);
  assert.deepEqual(Object.keys(journal.operations), ['shared-operation']);
  assert.equal(fs.existsSync(`${memoryPath}.mutations.json.lock`), false);
});

test('[json] durable journal retains concurrent distinct operations across processes', async () => {
  const memoryPath = path.join(root, 'multi-process-distinct.json');
  const barrierPath = path.join(root, 'multi-process-distinct.ready');
  const workers = [
    runConcurrentJournalWorker(memoryPath, barrierPath, 'operation-a', 'a'),
    runConcurrentJournalWorker(memoryPath, barrierPath, 'operation-b', 'b'),
  ];
  fs.writeFileSync(barrierPath, 'ready');
  const outcomes = await Promise.all(workers);
  const fresh = new Graph({ memoryPath, useSQLite: false });
  const journal = fresh._readJsonJournal();

  assert.deepEqual(outcomes.map(outcome => outcome.replayed), [false, false]);
  assert.deepEqual(Object.keys(journal.operations).sort(), ['operation-a', 'operation-b']);
});

test('[json] durable journal fails closed for a stale lock left by a dead process', () => {
  const journalPath = path.join(root, 'stale-lock.mutations.json');
  const lockPath = lockPathFor(journalPath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, token: 'dead', acquiredAt: '2026-01-01T00:00:00.000Z' }));
  const stale = new Date(Date.now() - (6 * 60 * 1000));
  fs.utimesSync(lockPath, stale, stale);

  let ran = false;
  assert.throws(
    () => withMutationJournalLock(journalPath, () => { ran = true; }),
    error => error?.code === 'MUTATION_JOURNAL_STALE_LOCK',
  );

  assert.equal(ran, false);
  assert.equal(fs.existsSync(lockPath), true);
});

test('[json] a dead owner is refused immediately, without waiting out the lock timeout', () => {
  // The refusal verdict is deliberate (see the test above). What must not
  // happen is reaching it slowly: a crash used to cost every later mutation a
  // full LOCK_WAIT_MS block, and then reported LOCK_TIMEOUT -- a contention
  // code -- even though the owning pid was already provably gone.
  const journalPath = path.join(root, 'fresh-dead-lock.mutations.json');
  const lockPath = lockPathFor(journalPath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, token: 'dead', acquiredAt: new Date().toISOString() }));

  let ran = false;
  const startedAt = Date.now();
  assert.throws(
    () => withMutationJournalLock(journalPath, () => { ran = true; }),
    error => error?.code === 'MUTATION_JOURNAL_STALE_LOCK',
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(ran, false);
  assert.equal(fs.existsSync(lockPath), true);
  assert.ok(elapsedMs < LOCK_WAIT_MS / 2, `refusal took ${elapsedMs}ms, expected well under ${LOCK_WAIT_MS}ms`);
});

test('[json] a half-written lock from a live writer is not mistaken for a dead owner', () => {
  // Between openSync(wx) and the pid write, the lock file exists but is empty.
  // Liveness cannot be judged there, so the age gate must still apply -- other-
  // wise the fast path above would evict a healthy concurrent writer.
  const journalPath = path.join(root, 'half-written-lock.mutations.json');
  const lockPath = lockPathFor(journalPath);
  fs.writeFileSync(lockPath, '');

  assert.equal(isReclaimableLock(journalPath), false);

  const stale = new Date(Date.now() - (6 * 60 * 1000));
  fs.utimesSync(lockPath, stale, stale);
  assert.equal(isReclaimableLock(journalPath), true, 'the age gate still reclaims an abandoned unreadable lock');
});

test('[sqlite] two real processes keep one canonical result and receipt for the same operation', async () => {
  const dbPath = path.join(root, 'sqlite-same-operation.db');
  const barrierPath = path.join(root, 'sqlite-same-operation.ready');
  primeSqliteDatabase(dbPath);
  const workers = [
    runSqliteWorker(dbPath, barrierPath, 'shared-sqlite-operation', 'a'),
    runSqliteWorker(dbPath, barrierPath, 'shared-sqlite-operation', 'b'),
  ];
  fs.writeFileSync(barrierPath, 'ready');
  const results = await Promise.all(workers);
  const outputs = results.map((result) => {
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  const graph = new Graph({ dbPath, memoryPath: path.join(root, 'sqlite-same-operation.json'), useSQLite: true });
  const journal = graph._db.prepare('SELECT status, result FROM mutation_journal WHERE operation_id = ?').get('shared-sqlite-operation');
  const receiptCount = graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts WHERE operation_id = ?').get('shared-sqlite-operation').count;
  const nodeCount = graph._db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE workspace_id = ?').get('w').count;

  assert.equal(outputs.filter(({ outcome }) => outcome.replayed === false).length, 1);
  assert.equal(outputs.filter(({ outcome }) => outcome.replayed === true).length, 1);
  assert.equal(outputs.reduce((count, { applications }) => count + applications, 0), 1);
  assert.equal(journal.status, 'completed');
  assert.equal(JSON.parse(journal.result).tag === 'a' || JSON.parse(journal.result).tag === 'b', true);
  assert.equal(receiptCount, 1);
  assert.equal(nodeCount, 1);
  graph.close();
});

test('[sqlite] two real processes retain distinct operations and a chained receipt sequence', async () => {
  const dbPath = path.join(root, 'sqlite-distinct-operations.db');
  const barrierPath = path.join(root, 'sqlite-distinct-operations.ready');
  primeSqliteDatabase(dbPath);
  const workers = [
    runSqliteWorker(dbPath, barrierPath, 'sqlite-operation-a', 'a'),
    runSqliteWorker(dbPath, barrierPath, 'sqlite-operation-b', 'b'),
  ];
  fs.writeFileSync(barrierPath, 'ready');
  const results = await Promise.all(workers);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const graph = new Graph({ dbPath, memoryPath: path.join(root, 'sqlite-distinct-operations.json'), useSQLite: true });
  const journalCount = graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_journal').get().count;
  const receiptRows = graph._db.prepare('SELECT operation_id, previous_receipt_hash FROM mutation_receipts ORDER BY committed_at, operation_id').all();
  const nodeCount = graph._db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE workspace_id = ?').get('w').count;

  assert.equal(journalCount, 2);
  assert.deepEqual(receiptRows.map((row) => row.operation_id).sort(), ['sqlite-operation-a', 'sqlite-operation-b']);
  assert.equal(receiptRows.filter((row) => row.previous_receipt_hash === GENESIS_PREVIOUS_HASH).length, 1);
  assert.equal(receiptRows.filter((row) => row.previous_receipt_hash !== GENESIS_PREVIOUS_HASH).length, 1);
  assert.equal(nodeCount, 2);
  graph.close();
});

test('[sqlite] a real process killed inside a transaction can be restarted without a duplicate', async () => {
  const dbPath = path.join(root, 'sqlite-transaction-crash.db');
  const markerPath = path.join(root, 'sqlite-transaction-crash.marker');
  const operationId = 'sqlite-transaction-crash';
  primeSqliteDatabase(dbPath);
  const crashed = await runSqliteWorker(dbPath, '', operationId, 'crashed', { markerPath, crashAfterMarker: true });
  if (process.platform === 'win32') {
    assert.notEqual(crashed.code, 0, 'Windows must report the hard-killed child as unsuccessful');
  } else {
    assert.equal(crashed.code, null);
    assert.equal(crashed.signal, 'SIGKILL');
  }
  assert.equal(fs.readFileSync(markerPath, 'utf8'), 'mutation-open');

  const retry = await runSqliteWorker(dbPath, '', operationId, 'retry');
  assert.equal(retry.code, 0, retry.stderr);
  const retryResult = JSON.parse(retry.stdout);
  const graph = new Graph({ dbPath, memoryPath: path.join(root, 'sqlite-transaction-crash.json'), useSQLite: true });
  const journal = graph._db.prepare('SELECT status, result FROM mutation_journal WHERE operation_id = ?').get(operationId);
  const receiptCount = graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts WHERE operation_id = ?').get(operationId).count;
  const nodeCount = graph._db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE workspace_id = ?').get('w').count;

  assert.equal(retryResult.outcome.replayed, false);
  assert.equal(retryResult.applications, 1);
  assert.equal(journal.status, 'completed');
  assert.equal(JSON.parse(journal.result).tag, 'retry');
  assert.equal(receiptCount, 1);
  assert.equal(nodeCount, 1);
  graph.close();
});

test('[json] a real process crash persists graph state but refuses stale-lock replay on restart', async () => {
  const memoryPath = path.join(root, 'process-crash-recovery.json');
  const journalPath = memoryPath.replace(/\.json$/, '.mutations.json');
  const lockPath = lockPathFor(journalPath);
  const markerPath = path.join(root, 'process-crash-recovery.marker');
  const operationId = 'process-crash-after-save';

  const crashed = await runJsonCrashWorker(memoryPath, markerPath, operationId);
  if (process.platform === 'win32') {
    assert.notEqual(crashed.code, 0, 'Windows must report the hard-killed child as unsuccessful');
  } else {
    assert.equal(crashed.code, null);
    assert.equal(crashed.signal, 'SIGKILL');
  }
  assert.equal(fs.readFileSync(markerPath, 'utf8'), 'graph-save-complete');
  assert.equal(fs.existsSync(memoryPath), true);
  assert.equal(journalStatus(journalPath, operationId), null, 'the killed process must not claim completion');

  const restartedGraph = new Graph({ memoryPath, useSQLite: false });
  restartedGraph.load();
  assert.ok(restartedGraph.getNode('crashed-node'), 'graph state written before the crash must remain readable');
  assert.equal(fs.existsSync(lockPath), true, 'SIGKILL bypasses the lock release finally block');

  const stale = new Date(Date.now() - (6 * 60 * 1000));
  fs.utimesSync(lockPath, stale, stale);
  const retry = await runJsonRetryWorker(memoryPath, operationId);
  assert.equal(retry.code, 0, retry.stderr);
  const retryResult = JSON.parse(retry.stdout);
  assert.equal(retryResult.ok, false);
  assert.equal(retryResult.code, 'MUTATION_JOURNAL_STALE_LOCK');
  assert.equal(retryResult.applications, 0, 'stale-lock refusal must happen before the mutation callback');
  assert.equal(fs.existsSync(lockPath), true, 'current fail-closed behavior preserves the stale lock for investigation');
});

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

test('[sqlite] concurrent replay recovered after rollback preserves the committed receipt', () => {
  const graph = Object.create(Graph.prototype);
  graph._nodes = {};
  graph._edges = [];
  graph._candidateClaims = [];
  graph._auditEvents = [];
  graph._outIndex = new Map();
  graph._inIndex = new Map();
  const result = { learned: 1 };
  const receiptRow = {
    operation_id: 'concurrent-operation', receipt_id: 'receipt-concurrent', workspace_id: 'w',
    canonical_payload: '{}', previous_receipt_hash: null, receipt_hash: 'hash',
    committed_at: '2026-01-01T00:00:00.000Z',
  };
  let reads = 0;
  graph._stmts = {
    getMutationJournal: { get: () => (++reads <= 2 ? undefined : { status: 'completed', result: JSON.stringify(result) }) },
    getMutationReceiptByOperation: { get: () => receiptRow },
  };
  graph._db = { transaction: (callback) => () => callback() };

  const replay = graph._runMutationOnceSqlite('concurrent-operation', () => {
    throw new Error('must not execute');
  }, {});
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, result);
  assert.deepEqual(replay.receipt, graph._readMutationReceipt(receiptRow));
});
