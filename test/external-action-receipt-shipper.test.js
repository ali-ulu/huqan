'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RECEIPT_BATCH_SCHEMA,
  shipExternalActionReceipts,
} = require('../lib/external-action-receipt-shipper');

function receipt(index, { workspaceId = 'default', ownerActorId = 'owner-a', minute = index } = {}) {
  return {
    receiptId: `xact_adm_${String(index).padStart(4, '0')}`,
    receiptKind: 'external_action_admission_receipt',
    decision: 'allow',
    workspaceId,
    createdAt: `2026-09-03T00:${String(minute).padStart(2, '0')}:00.000Z`,
    metadata: { identity: { identityRef: `agent:${workspaceId}:codex`, ownerActorId, workspaceId } },
  };
}

function trail(t, receipts) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-shipper-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const target = path.join(base, 'receipts.jsonl');
  fs.writeFileSync(target, receipts.map(entry => JSON.stringify(entry)).join('\n') + (receipts.length ? '\n' : ''));
  return { path: target, cursorPath: path.join(base, 'cursor.json') };
}

function collector({ failFrom = Infinity } = {}) {
  const received = [];
  return {
    received,
    fetchImpl: async (endpoint, request) => {
      const batch = JSON.parse(request.body);
      if (received.length + 1 >= failFrom) return { ok: false, status: 503 };
      received.push(batch);
      return { ok: true, status: 202 };
    },
  };
}

test('a dry run reports what would go out and touches neither network nor cursor', async t => {
  const paths = trail(t, [receipt(1), receipt(2)]);
  const report = await shipExternalActionReceipts({ ...paths, dryRun: true, fetchImpl: () => { throw new Error('network used'); } });
  assert.equal(report.pending, 2);
  assert.equal(report.shipped, 0);
  assert.equal(report.batches.length, 1);
  assert.equal(report.batches[0].bundleSignature, 'unsigned');
  assert.equal(fs.existsSync(paths.cursorPath), false);
});

test('shipping is incremental: what a collector accepted is not sent again', async t => {
  const paths = trail(t, [receipt(1), receipt(2)]);
  const first = collector();
  const initial = await shipExternalActionReceipts({ ...paths, endpoint: 'https://collector.invalid/batch', fetchImpl: first.fetchImpl });
  assert.equal(initial.shipped, 2);
  assert.equal(first.received.length, 1);
  assert.equal(first.received[0].schemaVersion, RECEIPT_BATCH_SCHEMA);

  const second = collector();
  const repeat = await shipExternalActionReceipts({ ...paths, endpoint: 'https://collector.invalid/batch', fetchImpl: second.fetchImpl });
  assert.equal(repeat.pending, 0);
  assert.equal(second.received.length, 0, 'an acknowledged receipt is not shipped twice');

  fs.appendFileSync(paths.path, `${JSON.stringify(receipt(3))}\n`);
  const third = collector();
  const appended = await shipExternalActionReceipts({ ...paths, endpoint: 'https://collector.invalid/batch', fetchImpl: third.fetchImpl });
  assert.equal(appended.shipped, 1);
  assert.deepEqual(third.received[0].receipts.map(entry => entry.receiptId), ['xact_adm_0003']);
});

test('a batch carries one tenant, and the trail keeps its order', async t => {
  const paths = trail(t, [
    receipt(1, { ownerActorId: 'owner-a' }),
    receipt(2, { workspaceId: 'team-b', ownerActorId: 'owner-b' }),
    receipt(3, { ownerActorId: 'owner-a' }),
  ]);
  const target = collector();
  const report = await shipExternalActionReceipts({ ...paths, endpoint: 'https://collector.invalid/batch', fetchImpl: target.fetchImpl });
  assert.equal(report.shipped, 3);
  assert.deepEqual(target.received.map(batch => batch.tenant), [
    { workspaceId: 'default', ownerActorId: 'owner-a' },
    { workspaceId: 'team-b', ownerActorId: 'owner-b' },
    { workspaceId: 'default', ownerActorId: 'owner-a' },
  ]);
  for (const batch of target.received) {
    const tenants = new Set(batch.receipts.map(entry => `${entry.workspaceId}/${entry.metadata.identity.ownerActorId}`));
    assert.equal(tenants.size, 1, 'a batch must never mix tenants');
  }
});

