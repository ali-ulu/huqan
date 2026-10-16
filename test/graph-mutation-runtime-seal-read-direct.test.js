'use strict';

/**
 * Direct coverage for the committed-receipt seal reader by operation id
 * (#3342).
 *
 * `getMutationReceiptSealByOperation` in lib/graph-mutation-runtime.js is only
 * reached from a smoke that did not always run in the full suite, so its inner
 * branch sometimes went uncounted and the file's branch total moved between
 * identical full-suite runs (93 vs 92), turning the coverage ratchet red on
 * unrelated PRs. This test drives the public reader on a real mutation for both
 * backends, and reads the receipt back by id, so the path always executes.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, beforeEach, test } = require('node:test');

const Graph = require('../graph');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');

const KEY_VAR = 'HUQAN_ISSUER_SEAL_KEY';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-seal-read-direct-'));

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });
beforeEach(() => { delete process.env[KEY_VAR]; });

function writeKeyFile(name) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const file = path.join(root, `${name}.pem`);
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  return file;
}

function payloadFor(receiptId) {
  return buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `madm_${receiptId}`,
    workspaceId: 'seal-read-ws',
    provenanceId: 'prov-1',
    trustPolicyVersion: '0.8.0',
    createdAt: '2026-09-09T01:00:00.000Z',
  }, { verdict: 'allow' });
}

function makeGraph(name, backend) {
  const opts = { memoryPath: path.join(root, `${name}-${backend}.json`) };
  if (backend === 'sqlite') opts.dbPath = path.join(root, `${name}-${backend}.db`);
  else opts.useSQLite = false;
  const graph = new Graph(opts);
  if (backend === 'sqlite') {
    // Graph silently falls back to JSON when better-sqlite3 is unavailable, so
    // the sqlite case would otherwise pass while exercising the JSON backend.
    assert.ok(graph._db, 'the sqlite case must open a SQLite handle, not fall back to JSON');
  }
  return graph;
}

for (const backend of ['sqlite', 'json']) {
  test(`[${backend}] seal readers resolve a committed receipt by operation id and by id`, () => {
    process.env[KEY_VAR] = writeKeyFile(`read-${backend}`);
    const graph = makeGraph('read', backend);
    const outcome = graph.runMutationOnce('op-seal-read', () => {
      graph.addNode('node-seal-read', 'seal read fixture');
      return { applied: true };
    }, { buildCanonicalReceipt: () => payloadFor('r-seal-read') });

    const seal = graph.getMutationReceiptSealByOperation('op-seal-read');
    assert.ok(seal, 'a configured key must seal the committed receipt');
    assert.strictEqual(seal.receiptHash, outcome.receipt.receiptHash);
    assert.deepEqual(graph.getMutationReceiptSealByHash(outcome.receipt.receiptHash), seal);

    assert.deepEqual(graph.getCommittedMutationReceiptById('r-seal-read'), outcome.receipt);
    assert.strictEqual(graph.getMutationReceiptSealByOperation('op-absent'), null);
    graph.closeSqlite?.();
  });
}
