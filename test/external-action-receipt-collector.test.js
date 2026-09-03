'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ingestReceiptBatch, queryFleet } = require('../lib/external-action-receipt-collector');
const {
  RECEIPT_BATCH_SCHEMA,
  buildReceiptBatch,
  shipExternalActionReceipts,
} = require('../lib/external-action-receipt-shipper');

function receipt(index, { workspaceId = 'default', ownerActorId = 'owner-a', decision = 'allow', attested = true, minute = index } = {}) {
  return {
    receiptId: `xact_adm_${String(index).padStart(4, '0')}`,
    receiptKind: 'external_action_admission_receipt',
    decision,
    reason: decision === 'block' ? 'DENYLISTED_COMMAND_BLOCKED' : 'external_action_allowed',
    actor: 'codex',
    workspaceId,
    createdAt: `2026-09-03T01:${String(minute).padStart(2, '0')}:00.000Z`,
    metadata: {
      identity: { identityRef: `agent:${workspaceId}:codex`, agentId: 'codex', ownerActorId, workspaceId, attested, signatureVerified: attested },
    },
  };
}

function batch(receipts, tenant = { workspaceId: 'default', ownerActorId: 'owner-a' }) {
  return buildReceiptBatch({ tenant, receipts, source: { host: 'workstation-1' } });
}

function store(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-collector-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a batch is stored under its tenant and re-delivery is not stored twice', t => {
  const root = store(t);
  const body = batch([receipt(1), receipt(2)]);

  const first = ingestReceiptBatch({ batch: body, root });
  assert.equal(first.status, 'stored');
  assert.equal(first.stored, 2);
  assert.equal(fs.existsSync(path.join(root, 'default', 'owner-a', 'receipts.jsonl')), true);

  // The shipper re-sends anything it was not acknowledged for, so this is the
  // normal case, not an error.
  const again = ingestReceiptBatch({ batch: body, root });
  assert.equal(again.status, 'duplicate');
  assert.equal(again.stored, 0);
  assert.equal(fs.readFileSync(first.trail, 'utf8').trim().split('\n').length, 2);
});

test('tenants land in separate files and a query can ask for one of them', t => {
  const root = store(t);
  ingestReceiptBatch({ batch: batch([receipt(1)]), root });
  ingestReceiptBatch({
    batch: batch([receipt(2, { workspaceId: 'team-b', ownerActorId: 'owner-b' })], { workspaceId: 'team-b', ownerActorId: 'owner-b' }),
    root,
  });

  assert.equal(fs.existsSync(path.join(root, 'team-b', 'owner-b', 'receipts.jsonl')), true);
  const all = queryFleet({ root });
  assert.equal(all.tenants.length, 2);
  const one = queryFleet({ root, workspaceId: 'team-b' });
  assert.deepEqual(one.tenants, [{ workspaceId: 'team-b', ownerActorId: 'owner-b' }]);
  assert.equal(one.agents.length, 1);
});

test('a batch whose receipts belong to another tenant is refused', t => {
  const root = store(t);
  const mixed = batch([receipt(1), receipt(2, { ownerActorId: 'someone-else' })]);
  const result = ingestReceiptBatch({ batch: mixed, root });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'mixed_tenant_batch');
  assert.equal(fs.existsSync(path.join(root, 'default')), false);
});

test('a damaged batch is refused, and the hash is treated as transport evidence only', t => {
  const root = store(t);
  const tampered = { ...batch([receipt(1)]), receipts: [receipt(9)] };
  const result = ingestReceiptBatch({ batch: tampered, root });
  assert.equal(result.error.code, 'content_hash_mismatch');

  for (const [invalid, code] of [
    [{ ...batch([receipt(1)]), schemaVersion: 'something.else' }, 'unsupported_schema'],
    [{ ...batch([receipt(1)]), tenant: undefined }, 'tenant_required'],
    [{ ...batch([receipt(1)]), receipts: [], contentHash: undefined }, 'receipts_required'],
  ]) {
    assert.equal(ingestReceiptBatch({ batch: invalid, root }).error.code, code);
  }
});

test('a tenant name cannot walk out of the store', t => {
  const root = store(t);
  const escaping = buildReceiptBatch({
    tenant: { workspaceId: '../../etc', ownerActorId: '..' },
    receipts: [{ ...receipt(1), workspaceId: '../../etc', metadata: { identity: { ownerActorId: '..', workspaceId: '../../etc' } } }],
  });
  const result = ingestReceiptBatch({ batch: escaping, root });
  assert.equal(result.status, 'stored');
  // Reduced to a slug and still inside the root; nothing above it is touched.
  assert.equal(result.trail.startsWith(path.resolve(root)), true);
  assert.equal(fs.existsSync(path.join(root, 'etc', 'unknown', 'receipts.jsonl')), true);
});

