'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { readReceiptById } = require('../lib/receipt/receipt-read-index');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');

// #2289, #2163: lib/mutation-journal.js and lib/receipt/receipt-read-index.js
// read the JSON journal through Graph's private `_readJsonJournal` and
// `_readMutationReceiptFromJsonJournal`. Graph already offers the public
// `readJsonJournal` (#2352), and the receipt projection is the pure
// `readMutationReceiptFromJsonJournal` in lib/graph-mutation-receipt-read.js,
// which the private Graph method only forwards to.

const ROOT = path.join(__dirname, '..');
const PRIVATE_NAMES = /\b_readJsonJournal\b|\b_readMutationReceiptFromJsonJournal\b/;

// receipt-read-index.js is split into receipt-read-index-<part>.js modules
// (#2120); the durable chain anchor that reads the journal lives in one of them,
// so every part of the read index counts as a reader.
const READER_MODULE_PATTERN = /[\\/](?:mutation-journal|receipt-read-index(?:-[a-z]+)*)\.js\b/;

function readerSourceFiles() {
  const receiptDir = path.join(ROOT, 'lib', 'receipt');
  const readIndexParts = fs.readdirSync(receiptDir)
    .filter((name) => /^receipt-read-index(?:-[a-z]+)*\.js$/.test(name))
    .map((name) => path.posix.join('lib/receipt', name));
  assert.ok(readIndexParts.includes('lib/receipt/receipt-read-index.js'), 'the read-index entry file must be scanned');
  return ['lib/mutation-journal.js', ...readIndexParts];
}

/** Throws only when the direct caller is one of the reader modules. */
function guardAgainstReaders(graph, name) {
  const original = graph[name].bind(graph);
  graph[name] = (...args) => {
    const caller = String(new Error().stack).split('\n')[2] || '';
    if (READER_MODULE_PATTERN.test(caller)) {
      throw new Error(`private Graph#${name} used from ${caller.trim()}`);
    }
    return original(...args);
  };
}

function withCommittedGraph(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2289-2163-'));
  const graph = new Graph({ memoryPath: path.join(root, 'memory.json'), useSQLite: false });
  try {
    const committed = graph.runMutationOnce('op-2289-1', () => ({ ok: true }), {
      buildCanonicalReceipt: () => buildCanonicalReceiptPayload({
        receiptId: 'receipt-2289-1',
        receiptKind: 'memory_admission_receipt',
        decision: 'allow',
        status: 'admitted',
        admissionId: 'admission-2289-1',
        workspaceId: 'workspace-a',
        provenanceId: 'prov-2289-1',
        trustPolicyVersion: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
      }, { verdict: 'allow' }),
    });
    graph.appendAuditEvent({
      eventType: 'TRUST_RECEIPT_MATERIALIZED',
      targetType: 'trust_receipt',
      targetId: committed.receipt.receiptId,
      workspaceId: 'workspace-a',
      timestamp: committed.receipt.canonicalPayload.createdAt,
      details: { receipt: committed.receipt.canonicalPayload },
    }, { workspaceId: 'workspace-a' });

    // From here on, a reach for the private journal surface from either reader
    // module is loud. Graph's own internal use of its private members (for
    // example its mutation-receipt store API) is legitimate and still delegates.
    for (const name of ['_readJsonJournal', '_readMutationReceiptFromJsonJournal']) guardAgainstReaders(graph, name);
    run(graph, committed);
  } finally {
    graph.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a committed mutation result and its receipt are read through the public journal surface', () => {
  withCommittedGraph((graph, committed) => {
    const byOperation = graph.getCommittedMutationResultByOperation('op-2289-1');
    assert.equal(byOperation.status, 'completed');
    assert.equal(byOperation.receipt.receiptHash, committed.receipt.receiptHash);

    const byPrefix = graph.getCommittedMutationResultsByPrefix('op-2289-');
    assert.deepEqual(byPrefix.map(item => item.operationId), ['op-2289-1']);
    assert.equal(byPrefix[0].receipt.receiptId, committed.receipt.receiptId);
  });
});

test('a receipt read anchors its chain through the public journal surface', () => {
  withCommittedGraph((graph, committed) => {
    const read = readReceiptById(graph, committed.receipt.receiptId, { workspaceId: 'workspace-a' });
    assert.equal(read.ok, true, `anchored read failed: ${JSON.stringify(read.error || read.status)}`);
    assert.equal(read.status, 'found');
  });
});

test('neither reader names the private Graph journal members', () => {
  for (const rel of readerSourceFiles()) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, rel), 'utf8'), PRIVATE_NAMES, `${rel} must use the public surface`);
  }
});
