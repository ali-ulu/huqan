'use strict';

/**
 * C2 — a Trust Receipt for a target with no evidence reported confidence 0.5.
 *
 * Every other field of that receipt told the truth: `status: 'unknown'`,
 * `provenance: null`, `canonical: false`, `auditTrail: []`, empty claim and
 * targetType. `confidence` was the one field that published a number nobody
 * measured, inside the artifact whose entire purpose is to say what the
 * evidence supports.
 *
 * 0.5 was also the worst available invented number. `lib/risk-rules.js`
 * separates "verified" from "too weak to treat as truth" at `>= 0.5` and
 * defaults an absent confidence to 0 for exactly this reason -- so a receipt
 * for a target that does not exist cleared this repo's own trust bar.
 *
 * What is deliberately NOT changed here: the read still succeeds. `unknown` is
 * a member of the published TRUST_STATUSES enum precisely so an evidence
 * package can report "I looked and found nothing", and HUQAN's read convention
 * is `ok: true` plus a structural flag -- `kernel.ask` answers a missing
 * subject that way. `lib/http/receipt-read-failures.js` ("never 200") governs
 * fetching a receipt *by id*, a resource that exists or does not; building one
 * over a target is a query, and importing that precedent would turn "no
 * evidence" into an error.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const { buildTrustReceipt } = require('../lib/provenance-query');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-trust-absent-'));

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function populatedKernel(label) {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${label}.json`),
  });
  kernel.learn('kedi hayvandir', {
    provenance: {
      provenanceId: 'prov-001',
      sourceRef: 'docs/claim.md#1',
      sourceType: 'document',
      actor: 'builder',
      timestamp: '2026-06-02T00:00:00Z',
      confidence: 0.88,
      workspaceId: 'workspace-a',
      trustPolicyVersion: '0.8.0',
    },
    admissionRequired: true,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: `apr-${label}`,
  });
  return kernel;
}

test('a receipt with no evidence behind it reports no confidence', () => {
  const kernel = populatedKernel('absent');
  const receipt = buildTrustReceipt(
    { targetId: 'boyle-bir-hedef-yok', workspaceId: 'workspace-a' },
    { target: kernel.graph },
  );

  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.provenance, null);
  assert.equal(receipt.canonical, false);
  assert.equal(receipt.confidence, 0,
    'there is nothing here to be confident about');
  assert.equal(receipt.confidence >= 0.5, false,
    'and it must not clear the threshold this repo treats as verified');
});

test('a workspace the target does not live in is the same absence', () => {
  const kernel = populatedKernel('wrong-workspace');
  const receipt = buildTrustReceipt(
    { targetId: 'kedi', workspaceId: 'baska-workspace' },
    { target: kernel.graph },
  );

  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.confidence, 0,
    'cross-workspace absence must not borrow the other workspace\'s confidence');
});

test('a real target still reports its recorded confidence, untouched', () => {
  const kernel = populatedKernel('present');
  const receipt = buildTrustReceipt(
    { targetId: 'kedi', workspaceId: 'workspace-a' },
    { target: kernel.graph },
  );

  assert.equal(receipt.status, 'canonical');
  assert.equal(receipt.canonical, true);
  assert.equal(receipt.confidence, 0.88,
    'the recorded value, not a floor and not a default');
});

/**
 * The zero is keyed off `status === 'unknown'`, which `deriveTrustStatus`
 * reaches only when there is no canonical record, no candidate claim and no
 * provenance record. A record that exists but recorded no confidence of its
 * own is a different state -- there is something to be confident about, it
 * just did not say how much -- and it must not collapse to 0, which would
 * claim certainty that the evidence is worthless.
 *
 * (Ingest assigns such a record a source-type default well above zero rather
 * than leaving it for the `?? 0.5` fallback here; what this pins is that
 * presence never reads as absence, not the specific number.)
 */
test('a record that exists without a recorded confidence does not read as absence', () => {
  const kernel = populatedKernel('no-recorded-confidence');
  kernel.learn('kopek hayvandir', {
    provenance: {
      provenanceId: 'prov-002',
      sourceRef: 'docs/claim.md#2',
      sourceType: 'document',
      actor: 'builder',
      timestamp: '2026-06-02T00:00:00Z',
      workspaceId: 'workspace-a',
      trustPolicyVersion: '0.8.0',
    },
    admissionRequired: true,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: 'apr-no-recorded-confidence',
  });

  const receipt = buildTrustReceipt(
    { targetId: 'kopek', workspaceId: 'workspace-a' },
    { target: kernel.graph },
  );

  assert.notEqual(receipt.status, 'unknown', 'the record is there');
  assert.notEqual(receipt.confidence, 0,
    'an unmeasured confidence on a present record is not the same as no record');
  assert.ok(receipt.confidence > 0 && receipt.confidence <= 1);
});

test('the receipt still satisfies the published schema shape', () => {
  const kernel = populatedKernel('schema');
  const receipt = buildTrustReceipt(
    { targetId: 'yok', workspaceId: 'workspace-a' },
    { target: kernel.graph },
  );

  // specs/axiom-trust-protocol/0.1 requires confidence: number in [0, 1], so
  // absence cannot be expressed by omitting it or sending null.
  assert.equal(typeof receipt.confidence, 'number');
  assert.ok(receipt.confidence >= 0 && receipt.confidence <= 1);
  assert.ok(receipt.receiptId, 'still a citable, generated-at-read-time artifact');
  assert.ok(receipt.generatedAt);
});