test('the fleet view answers per agent, not per receipt', t => {
  const root = store(t);
  ingestReceiptBatch({
    batch: batch([
      receipt(1, { decision: 'allow' }),
      receipt(2, { decision: 'block' }),
      receipt(3, { decision: 'review' }),
    ]),
    root,
  });

  const fleet = queryFleet({ root });
  assert.equal(fleet.agents.length, 1);
  const [agent] = fleet.agents;
  assert.equal(agent.identityRef, 'agent:default:codex');
  assert.equal(agent.total, 3);
  assert.deepEqual(agent.byDecision, { allow: 1, block: 1, review: 1 });
  assert.equal(agent.firstAt, '2026-09-03T01:01:00.000Z');
  assert.equal(agent.lastAt, '2026-09-03T01:03:00.000Z');
  assert.equal(agent.lastBlocked.reason, 'DENYLISTED_COMMAND_BLOCKED');
});

test('a fleet row claims attestation only when every action under it carried one', t => {
  const root = store(t);
  ingestReceiptBatch({ batch: batch([receipt(1, { attested: true }), receipt(2, { attested: false })]), root });
  const [agent] = queryFleet({ root }).agents;
  assert.equal(agent.attested, false, 'one unattested action is enough to stop the claim');
  assert.equal(agent.signatureVerified, false);
});

test('a time window narrows the answer', t => {
  const root = store(t);
  ingestReceiptBatch({ batch: batch([receipt(1), receipt(2), receipt(3)]), root });
  const windowed = queryFleet({ root, since: '2026-09-03T01:02:00.000Z' });
  assert.equal(windowed.agents[0].total, 2);
});

test('what the shipper sends is what the collector stores', async t => {
  // The two halves are written against the same envelope; this is the test
  // that they actually meet.
  const root = store(t);
  const trail = path.join(root, 'source-trail.jsonl');
  fs.writeFileSync(trail, [
    receipt(1),
    receipt(2, { workspaceId: 'team-b', ownerActorId: 'owner-b' }),
    receipt(3, { decision: 'block' }),
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');

  const report = await shipExternalActionReceipts({
    path: trail,
    cursorPath: path.join(root, 'cursor.json'),
    endpoint: 'https://collector.invalid/batches',
    host: 'workstation-1',
    fetchImpl: async (endpoint, request) => {
      const stored = ingestReceiptBatch({ batch: JSON.parse(request.body), root: path.join(root, 'store') });
      return { ok: stored.ok, status: stored.ok ? 202 : 400 };
    },
  });

  assert.equal(report.shipped, 3);
  const fleet = queryFleet({ root: path.join(root, 'store') });
  assert.equal(fleet.tenants.length, 2);
  assert.equal(fleet.agents.reduce((total, agent) => total + agent.total, 0), 3);
  const blocked = fleet.agents.find(agent => agent.byDecision.block);
  assert.equal(blocked.lastBlocked.reason, 'DENYLISTED_COMMAND_BLOCKED');
  // Every stored receipt says which batch delivered it and what the sender
  // claimed about the bundle's signature.
  const line = JSON.parse(fs.readFileSync(path.join(root, 'store', 'default', 'owner-a', 'receipts.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(line.collector.source.host, 'workstation-1');
  assert.equal(line.collector.bundleSignature, 'unsigned');
  assert.match(line.collector.batchId, /^rcpt_batch_/);
  assert.equal(RECEIPT_BATCH_SCHEMA, 'huqan.receipt-batch.v1');
});

test('a self-hosted deployment can ship into a store without standing up HTTP', async t => {
  const root = store(t);
  const trail = path.join(root, 'source-trail.jsonl');
  fs.writeFileSync(trail, `${JSON.stringify(receipt(1))}\n${JSON.stringify(receipt(2))}\n`);
  const target = path.join(root, 'store');

  const report = await shipExternalActionReceipts({
    path: trail,
    cursorPath: path.join(root, 'cursor.json'),
    deliver: batchBody => ingestReceiptBatch({ batch: batchBody, root: target }),
  });
  assert.equal(report.shipped, 2);
  assert.equal(queryFleet({ root: target }).agents[0].total, 2);

  // A refusal from the store is a failed delivery like any other: reported,
  // and the cursor does not move past it.
  fs.appendFileSync(trail, `${JSON.stringify(receipt(3))}\n`);
  const refused = await shipExternalActionReceipts({
    path: trail,
    cursorPath: path.join(root, 'cursor.json'),
    deliver: () => ({ ok: false, error: { code: 'mixed_tenant_batch' } }),
  });
  assert.equal(refused.shipped, 0);
  assert.match(refused.failure.message, /mixed_tenant_batch/);

  const retried = await shipExternalActionReceipts({
    path: trail,
    cursorPath: path.join(root, 'cursor.json'),
    deliver: batchBody => ingestReceiptBatch({ batch: batchBody, root: target }),
  });
  assert.equal(retried.shipped, 1);
  assert.equal(queryFleet({ root: target }).agents[0].total, 3);
});
