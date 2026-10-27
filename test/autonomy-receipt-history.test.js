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
const { belongsToIdentity, hasValidReceiptHash, readReceiptHistory } = require('../lib/autonomy-receipt-history');

function sealed(receiptId, identityRef = 'agent:default:history-agent') {
  const canonical = buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: 'external_action_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `adm-${receiptId}`,
    workspaceId: 'default',
    provenanceId: `external:${identityRef}:history`,
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: { sessionId: 's1', identity: { identityRef }, justification: { blastRadius: { score: 10 } } },
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

// #4335: a receipt window reads only the tail of the trail, so a decision's
// cost does not grow with the trail. N counts this identity's hash-valid
// receipts; other identities' receipts never consume a slot.
test('a window returns the last N hash-valid receipts of this identity', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(JSON.stringify(sealed(`w-other-${i}`, 'agent:default:other')));
  for (let i = 0; i < 40; i++) lines.push(JSON.stringify(sealed(`w-mine-${i}`, 'agent:default:me')));
  const file = trailOf(lines);
  const windowed = readReceiptHistory({ path: file, identityRef: 'agent:default:me', receiptWindow: 10 });
  assert.equal(windowed.length, 10);
  assert.ok(windowed.every(r => belongsToIdentity(r, 'agent:default:me')));
  assert.ok(windowed.every(hasValidReceiptHash));
  assert.equal(windowed.at(-1).receiptId, 'w-mine-39', 'the newest receipt is kept');
  assert.equal(windowed[0].receiptId, 'w-mine-30', 'the window reaches back over other identities');
  // The trail continues before the window, so the score's history was cut.
  assert.equal(windowed.truncated, true);
});

test('a window that covers the whole trail is not marked truncated', () => {
  const file = trailOf([JSON.stringify(sealed('w-1')), JSON.stringify(sealed('w-2'))]);
  const windowed = readReceiptHistory({ path: file, identityRef: 'agent:default:history-agent', receiptWindow: 10 });
  assert.equal(windowed.length, 2);
  assert.equal(windowed.truncated, false);
});

test('a window reads past a chunk boundary to fill N receipts', () => {
  const lines = [];
  for (let i = 0; i < 900; i++) lines.push(JSON.stringify(sealed(`w-big-${i}`)));
  const file = trailOf(lines);
  const windowed = readReceiptHistory({ path: file, identityRef: 'agent:default:history-agent', receiptWindow: 700 });
  assert.equal(windowed.length, 700);
  assert.equal(windowed.at(-1).receiptId, 'w-big-899');
  assert.equal(windowed[0].receiptId, 'w-big-200');
  assert.equal(windowed.truncated, true);
});

test('a tampered receipt does not consume a window slot', () => {
  const tampered = { ...sealed('w-good'), receiptId: 'w-bad', status: 'executed' };
  const file = trailOf([JSON.stringify(tampered), JSON.stringify(sealed('w-good-2')), JSON.stringify(sealed('w-good-3'))]);
  const windowed = readReceiptHistory({ path: file, identityRef: 'agent:default:history-agent', receiptWindow: 2 });
  assert.equal(windowed.length, 2);
  assert.equal(windowed[0].receiptId, 'w-good-2');
  assert.equal(windowed.truncated, false);
});

test('a tampered receipt inside the window stays visible but takes no slot', () => {
  const tampered = { ...sealed('w-in-1'), receiptId: 'w-in-bad', status: 'executed' };
  const file = trailOf([JSON.stringify(sealed('w-in-0')), JSON.stringify(tampered), JSON.stringify(sealed('w-in-2'))]);
  const windowed = readReceiptHistory({ path: file, identityRef: 'agent:default:history-agent', receiptWindow: 2 });
  assert.deepEqual(windowed.map(r => r.receiptId), ['w-in-0', 'w-in-bad', 'w-in-2']);
  assert.equal(windowed.filter(hasValidReceiptHash).length, 2);
  assert.equal(windowed.truncated, false);
});

test('a window without an identity reads the full bounded trail', () => {
  const file = trailOf([JSON.stringify(sealed('w-n1')), JSON.stringify(sealed('w-n2', 'agent:default:other'))]);
  const full = readReceiptHistory({ path: file, receiptWindow: 1 });
  assert.equal(full.length, 2);
});

test('caller-supplied receipts are windowed by the same rule', () => {
  const a = sealed('w-s1');
  const b = sealed('w-s2', 'agent:default:someone-else');
  const c = sealed('w-s3');
  const windowed = readReceiptHistory({ receipts: [a, b, c], identityRef: 'agent:default:history-agent', receiptWindow: 2 });
  assert.equal(windowed.length, 2);
  assert.equal(windowed[0].receiptId, 'w-s1');
  assert.equal(windowed[1].receiptId, 'w-s3');
  assert.equal(windowed.truncated, false);
});

test('a window over more caller-supplied receipts than the bound marks them truncated', () => {
  const receipt = sealed('w-many');
  const windowed = readReceiptHistory({
    receipts: Array(10_001).fill(receipt),
    identityRef: 'agent:default:history-agent',
    receiptWindow: 5,
  });
  assert.equal(windowed.length, 5);
  assert.equal(windowed.truncated, true);
});
