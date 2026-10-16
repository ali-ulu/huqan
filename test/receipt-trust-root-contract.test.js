'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildCanonicalReceiptPayload,
  hashCanonicalReceiptPayload,
  stableStringify,
  sha256Hex,
} = require('../lib/receipt/canonical-receipt');
const { appendReceiptToChain, validateReceiptChain } = require('../lib/receipt/receipt-chain');
const { exportReceiptBundle, verifyExportedBundle } = require('../lib/receipt/receipt-export');
const { readReceiptById } = require('../lib/receipt/receipt-read-index');

const fixtureDir = path.join(__dirname, 'fixtures', 'receipt-trust-root');
const files = fs.readdirSync(fixtureDir).filter((name) => name.endsWith('.json')).sort();
const fixtures = files.map((name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8')));
const byId = new Map(fixtures.map((fixture) => [fixture.caseId, fixture]));
const fixture1 = byId.get('RTR-001-V1-CANONICAL-BYTES');

function buildV1(overrides = {}) {
  return buildCanonicalReceiptPayload({ ...structuredClone(fixture1.input.receipt), ...overrides }, { verdict: 'allow' });
}

function buildChain(input = byId.get('RTR-003-V1-CHAIN-LINKAGE').input) {
  const firstPayload = buildCanonicalReceiptPayload(structuredClone(input.receipt), { verdict: input.verdict });
  const first = appendReceiptToChain(firstPayload);
  const secondPayload = buildCanonicalReceiptPayload({ ...structuredClone(input.receipt), ...input.successor }, { verdict: input.verdict });
  const second = appendReceiptToChain(secondPayload, first.receiptHash);
  return [first, second];
}

describe('receipt trust-root fixture corpus', () => {
  it('contains the exact 35 unique, bounded fixtures', () => {
    assert.equal(files.length, 35);
    assert.equal(new Set(files).size, 35);
    assert.equal(new Set(fixtures.map(({ caseId }) => caseId)).size, 35);
    assert.deepEqual(fixtures.map(({ caseId }) => caseId), Array.from({ length: 35 }, (_, i) => `RTR-${String(i + 1).padStart(3, '0')}-${[
      'V1-CANONICAL-BYTES','V1-CANONICAL-HASH','V1-CHAIN-LINKAGE','V1-BUNDLE-BYTES','V1-RAW-LEGACY-PROJECTION','V1-LEGACY-PRESENTATION-ONLY','V2-LOCAL-OPERATOR','V2-EXTERNAL-VERIFIED-CLIENT','V2-MISSING-TRUST-ROOT','V2-INVALID-TRUST-ROOT-VARIANTS','V2-NESTED-TRUST-ROOT','V2-UNKNOWN-TOP-LEVEL','V2-RAW-DISCRIMINATOR','V2-DECLARED-MISSING-TRUST-ROOT','V2-UNKNOWN-RAW-DISCRIMINATOR','V1-CHAIN-HISTORICAL','V1-V2-CHAIN-TRANSITION','V1-V2-NO-PREDECESSOR-REHASH','V4-CHAIN-TAMPER-VARIANTS','V2-INVALID-SCHEMA-OR-ROOT','GENERIC-JOURNAL-NON-V4-VALID','V4-DOES-NOT-RELABEL-NON-V4','READ-V1-NO-FABRICATED-ROOT','READ-V2-PRESERVES-ROOT','READ-INPUT-IMMUTABILITY','READ-UNSUPPORTED-VERSION','EXPORT-V1-BUNDLE-BYTES','EXPORT-V2-VERSION-SELECTION','EXPORT-V2-VERIFY-STRUCTURE','EXPORT-V2-TAMPER-VARIANTS','EXPORT-NO-ARTIFACT-REGENERATION','EXPORT-CROSS-FAMILY-OUT-OF-SCOPE','V2-DETERMINISM','BUILD-INPUT-IMMUTABILITY','READ-DEFENSIVE-COPY'][i]}`));
    for (const fixture of fixtures) {
      assert.deepEqual(Object.keys(fixture), ['caseId', 'description', 'input', 'expected', 'nonClaims']);
      assert.ok(['currentV1Runtime', 'futureV2Structural'].includes(fixture.expected.mode));
    }
  });

  it('contains no credential, private-key, endpoint, or provider material', () => {
    const corpus = stableStringify(fixtures);
    for (const forbidden of ['private_key', 'privatekey', 'credential', 'token', 'networkendpoint', 'provider', 'begin private key']) {
      assert.equal(corpus.toLowerCase().includes(forbidden), false, forbidden);
    }
  });

  it('locks current V1 canonical bytes and hash', () => {
    const payload = buildV1();
    assert.equal(Buffer.byteLength(stableStringify(payload)), fixture1.expected.payloadBytes);
    assert.equal(hashCanonicalReceiptPayload(payload), byId.get('RTR-002-V1-CANONICAL-HASH').expected.payloadHash);
    assert.equal(payload.schemaVersion, 'v4-receipt-v1');
    assert.equal(Object.hasOwn(payload, 'trustRoot'), false);
  });

  it('locks current V1 chain linkage and bundle bytes', () => {
    const chain = buildChain();
    const chainExpected = byId.get('RTR-003-V1-CHAIN-LINKAGE').expected;
    assert.deepEqual(chain.map(({ receiptHash }) => receiptHash), [chainExpected.firstHash, chainExpected.secondHash]);
    assert.deepEqual(validateReceiptChain(chain), { valid: true, brokenAt: null, reason: null });
    const fixture = byId.get('RTR-004-V1-BUNDLE-BYTES');
    const bundle = exportReceiptBundle(chain, { workspaceId: 'workspace-fixed', exportedAt: fixture.input.exportedAt });
    assert.equal(bundle.schemaVersion, 'v4-receipt-bundle-v1');
    assert.equal(Buffer.byteLength(stableStringify(bundle)), fixture.expected.bundleBytes);
    assert.equal(sha256Hex(stableStringify(bundle)), fixture.expected.bundleHash);
    assert.equal(verifyExportedBundle(structuredClone(bundle)).valid, true);
  });

  it('locks V1 build and read defensive-copy boundaries', () => {
    const raw = structuredClone(fixture1.input.receipt);
    const payload = buildCanonicalReceiptPayload(raw, { verdict: 'allow' });
    raw.metadata.source = 'changed';
    assert.equal(payload.metadata.source, 'synthetic-fixture');

    const event = { workspaceId: raw.workspaceId, details: { receipt: structuredClone(fixture1.input.receipt) } };
    const before = structuredClone(event);
    const read = readReceiptById([event], raw.receiptId, { workspaceId: raw.workspaceId });
    assert.equal(read.ok, true);
    assert.deepEqual(event, before);
    read.receipt.metadata.source = 'changed-after-read';
    assert.equal(event.details.receipt.metadata.source, 'synthetic-fixture');
    assert.equal(Object.hasOwn(read.canonicalPayload, 'trustRoot'), false);
  });

  it('locks future V2 cases as structural contracts without calling absent runtime APIs', () => {
    const future = fixtures.filter(({ expected }) => expected.mode === 'futureV2Structural');
    assert.equal(future.length, 22);
    const allowedRoots = new Set(['local_operator', 'external_verified_client']);
    assert.equal(allowedRoots.has(byId.get('RTR-007-V2-LOCAL-OPERATOR').input.trustRoot), true);
    assert.equal(allowedRoots.has(byId.get('RTR-008-V2-EXTERNAL-VERIFIED-CLIENT').input.trustRoot), true);
    assert.equal(Object.hasOwn(byId.get('RTR-009-V2-MISSING-TRUST-ROOT').input, 'trustRoot'), false);
    assert.equal(byId.get('RTR-011-V2-NESTED-TRUST-ROOT').expected.valid, false);
    assert.equal(byId.get('RTR-012-V2-UNKNOWN-TOP-LEVEL').expected.valid, false);
    assert.equal(byId.get('RTR-013-V2-RAW-DISCRIMINATOR').input.canonicalReceiptSchemaVersion, 'v4-receipt-v2');
    assert.equal(byId.get('RTR-014-V2-DECLARED-MISSING-TRUST-ROOT').expected.downgrade, false);
    assert.equal(byId.get('RTR-021-GENERIC-JOURNAL-NON-V4-VALID').expected.preserved, true);
    assert.equal(byId.get('RTR-032-EXPORT-CROSS-FAMILY-OUT-OF-SCOPE').expected.outOfScope, true);
  });

  it('directly validates every fixture claim without cross-fixture input dependencies', () => {
    const checked = new Set();
    const allowedRoots = new Set(['local_operator', 'external_verified_client']);
    for (const fixture of fixtures) {
      assert.equal(Object.hasOwn(fixture.input, 'fixtureRef'), false, fixture.caseId);
      checked.add(fixture.caseId);
      const { input, expected } = fixture;
      switch (fixture.caseId) {
        case 'RTR-001-V1-CANONICAL-BYTES':
          assert.equal(Buffer.byteLength(stableStringify(buildCanonicalReceiptPayload(input.receipt, { verdict: input.verdict }))), expected.payloadBytes); break;
        case 'RTR-002-V1-CANONICAL-HASH':
          assert.equal(hashCanonicalReceiptPayload(buildCanonicalReceiptPayload(input.receipt, { verdict: input.verdict })), expected.payloadHash); break;
        case 'RTR-003-V1-CHAIN-LINKAGE':
          assert.deepEqual(buildChain(input).map((record) => record.receiptHash), [expected.firstHash, expected.secondHash]); break;
        case 'RTR-004-V1-BUNDLE-BYTES': {
          const bundle = exportReceiptBundle(buildChain(input), { workspaceId: input.workspaceId, exportedAt: input.exportedAt });
          assert.equal(Buffer.byteLength(stableStringify(bundle)), expected.bundleBytes);
          assert.equal(sha256Hex(stableStringify(bundle)), expected.bundleHash); break;
        }
        case 'RTR-005-V1-RAW-LEGACY-PROJECTION':
        case 'RTR-023-READ-V1-NO-FABRICATED-ROOT': {
          const payload = buildCanonicalReceiptPayload(input.receipt, { verdict: input.verdict });
          if (expected.schemaVersion) assert.equal(payload.schemaVersion, expected.schemaVersion);
          assert.equal(Object.hasOwn(payload, 'trustRoot'), !expected.trustRootAbsent); break;
        }
        case 'RTR-006-V1-LEGACY-PRESENTATION-ONLY':
          assert.equal(input.label, 'legacy_v1_unspecified'); assert.equal(expected.canonicalFieldAbsent, 'trustRoot'); break;
        case 'RTR-007-V2-LOCAL-OPERATOR':
        case 'RTR-008-V2-EXTERNAL-VERIFIED-CLIENT':
          assert.equal(input.schemaVersion, 'v4-receipt-v2'); assert.equal(allowedRoots.has(input.trustRoot), true); assert.equal(expected.valid, true); break;
        case 'RTR-009-V2-MISSING-TRUST-ROOT':
          assert.equal(Object.hasOwn(input, 'trustRoot'), false); assert.equal(expected.valid, false); break;
        case 'RTR-010-V2-INVALID-TRUST-ROOT-VARIANTS':
          assert.equal(input.trustRoots.every((root) => !allowedRoots.has(root)), true); assert.equal(expected.allInvalid, true); break;
        case 'RTR-011-V2-NESTED-TRUST-ROOT':
          assert.equal(Object.hasOwn(input, 'trustRoot'), false); assert.equal(input.metadata.trustRoot, 'local_operator'); assert.equal(expected.valid, false); break;
        case 'RTR-012-V2-UNKNOWN-TOP-LEVEL':
          assert.equal(input.unexpected, true); assert.equal(expected.valid, false); break;
        case 'RTR-013-V2-RAW-DISCRIMINATOR':
          assert.equal(input.canonicalReceiptSchemaVersion, 'v4-receipt-v2'); assert.equal(allowedRoots.has(input.trustRoot), expected.valid); break;
        case 'RTR-014-V2-DECLARED-MISSING-TRUST-ROOT':
          assert.equal(Object.hasOwn(input, 'trustRoot'), false); assert.equal(expected.valid, false); assert.equal(expected.downgrade, false); break;
        case 'RTR-015-V2-UNKNOWN-RAW-DISCRIMINATOR':
        case 'RTR-026-READ-UNSUPPORTED-VERSION':
          assert.equal(input.canonicalReceiptSchemaVersion, 'v4-receipt-v99'); assert.equal(expected.valid, false); break;
        case 'RTR-016-V1-CHAIN-HISTORICAL':
          assert.equal(input.records[1].previousReceiptHash, input.records[0].receiptHash); assert.equal(validateReceiptChain(buildChain()).valid, expected.valid); break;
        case 'RTR-017-V1-V2-CHAIN-TRANSITION':
          assert.deepEqual(input.versions, ['v4-receipt-v1', 'v4-receipt-v2', 'v4-receipt-v2']); assert.equal(expected.valid, true); break;
        case 'RTR-018-V1-V2-NO-PREDECESSOR-REHASH':
          assert.equal(input.predecessorSchemaVersion, 'v4-receipt-v1'); assert.equal(expected.preservePredecessor, true); break;
        case 'RTR-019-V4-CHAIN-TAMPER-VARIANTS':
          assert.deepEqual(input.variants, ['reordered', 'inserted', 'removed', 'downgraded', 'rewritten']); assert.equal(expected.allInvalid, true); break;
        case 'RTR-020-V2-INVALID-SCHEMA-OR-ROOT':
          assert.equal(input.genericHashValid, true); assert.equal(allowedRoots.has(input.trustRoot), false); assert.equal(expected.valid, false); break;
        case 'RTR-021-GENERIC-JOURNAL-NON-V4-VALID':
          assert.equal(input.family, 'reviewed-external-graph'); assert.equal(input.genericChainValid, true); assert.equal(expected.preserved, true); break;
        case 'RTR-022-V4-DOES-NOT-RELABEL-NON-V4':
          assert.equal(input.family, 'reviewed-external-graph'); assert.equal(expected.relabel, false); break;
        case 'RTR-024-READ-V2-PRESERVES-ROOT':
          assert.equal(input.trustRoot, expected.trustRoot); assert.equal(allowedRoots.has(expected.trustRoot), true); break;
        case 'RTR-025-READ-INPUT-IMMUTABILITY':
        case 'RTR-035-READ-DEFENSIVE-COPY': {
          const event = { workspaceId: input.receipt.workspaceId, details: { receipt: structuredClone(input.receipt) } };
          const before = structuredClone(event); const read = readReceiptById([event], input.receipt.receiptId, { workspaceId: input.receipt.workspaceId });
          assert.deepEqual(event, before); read.receipt.metadata.source = 'mutated'; assert.deepEqual(event, before);
          assert.equal(fixture.caseId === 'RTR-025-READ-INPUT-IMMUTABILITY' ? expected.inputUnchanged : expected.defensiveCopy, true); break;
        }
        case 'RTR-027-EXPORT-V1-BUNDLE-BYTES':
          assert.equal(exportReceiptBundle([appendReceiptToChain(buildCanonicalReceiptPayload(input.receipt, { verdict: input.verdict }))], { exportedAt: input.exportedAt }).schemaVersion, expected.schemaVersion); break;
        case 'RTR-028-EXPORT-V2-VERSION-SELECTION':
          assert.equal(input.receiptVersions.includes('v4-receipt-v2'), true); assert.equal(expected.schemaVersion, 'v4-receipt-bundle-v2'); break;
        case 'RTR-029-EXPORT-V2-VERIFY-STRUCTURE':
          assert.deepEqual(input.checks, ['outerVersion', 'receiptVersions', 'receiptArrayHash', 'chainLinkage']); assert.equal(expected.allRequired, true); break;
        case 'RTR-030-EXPORT-V2-TAMPER-VARIANTS':
          assert.equal(input.variants.length, 5); assert.equal(expected.allInvalid, true); break;
        case 'RTR-031-EXPORT-NO-ARTIFACT-REGENERATION': {
          const chain = [appendReceiptToChain(buildCanonicalReceiptPayload(input.receipt, { verdict: input.verdict }))];
          const options = { exportedAt: input.exportedAt }; assert.deepEqual(exportReceiptBundle(chain, options), exportReceiptBundle(chain, options));
          assert.equal(expected.deterministicFreshExport, true); break;
        }
        case 'RTR-032-EXPORT-CROSS-FAMILY-OUT-OF-SCOPE':
          assert.deepEqual(input.families, ['v4', 'reviewed-external-graph']); assert.equal(expected.outOfScope, true); break;
        case 'RTR-033-V2-DETERMINISM':
          assert.equal(input.schemaVersion, 'v4-receipt-v2'); assert.equal(allowedRoots.has(input.trustRoot), true); assert.equal(expected.deterministic, true); break;
        case 'RTR-034-BUILD-INPUT-IMMUTABILITY': {
          const raw = structuredClone(input.receipt); const payload = buildCanonicalReceiptPayload(raw, { verdict: input.verdict }); raw.metadata.source = 'changed';
          assert.equal(payload.metadata.source, 'synthetic-fixture'); assert.equal(expected.payloadUnchanged, true); break;
        }
        default: assert.fail(`unhandled fixture: ${fixture.caseId}`);
      }
    }
    assert.equal(checked.size, 35);
  });
});
