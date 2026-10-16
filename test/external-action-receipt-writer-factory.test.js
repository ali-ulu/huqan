'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #2192 (#2118): lib/external-action-receipt.js built a default Graph inside
// `createDurableExternalActionReceiptWriter`. Constructing and owning that
// graph now happens in the composition-root module
// lib/external-action-receipt-writer-factory.js. The receipt module keeps the
// public function: it creates the JSONL trail and hands it to the factory. The
// factory requires nothing from the receipt module, so the dependency points
// one way, and index.js -- whose public export is unchanged -- gains no new
// dependency (its fan-out sits at the FANOUT threshold minus one).

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const RECEIPT = { receiptId: 'rcpt-2192', receiptKind: 'external_action_admission_receipt', admissionId: 'adm-2192',
  workspaceId: 'ws-2192', actor: 'agent', createdAt: '2026-09-14T00:00:00.000Z', receiptHash: 'hash-2192',
  provenanceId: 'prov-2192', trustPolicyVersion: 'test' };

test('only the factory module constructs the writer graph', () => {
  assert.doesNotMatch(read('lib/external-action-receipt.js'), /new\s+Graph\s*\(/);
  assert.match(read('lib/external-action-receipt-writer-factory.js'), /new\s+Graph\s*\(/);
});

test('the dependency points one way: the factory requires nothing from the receipt module', () => {
  assert.doesNotMatch(read('lib/external-action-receipt-writer-factory.js'), /require\(['"]\.\/external-action-receipt['"]\)/);
  const { buildDurableReceiptWriter } = require('../lib/external-action-receipt-writer-factory');
  assert.throws(() => buildDurableReceiptWriter({ graph: { appendAuditEvent() {} } }), TypeError);
});

test('index.js keeps its dependency set: it does not require the factory module', () => {
  assert.doesNotMatch(read('index.js'), /external-action-receipt-writer-factory/);
});

test('an injected graph receives the audit projection and is not closed by the writer', () => {
  const { createDurableExternalActionReceiptWriter } = require('../lib/external-action-receipt');
  const lines = [];
  const audits = [];
  let closed = 0;
  const graph = { appendAuditEvent: (event) => { audits.push(event); return event; }, close: () => { closed += 1; } };
  const writer = createDurableExternalActionReceiptWriter({ graph, jsonlWriter: { path: 'x.jsonl', append: (r) => { lines.push(r); return r; } } });

  assert.equal(writer.append(RECEIPT), RECEIPT);
  assert.deepEqual(lines, [RECEIPT], 'the JSONL trail is written first');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].auditId, 'rcpt-2192');
  assert.equal(audits[0].eventType, 'EXTERNAL_ACTION_ADMISSION_RECEIPT');
  assert.equal(audits[0].targetType, 'external_agent_action');
  assert.equal(audits[0].targetId, 'adm-2192');
  assert.equal(writer.path, 'x.jsonl');
  assert.equal(writer.graph, graph);
  writer.close();
  assert.equal(closed, 0, 'an injected graph belongs to the caller');
});

test('without an injected graph the writer builds and owns a real Graph', () => {
  const Graph = require('../graph');
  const { createDurableExternalActionReceiptWriter } = require('../lib/external-action-receipt');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2192-'));
  try {
    const writer = createDurableExternalActionReceiptWriter({ path: path.join(dir, 'receipts.jsonl'),
      memoryPath: path.join(dir, 'memory.json'), dbPath: path.join(dir, 'memory.db') });
    assert.ok(writer.graph instanceof Graph);
    assert.equal(writer.path, path.join(dir, 'receipts.jsonl'), 'the JSONL trail is still created from options');
    let closed = 0;
    const realClose = writer.graph.close.bind(writer.graph);
    writer.graph.close = () => { closed += 1; return realClose(); };
    writer.close();
    assert.equal(closed, 1, 'a graph the writer built is closed by the writer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the package entry point still exports the receipt module function', () => {
  const receipt = require('../lib/external-action-receipt');
  const pkg = require('../index');
  assert.equal(pkg.createDurableExternalActionReceiptWriter, receipt.createDurableExternalActionReceiptWriter);
});
