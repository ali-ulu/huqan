'use strict';

// One decision checks the same trail receipts from several readers; each parsed
// receipt is verified once and cannot change afterwards (#4325).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { fromMcpDecision } = require('../lib/verdict/action-verdict');
const { hasValidReceiptHash, readReceiptHistory } = require('../lib/autonomy-receipt-history');

function sealed(receiptId) {
  const canonical = buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: 'external_action_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `adm-${receiptId}`,
    workspaceId: 'default',
    provenanceId: 'external:history-agent:history',
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: { sessionId: 's1', justification: { blastRadius: { score: 10 } } },
  }, { verdict: fromMcpDecision({ decision: 'allow', reason: 'history' }).verdict });
  return { ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) };
}

function trailOf(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-receipt-history-'));
  const file = path.join(dir, 'receipts.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('receipts read from the trail are deeply frozen, so a verified result cannot go stale', () => {
  const [receipt] = readReceiptHistory({ path: trailOf([JSON.stringify(sealed('r1'))]) });
  assert.equal(hasValidReceiptHash(receipt), true);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.metadata.justification.blastRadius), true);
  assert.throws(() => { receipt.metadata.justification.blastRadius.score = 99; }, TypeError);
  assert.equal(hasValidReceiptHash(receipt), true);
});

test('a tampered trail line stays invalid on every check', () => {
  const tampered = { ...sealed('r2'), status: 'executed' };
  const [receipt] = readReceiptHistory({ path: trailOf([JSON.stringify(tampered)]) });
  assert.equal(hasValidReceiptHash(receipt), false);
  assert.equal(hasValidReceiptHash(receipt), false);
});

test('a caller-supplied receipt is re-verified after it changes', () => {
  const receipt = sealed('r3');
  const [supplied] = readReceiptHistory({ receipts: [receipt] });
  assert.equal(hasValidReceiptHash(supplied), true);
  supplied.status = 'executed';
  assert.equal(hasValidReceiptHash(supplied), false);
  assert.equal(Object.isFrozen(supplied), false);
});

test('values that are not receipts are rejected without being remembered', () => {
  assert.equal(hasValidReceiptHash(null), false);
  assert.equal(hasValidReceiptHash(undefined), false);
  assert.equal(hasValidReceiptHash('receipt'), false);
});
