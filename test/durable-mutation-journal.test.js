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
const { readMutationJournal } = require('../lib/mutation-journal');
const { LOCK_WAIT_MS, STALE_LOCK_MS, isReclaimableLock, lockPathFor, ownerPathFor, withMutationJournalLock } = require('../lib/mutation-journal-lock');
const { redoPathFor } = require('../lib/graph-json-transaction');

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
    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.load();
    fs.writeFileSync(barrierPath + '.' + tag, 'loaded');
    while (!fs.existsSync(barrierPath)) Atomics.wait(sleeper, 0, 0, 5);
    const outcome = graph.runMutationOnce(operationId, () => {
      Atomics.wait(sleeper, 0, 0, 150);
      graph.addNode('node-' + tag, 'worker ' + tag);
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

async function releaseJournalWorkers(barrierPath) {
  const deadline = Date.now() + 5000;
  while (!['a', 'b'].every(tag => fs.existsSync(barrierPath + '.' + tag))) {
    if (Date.now() > deadline) throw new Error('journal workers did not load their initial snapshots');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  fs.writeFileSync(barrierPath, 'ready');
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

function runJsonCrashWorker(memoryPath, markerPath, operationId, crashPoint) {
  const script = `
    const fs = require('node:fs');
    const Graph = require(process.argv[1]);
    const { buildCanonicalReceiptPayload } = require(process.argv[2]);
    const memoryPath = process.argv[3];
    const markerPath = process.argv[4];
    const operationId = process.argv[5];
    const crashPoint = process.argv[6];
    const graph = new Graph({ memoryPath, useSQLite: false });
    graph._jsonTransactionFault = point => {
      if (point !== crashPoint) return;
      fs.writeFileSync(markerPath, point);
      process.kill(process.pid, 'SIGKILL');
    };
    graph.runMutationOnce(operationId, () => {
      graph.addNode('crashed-node', 'persisted before journal crash');
      return { applied: true };
    }, { buildCanonicalReceipt: () => buildCanonicalReceiptPayload({
      receiptId: 'receipt-' + operationId,
      receiptKind: 'memory_admission_receipt', decision: 'allow', status: 'admitted',
      admissionId: 'admission-' + operationId, workspaceId: 'w',
      provenanceId: 'prov-' + operationId, trustPolicyVersion: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
    }, { verdict: 'allow' }) });
  `;
  return runProcess(['-e', script, path.join(__dirname, '..', 'graph.js'), path.join(__dirname, '..', 'lib', 'receipt', 'canonical-receipt.js'), memoryPath, markerPath, operationId, crashPoint]);
}

function runJsonRetryWorker(memoryPath, operationId, crashPoint = '') {
  const script = `
    const Graph = require(process.argv[1]);
    const { buildCanonicalReceiptPayload } = require(process.argv[2]);
    const memoryPath = process.argv[3];
    const operationId = process.argv[4];
    const crashPoint = process.argv[5];
    const graph = new Graph({ memoryPath, useSQLite: false });
    if (crashPoint) graph._jsonTransactionFault = point => {
      if (point === crashPoint) process.kill(process.pid, 'SIGKILL');
    };
    let applications = 0;
    try {
      const outcome = graph.runMutationOnce(operationId, () => {
        applications += 1;
        graph.addNode('retry-node', 'must not execute after stale-lock refusal');
        return { applied: true };
      }, { buildCanonicalReceipt: () => buildCanonicalReceiptPayload({
        receiptId: 'receipt-' + operationId,
        receiptKind: 'memory_admission_receipt', decision: 'allow', status: 'admitted',
        admissionId: 'admission-' + operationId, workspaceId: 'w',
        provenanceId: 'prov-' + operationId, trustPolicyVersion: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
      }, { verdict: 'allow' }) });
      process.stdout.write(JSON.stringify({ ok: true, outcome, applications,
        crashedNode: Boolean(graph.getNode('crashed-node')),
        retryNode: Boolean(graph.getNode('retry-node')),
        receipt: graph.getCommittedMutationReceiptByOperation(operationId) }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message, applications }));
    }
  `;
  return runProcess(['-e', script, path.join(__dirname, '..', 'graph.js'), path.join(__dirname, '..', 'lib', 'receipt', 'canonical-receipt.js'), memoryPath, operationId, crashPoint]);
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
  await releaseJournalWorkers(barrierPath);
  const outcomes = await Promise.all(workers);
  const fresh = new Graph({ memoryPath, useSQLite: false });
  fresh.load();
  const journal = fresh._readJsonJournal();

  assert.equal(outcomes.filter(outcome => outcome.replayed === false).length, 1);
  assert.equal(outcomes.filter(outcome => outcome.replayed === true).length, 1);
  assert.deepEqual(Object.keys(journal.operations), ['shared-operation']);
  assert.equal(Object.keys(fresh.getNodes()).length, 1);
  assert.equal(fs.existsSync(`${memoryPath}.mutations.json.lock`), false);
});

test('[json] durable journal retains concurrent distinct operations across processes', async () => {
  const memoryPath = path.join(root, 'multi-process-distinct.json');
  const barrierPath = path.join(root, 'multi-process-distinct.ready');
  const workers = [
    runConcurrentJournalWorker(memoryPath, barrierPath, 'operation-a', 'a'),
    runConcurrentJournalWorker(memoryPath, barrierPath, 'operation-b', 'b'),
  ];
  await releaseJournalWorkers(barrierPath);
  const outcomes = await Promise.all(workers);
  const fresh = new Graph({ memoryPath, useSQLite: false });
  fresh.load();
  const journal = fresh._readJsonJournal();

  assert.deepEqual(outcomes.map(outcome => outcome.replayed), [false, false]);
  assert.deepEqual(Object.keys(journal.operations).sort(), ['operation-a', 'operation-b']);
  assert.ok(fresh.getNode('node-a'));
  assert.ok(fresh.getNode('node-b'));
});

test('[json] a stale direct save cannot overwrite a newer writer', () => {
  const a = makeGraph('stale-direct-save', 'json');
  const b = makeGraph('stale-direct-save', 'json');
  a.load(); b.load();
  a.addNode('first'); a.save();
  b.addNode('pending');
  const bytes = fs.readFileSync(a.memoryPath);
  assert.throws(() => b.save(), { code: 'GRAPH_JSON_WRITE_CONFLICT' });
  assert.deepEqual(fs.readFileSync(a.memoryPath), bytes);
  assert.ok(b.getNode('pending'), 'conflict retains the caller pending view');
  b.load(); b.addNode('second'); b.save();
  a.load();
  assert.ok(a.getNode('first'));
  assert.ok(a.getNode('second'));
});

test('[json] canonical refresh refuses to discard local unsaved changes', () => {
  const a = makeGraph('dirty-canonical-view', 'json');
  const b = makeGraph('dirty-canonical-view', 'json');
  a.load(); b.load();
  b.addNode('pending');
  a.runMutationOnce('first', () => { a.addNode('first'); return { ok: true }; });
  let called = false;
  assert.throws(() => b.runMutationOnce('second', () => { called = true; }), { code: 'GRAPH_JSON_WRITE_CONFLICT' });
  assert.equal(called, false);
  assert.ok(b.getNode('pending'));
  assert.equal(b._readJsonJournal().operations.second, undefined);
});

test('[json] nested canonical mutations fail before the inner callback or persistence', () => {
  const graph = makeGraph('nested-canonical', 'json');
  let innerCalled = false;
  assert.throws(() => graph.runMutationOnce('outer', () => {
    graph.addNode('outer');
    return graph.runMutationOnce('inner', () => { innerCalled = true; return { ok: true }; });
  }), { code: 'GRAPH_JSON_NESTED_MUTATION' });
  assert.equal(innerCalled, false);
  assert.equal(graph.getNode('outer'), null);
  assert.deepEqual(Object.keys(graph._readJsonJournal().operations), []);
  assert.equal(fs.existsSync(graph.memoryPath), false);
});

test('[json] a dead directory-lock owner is reclaimed without deleting a live successor lock', () => {
  const journalPath = path.join(root, 'stale-lock.mutations.json');
  const lockPath = lockPathFor(journalPath);
  fs.mkdirSync(lockPath);
  fs.writeFileSync(ownerPathFor(journalPath), JSON.stringify({
    pid: 2147483647, token: 'dead', acquiredAt: '2026-01-01T00:00:00.000Z',
  }));
  const stale = new Date(Date.now() - STALE_LOCK_MS - 100);
  fs.utimesSync(lockPath, stale, stale);

  let ran = false;
  withMutationJournalLock(journalPath, () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(ownerPathFor(journalPath)), false);
});

test('[json] a live owner is never declared reclaimable even past the stale mtime', () => {
  const journalPath = path.join(root, 'live-lock.mutations.json');
  const lockPath = lockPathFor(journalPath);
  fs.mkdirSync(lockPath);
  fs.writeFileSync(ownerPathFor(journalPath), JSON.stringify({
    pid: process.pid, token: 'live', acquiredAt: new Date().toISOString(),
  }));
  const stale = new Date(Date.now() - STALE_LOCK_MS - 100);
  fs.utimesSync(lockPath, stale, stale);
  assert.equal(isReclaimableLock(journalPath), false);
});

test('[json] an empty abandoned directory lock becomes reclaimable only after the age gate', () => {
  const journalPath = path.join(root, 'empty-directory-lock.mutations.json');
  const lockPath = lockPathFor(journalPath);
  fs.mkdirSync(lockPath);
  assert.equal(isReclaimableLock(journalPath), false);
  const stale = new Date(Date.now() - STALE_LOCK_MS - 100);
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

for (const crashPoint of ['before-prepared', 'after-prepared', 'after-graph-publish', 'after-embedding-publish', 'after-journal-publish']) {
  test(`[json] SIGKILL at ${crashPoint} recovers one canonical operation within five seconds`, async () => {
    const slug = crashPoint.replaceAll('-', '_');
    const memoryPath = path.join(root, `process-crash-${slug}.json`);
    const journalPath = memoryPath.replace(/\.json$/, '.mutations.json');
    const markerPath = path.join(root, `process-crash-${slug}.marker`);
    const operationId = `process-crash-${slug}`;

    const crashed = await runJsonCrashWorker(memoryPath, markerPath, operationId, crashPoint);
    assert.notEqual(crashed.code, 0);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), crashPoint);

    const startedAt = Date.now();
    const retry = await runJsonRetryWorker(memoryPath, operationId);
    const recoveryMs = Date.now() - startedAt;
    assert.equal(retry.code, 0, retry.stderr);
    assert.ok(recoveryMs < 5_000, `recovery took ${recoveryMs}ms`);
    const result = JSON.parse(retry.stdout);
    assert.equal(result.ok, true);
    const prepared = crashPoint !== 'before-prepared';
    assert.equal(result.applications, prepared ? 0 : 1);
    assert.equal(result.outcome.replayed, prepared);
    assert.equal(result.crashedNode, prepared);
    assert.equal(result.retryNode, !prepared);
    assert.equal(result.receipt.receiptId, `receipt-${operationId}`);
    assert.equal(result.receipt.previousReceiptHash, GENESIS_PREVIOUS_HASH);
    assert.equal(journalStatus(journalPath, operationId), 'completed');

    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.load();
    const next = graph.runMutationOnce(`${operationId}-next`, () => {
      graph.addNode('next-node', 'next operation');
      return { applied: true };
    });
    assert.equal(next.replayed, false);
    assert.ok(graph.getNode('next-node'));
    assert.equal(fs.existsSync(lockPathFor(journalPath)), false);
    assert.equal(fs.existsSync(ownerPathFor(journalPath)), false);
    assert.equal(fs.existsSync(redoPathFor(journalPath)), false);
  });
}

test('[json] SIGKILL before recovery cleanup is idempotently recoverable', async () => {
  const memoryPath = path.join(root, 'process-crash-recovery-cleanup.json');
  const journalPath = memoryPath.replace(/\.json$/, '.mutations.json');
  const markerPath = path.join(root, 'process-crash-recovery-cleanup.marker');
  const operationId = 'process-crash-recovery-cleanup';
  const firstCrash = await runJsonCrashWorker(memoryPath, markerPath, operationId, 'after-prepared');
  assert.notEqual(firstCrash.code, 0);
  const recoveryCrash = await runJsonRetryWorker(memoryPath, operationId, 'before-recovery-cleanup');
  assert.notEqual(recoveryCrash.code, 0);
  assert.equal(fs.existsSync(redoPathFor(journalPath)), true);

  const startedAt = Date.now();
  const finalRetry = await runJsonRetryWorker(memoryPath, operationId);
  assert.ok(Date.now() - startedAt < 5_000);
  assert.equal(finalRetry.code, 0, finalRetry.stderr);
  const result = JSON.parse(finalRetry.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.applications, 0);
  assert.equal(result.outcome.replayed, true);
  assert.equal(result.crashedNode, true);
  assert.equal(result.retryNode, false);
  assert.equal(result.receipt.previousReceiptHash, GENESIS_PREVIOUS_HASH);
  assert.equal(fs.existsSync(redoPathFor(journalPath)), false);
  assert.equal(fs.existsSync(lockPathFor(journalPath)), false);
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
test('[json] durable journal never marks an operation completed if prepare fails (no phantom completion)', () => {
  const graph = makeGraph('save-fail', 'json');
  graph._jsonTransactionFault = point => {
    if (point === 'before-prepared') throw new Error('simulated prepare failure');
  };
  let threw = null;
  try {
    graph.runMutationOnce('op-save-fail', () => {
      graph.addNode('fish', 'Fish', null, { workspaceId: 'w' });
      return { learned: 1 };
    });
  } catch (error) {
    threw = error;
  } finally {
    graph._jsonTransactionFault = null;
  }
  assert.ok(threw, 'prepare failure must propagate, not be swallowed');
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

test('[json] recovery hash mismatch fails closed and preserves redo evidence', async () => {
  const memoryPath = path.join(root, 'recovery-conflict.json');
  const journalPath = memoryPath.replace(/\.json$/, '.mutations.json');
  const markerPath = path.join(root, 'recovery-conflict.marker');
  const operationId = 'recovery-conflict';
  const crashed = await runJsonCrashWorker(memoryPath, markerPath, operationId, 'after-prepared');
  assert.notEqual(crashed.code, 0);
  fs.writeFileSync(memoryPath, JSON.stringify({ unrelated: true }));
  const retry = await runJsonRetryWorker(memoryPath, operationId);
  assert.equal(retry.code, 0, retry.stderr);
  const result = JSON.parse(retry.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GRAPH_JSON_RECOVERY_CONFLICT');
  assert.equal(result.applications, 0);
  assert.equal(fs.existsSync(redoPathFor(journalPath)), true);
  assert.equal(journalStatus(journalPath, operationId), null);
});

test('[json] recovery refuses a redo target outside the exact store paths', async () => {
  const memoryPath = path.join(root, 'recovery-path-conflict.json');
  const journalPath = memoryPath.replace(/\.json$/, '.mutations.json');
  const markerPath = path.join(root, 'recovery-path-conflict.marker');
  const outsidePath = path.join(root, 'must-not-be-written.json');
  const operationId = 'recovery-path-conflict';
  const crashed = await runJsonCrashWorker(memoryPath, markerPath, operationId, 'after-prepared');
  assert.notEqual(crashed.code, 0);
  const redoPath = redoPathFor(journalPath);
  const redo = JSON.parse(fs.readFileSync(redoPath, 'utf8'));
  redo.files.memory.path = outsidePath;
  fs.writeFileSync(redoPath, JSON.stringify(redo));

  const retry = await runJsonRetryWorker(memoryPath, operationId);
  assert.equal(retry.code, 0, retry.stderr);
  const result = JSON.parse(retry.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GRAPH_JSON_RECOVERY_CONFLICT');
  assert.equal(result.applications, 0);
  assert.equal(fs.existsSync(outsidePath), false);
  assert.equal(fs.existsSync(redoPath), true);
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