test('a collector that refuses a batch loses nothing: the rest stays pending', async t => {
  const paths = trail(t, [
    receipt(1, { ownerActorId: 'owner-a' }),
    receipt(2, { ownerActorId: 'owner-b' }),
    receipt(3, { ownerActorId: 'owner-c' }),
  ]);
  const flaky = collector({ failFrom: 2 });
  const failed = await shipExternalActionReceipts({ ...paths, endpoint: 'https://collector.invalid/batch', fetchImpl: flaky.fetchImpl });
  assert.equal(failed.shipped, 1);
  assert.match(failed.failure.message, /HTTP 503/);

  // The trail is the queue: the next run resumes at the batch that failed.
  const recovered = collector();
  const retried = await shipExternalActionReceipts({ ...paths, endpoint: 'https://collector.invalid/batch', fetchImpl: recovered.fetchImpl });
  assert.equal(retried.shipped, 2);
  assert.deepEqual(recovered.received.flatMap(batch => batch.receipts.map(entry => entry.receiptId)), ['xact_adm_0002', 'xact_adm_0003']);
});

test('a rotated trail resyncs by time and says so', async t => {
  const paths = trail(t, [receipt(1), receipt(2), receipt(3)]);
  const first = collector();
  await shipExternalActionReceipts({ ...paths, endpoint: 'https://collector.invalid/batch', fetchImpl: first.fetchImpl });

  // Rotation: the file is replaced, so the stored count now points at a
  // receipt that is not the one it was taken at.
  fs.writeFileSync(paths.path, [receipt(4, { minute: 4 }), receipt(5, { minute: 5 })].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const second = collector();
  const report = await shipExternalActionReceipts({ ...paths, endpoint: 'https://collector.invalid/batch', fetchImpl: second.fetchImpl });
  assert.equal(report.resynced, true);
  assert.deepEqual(second.received.flatMap(batch => batch.receipts.map(entry => entry.receiptId)), ['xact_adm_0004', 'xact_adm_0005']);
});

test('the batch envelope is addressable and honest about not being signed', async t => {
  const paths = trail(t, [receipt(1)]);
  const target = collector();
  await shipExternalActionReceipts({
    ...paths, endpoint: 'https://collector.invalid/batch', fetchImpl: target.fetchImpl, host: 'workstation-1',
  });
  const [batch] = target.received;
  assert.equal(batch.schemaVersion, RECEIPT_BATCH_SCHEMA);
  assert.match(batch.batchId, /^rcpt_batch_[0-9a-f]{32}$/);
  assert.equal(batch.source.host, 'workstation-1');
  assert.equal(batch.count, batch.receipts.length);
  assert.match(batch.contentHash, /^sha256:[0-9a-f]{64}$/);
  // The card that names the agent is signed; the bundle is not (#1788). The
  // field exists from the first version so that upgrade is not a break.
  assert.deepEqual(batch.bundleSignature, { status: 'unsigned', algorithm: '', value: '', keyId: '' });
});

test('shipping without a destination is refused rather than silently skipped', async t => {
  const paths = trail(t, [receipt(1)]);
  await assert.rejects(() => shipExternalActionReceipts(paths), /requires an endpoint/);
});

test('a missing trail is nothing to ship, not a failure', async t => {
  const paths = trail(t, []);
  fs.rmSync(paths.path);
  const report = await shipExternalActionReceipts({ ...paths, endpoint: 'https://collector.invalid/batch', fetchImpl: () => { throw new Error('network used'); } });
  assert.equal(report.pending, 0);
  assert.equal(report.shipped, 0);
  assert.equal(report.failure, null);
});
