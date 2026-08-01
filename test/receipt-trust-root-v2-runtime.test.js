'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const Graph = require('../graph');
const { stableStringify, sha256Hex, buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const {
  buildCanonicalReceiptPayloadV2,
  classifyRawMaterializedReceipt,
  validateCanonicalReceiptV2,
} = require('../lib/receipt/canonical-receipt-v2');
const { appendReceiptToChain, validateReceiptChain } = require('../lib/receipt/receipt-chain');
const { exportReceiptBundle, verifyExportedBundle } = require('../lib/receipt/receipt-export');
const { readReceiptById } = require('../lib/receipt/receipt-read-index');
const {
  classifyReceiptFamily,
  validateV4Chain,
  V4_RECEIPT_ERROR_CODES,
} = require('../lib/receipt/v4-receipt-family');

const fixtureDir = path.join(__dirname, 'fixtures', 'receipt-trust-root');
const fixtures = fs.readdirSync(fixtureDir).filter((name) => name.endsWith('.json')).sort()
  .map((name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8')));
const byId = new Map(fixtures.map((fixture) => [fixture.caseId, fixture]));
const baseReceipt = byId.get('RTR-001-V1-CANONICAL-BYTES').input.receipt;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-rtr3-'));

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function v1(overrides = {}) {
  return buildCanonicalReceiptPayload({ ...structuredClone(baseReceipt), ...overrides }, { verdict: 'allow' });
}

function v2(trustRoot, overrides = {}) {
  return buildCanonicalReceiptPayloadV2({ ...structuredClone(baseReceipt), ...overrides }, { verdict: 'allow', trustRoot });
}

function materializedV2(trustRoot, overrides = {}) {
  return {
    ...structuredClone(baseReceipt),
    ...overrides,
    canonicalReceiptSchemaVersion: 'v4-receipt-v2',
    trustRoot,
  };
}

describe('RECEIPT-TRUST-ROOT-3 runtime foundation', () => {
  it('preserves the V1 golden payload and bundle bytes', () => {
    const fixture = byId.get('RTR-004-V1-BUNDLE-BYTES');
    const first = appendReceiptToChain(v1());
    const second = appendReceiptToChain(v1(fixture.input.successor), first.receiptHash);
    const bundle = exportReceiptBundle([first, second], { workspaceId: fixture.input.workspaceId, exportedAt: fixture.input.exportedAt });
    assert.equal(bundle.schemaVersion, 'v4-receipt-bundle-v1');
    assert.equal(Buffer.byteLength(stableStringify(bundle)), fixture.expected.bundleBytes);
    assert.equal(sha256Hex(stableStringify(bundle)), fixture.expected.bundleHash);
  });

  it('builds deterministic V2 payloads from explicit bounded trust roots only', () => {
    for (const root of ['local_operator', 'external_verified_client']) {
      const input = structuredClone(baseReceipt);
      input.trustRoot = root === 'local_operator' ? 'external_verified_client' : 'local_operator';
      input.metadata.trustRoot = input.trustRoot;
      const before = structuredClone(input);
      const first = buildCanonicalReceiptPayloadV2(input, { verdict: 'allow', trustRoot: root });
      const second = buildCanonicalReceiptPayloadV2(input, { verdict: 'allow', trustRoot: root });
      assert.deepEqual(first, second);
      assert.equal(first.trustRoot, root);
      assert.deepEqual(input, before);
      assert.deepEqual(validateCanonicalReceiptV2(first), { valid: true, reason: null });
    }
  });

  it('rejects malformed roots and exact-shape bypasses', () => {
    for (const root of byId.get('RTR-010-V2-INVALID-TRUST-ROOT-VARIANTS').input.trustRoots) {
      assert.throws(() => buildCanonicalReceiptPayloadV2(baseReceipt, { verdict: 'allow', trustRoot: root }), TypeError);
    }
    for (const mutate of [
      (payload) => { payload.unexpected = true; },
      (payload) => Object.defineProperty(payload, 'unexpected', { value: true, enumerable: false }),
      (payload) => Object.defineProperty(payload, Symbol('unknown'), { value: true, enumerable: false }),
      (payload) => Object.defineProperty(payload, 'trustRoot', { get: () => 'local_operator', enumerable: true }),
      (payload) => { payload.trustRoot = 'unknown'; },
      (payload) => { delete payload.trustRoot; },
    ]) {
      const payload = v2('local_operator');
      mutate(payload);
      assert.equal(validateCanonicalReceiptV2(payload).valid, false);
    }
  });

  it('classifies declared raw V2 without downgrade or inherited authority', () => {
    assert.equal(classifyRawMaterializedReceipt({ canonicalReceiptSchemaVersion: 'v4-receipt-v2', trustRoot: 'local_operator' }).kind, 'v2');
    assert.equal(classifyRawMaterializedReceipt({ canonicalReceiptSchemaVersion: 'v4-receipt-v2' }).kind, 'v2_invalid_trust_root');
    assert.equal(classifyRawMaterializedReceipt({ canonicalReceiptSchemaVersion: 'v4-receipt-v99' }).kind, 'unsupported_schema_version');
    assert.equal(classifyRawMaterializedReceipt(Object.create({ trustRoot: 'local_operator' }, {
      canonicalReceiptSchemaVersion: { value: 'v4-receipt-v2', enumerable: true },
    })).kind, 'v2_invalid_trust_root');
    const hidden = { canonicalReceiptSchemaVersion: 'v4-receipt-v2', trustRoot: 'local_operator' };
    Object.defineProperty(hidden, 'unexpected', { value: true, enumerable: false });
    assert.equal(classifyRawMaterializedReceipt(hidden).kind, 'v2_invalid_trust_root');
    const accessorDiscriminator = { trustRoot: 'local_operator' };
    Object.defineProperty(accessorDiscriminator, 'canonicalReceiptSchemaVersion', {
      get: () => 'v4-receipt-v2', enumerable: true,
    });
    assert.equal(classifyRawMaterializedReceipt(accessorDiscriminator).kind, 'unsupported_schema_version');
    const accessorRoot = { canonicalReceiptSchemaVersion: 'v4-receipt-v2' };
    Object.defineProperty(accessorRoot, 'trustRoot', { get: () => 'local_operator', enumerable: true });
    assert.equal(classifyRawMaterializedReceipt(accessorRoot).kind, 'v2_invalid_trust_root');
    assert.equal(classifyRawMaterializedReceipt({
      canonicalReceiptSchemaVersion: 'v4-receipt-v2',
      trustRoot: 'local_operator',
      metadata: { trustRoot: 'external_verified_client' },
    }).kind, 'v2_invalid_trust_root');
  });

  it('reads V2 roots, returns bounded causes, and preserves inputs', () => {
    const raw = materializedV2(byId.get('RTR-024-READ-V2-PRESERVES-ROOT').input.trustRoot);
    const event = { workspaceId: raw.workspaceId, details: { receipt: raw } };
    const before = structuredClone(event);
    const read = readReceiptById([event], raw.receiptId, { workspaceId: raw.workspaceId });
    assert.equal(read.ok, true);
    assert.equal(read.canonicalPayload.trustRoot, 'external_verified_client');
    assert.deepEqual(event, before);
    read.receipt.metadata.source = 'changed';
    assert.deepEqual(event, before);

    for (const [receipt, causeCode] of [
      [materializedV2(undefined), V4_RECEIPT_ERROR_CODES.INVALID_TRUST_ROOT],
      [{ ...structuredClone(baseReceipt), canonicalReceiptSchemaVersion: 'v4-receipt-v99' }, V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION],
    ]) {
      if (receipt.trustRoot === undefined) delete receipt.trustRoot;
      const failed = readReceiptById([{ workspaceId: receipt.workspaceId, details: { receipt } }], receipt.receiptId, { workspaceId: receipt.workspaceId });
      assert.deepEqual({ status: failed.status, code: failed.error.code, causeCode: failed.error.causeCode }, {
        status: 'invalid', code: 'INVALID_RECEIPT', causeCode,
      });
    }
  });

  it('rejects raw V2 descriptor and nested-authority bypasses before defensive cloning', () => {
    const cases = [];
    const hidden = materializedV2('local_operator');
    Object.defineProperty(hidden, 'unexpected', { value: true, enumerable: false });
    cases.push(hidden);
    const symbol = materializedV2('local_operator');
    Object.defineProperty(symbol, Symbol('unknown'), { value: true, enumerable: false });
    cases.push(symbol);
    const inherited = materializedV2(undefined);
    delete inherited.trustRoot;
    Object.setPrototypeOf(inherited, { trustRoot: 'local_operator' });
    cases.push(inherited);
    cases.push(materializedV2('local_operator', structuredClone(byId.get('RTR-011-V2-NESTED-TRUST-ROOT').input)));

    for (const [index, receipt] of cases.entries()) {
      const result = readReceiptById([{
        workspaceId: receipt.workspaceId,
        details: { receipt },
      }], receipt.receiptId, { workspaceId: receipt.workspaceId });
      assert.equal(result.ok, false, `case ${index}`);
      assert.equal(result.status, 'invalid', `case ${index}`);
      assert.equal(result.error.code, 'INVALID_RECEIPT', `case ${index}`);
      assert.equal(result.error.causeCode, V4_RECEIPT_ERROR_CODES.INVALID_TRUST_ROOT, `case ${index}`);
    }
  });

  it('validates V1 to V2 chronology without rewriting the predecessor', () => {
    const first = appendReceiptToChain(v1());
    const firstBefore = structuredClone(first);
    const second = appendReceiptToChain(v2('local_operator', { receiptId: 'receipt-fixed-002', admissionId: 'admission-fixed-002' }), first.receiptHash);
    const third = appendReceiptToChain(v2('external_verified_client', { receiptId: 'receipt-fixed-003', admissionId: 'admission-fixed-003' }), second.receiptHash);
    assert.equal(validateV4Chain([first, second, third]).valid, true);
    assert.deepEqual(first, firstBefore);
    const regressed = appendReceiptToChain(v1({ receiptId: 'receipt-fixed-004', admissionId: 'admission-fixed-004' }), third.receiptHash);
    assert.equal(validateV4Chain([first, second, third, regressed]).code, V4_RECEIPT_ERROR_CODES.CHAIN_VERSION_REGRESSION);
  });

  it('selects bundle V2 and rejects tamper, regression, and mixed families', () => {
    const first = appendReceiptToChain(v1());
    const second = appendReceiptToChain(v2('local_operator', { receiptId: 'receipt-fixed-002', admissionId: 'admission-fixed-002' }), first.receiptHash);
    const bundle = exportReceiptBundle([first, second], { exportedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(bundle.schemaVersion, 'v4-receipt-bundle-v2');
    assert.equal(verifyExportedBundle(bundle).valid, true);
    for (const mutate of [
      (copy) => { copy.schemaVersion = 'v4-receipt-bundle-v1'; },
      (copy) => { copy.receipts[1].trustRoot = 'unknown'; },
      (copy) => { copy.receipts.reverse(); },
      (copy) => { copy.receipts[0].reason = 'rewritten'; },
      (copy) => Object.defineProperty(copy.receipts[1], 'unexpected', { value: true, enumerable: false }),
      (copy) => Object.defineProperty(copy.receipts[1], 'trustRoot', { get: () => 'local_operator', enumerable: true }),
    ]) {
      const copy = structuredClone(bundle);
      mutate(copy);
      assert.equal(verifyExportedBundle(copy).valid, false);
    }
    assert.throws(() => exportReceiptBundle([first, { version: 'reviewed-external-graph-receipt-v1' }]),
      (error) => error.code === V4_RECEIPT_ERROR_CODES.BUNDLE_MIXED_FAMILY);
  });

  it('rejects durable V2 writes and rolls back every observable state', () => {
    const graph = new Graph({
      memoryPath: path.join(tempRoot, 'rollback.json'),
      dbPath: path.join(tempRoot, 'rollback.db'),
      useSQLite: true,
    });
    assert.throws(() => graph.runMutationOnce('rtr3-v2-write', () => {
      graph.addNode('blocked', 'Blocked', null, { workspaceId: 'w' });
      return { changed: true };
    }, { buildCanonicalReceipt: () => v2('local_operator', { workspaceId: 'w' }) }),
    (error) => error.code === V4_RECEIPT_ERROR_CODES.WRITE_NOT_ENABLED);
    assert.equal(graph.getNode('blocked', 'w'), null);
    assert.equal(graph.getCommittedMutationReceiptByOperation('rtr3-v2-write'), null);
    const retry = graph.runMutationOnce('rtr3-v2-write', () => ({ changed: false }));
    assert.equal(retry.replayed, false);
    graph.close();
  });

  it('executes every future-V2 fixture through its owning runtime boundary', () => {
    const exercised = new Set();
    const exercise = (id, assertion) => {
      const fixture = byId.get(id);
      assert.ok(fixture, id);
      assertion(fixture);
      exercised.add(id);
    };
    const makeTransition = () => {
      const first = appendReceiptToChain(v1());
      const second = appendReceiptToChain(v2('local_operator', { receiptId: 'receipt-fixed-002', admissionId: 'admission-fixed-002' }), first.receiptHash);
      const third = appendReceiptToChain(v2('external_verified_client', { receiptId: 'receipt-fixed-003', admissionId: 'admission-fixed-003' }), second.receiptHash);
      return [first, second, third];
    };

    for (const id of ['RTR-007-V2-LOCAL-OPERATOR', 'RTR-008-V2-EXTERNAL-VERIFIED-CLIENT']) {
      exercise(id, ({ input, expected }) => {
        const payload = v2(input.trustRoot);
        assert.equal(validateCanonicalReceiptV2(payload).valid, expected.valid);
        assert.equal(payload.trustRoot, input.trustRoot);
      });
    }
    exercise('RTR-009-V2-MISSING-TRUST-ROOT', ({ input, expected }) => {
      assert.equal(validateCanonicalReceiptV2(input).valid, expected.valid);
    });
    exercise('RTR-010-V2-INVALID-TRUST-ROOT-VARIANTS', ({ input, expected }) => {
      assert.equal(input.trustRoots.every((root) => {
        const payload = v2('local_operator');
        payload.trustRoot = root;
        return !validateCanonicalReceiptV2(payload).valid;
      }), expected.allInvalid);
    });
    exercise('RTR-011-V2-NESTED-TRUST-ROOT', ({ input, expected }) => {
      assert.equal(classifyRawMaterializedReceipt({
        canonicalReceiptSchemaVersion: 'v4-receipt-v2',
        trustRoot: 'local_operator',
        metadata: input.metadata,
      }).kind === 'v2', expected.valid);
    });
    exercise('RTR-012-V2-UNKNOWN-TOP-LEVEL', ({ input, expected }) => {
      assert.equal(validateCanonicalReceiptV2({ ...v2(input.trustRoot), unexpected: input.unexpected }).valid, expected.valid);
    });
    exercise('RTR-013-V2-RAW-DISCRIMINATOR', ({ input, expected }) => {
      assert.equal(classifyRawMaterializedReceipt(input).kind === 'v2', expected.valid);
    });
    exercise('RTR-014-V2-DECLARED-MISSING-TRUST-ROOT', ({ input, expected }) => {
      assert.equal(classifyRawMaterializedReceipt(input).kind === 'v2', expected.valid);
    });
    exercise('RTR-015-V2-UNKNOWN-RAW-DISCRIMINATOR', ({ input, expected }) => {
      assert.equal(classifyRawMaterializedReceipt(input).kind === 'v2', expected.valid);
    });
    exercise('RTR-017-V1-V2-CHAIN-TRANSITION', ({ input, expected }) => {
      const chain = makeTransition();
      assert.deepEqual(chain.map(({ schemaVersion }) => schemaVersion), input.versions);
      assert.equal(validateV4Chain(chain).valid, expected.valid);
    });
    exercise('RTR-018-V1-V2-NO-PREDECESSOR-REHASH', ({ expected }) => {
      const chain = makeTransition();
      const before = structuredClone(chain[0]);
      validateV4Chain(chain);
      assert.equal(stableStringify(chain[0]) === stableStringify(before), expected.preservePredecessor);
    });
    exercise('RTR-019-V4-CHAIN-TAMPER-VARIANTS', ({ input, expected }) => {
      const invalid = input.variants.map((variant) => {
        const chain = makeTransition().map((record) => ({ ...record }));
        if (variant === 'reordered') [chain[0], chain[1]] = [chain[1], chain[0]];
        if (variant === 'inserted') chain.splice(1, 0, appendReceiptToChain(v2('local_operator', { receiptId: 'inserted', admissionId: 'inserted' }), chain[0].receiptHash));
        if (variant === 'removed') chain.splice(1, 1);
        if (variant === 'downgraded') chain[1].schemaVersion = 'v4-receipt-v1';
        if (variant === 'rewritten') chain[1].reason = 'rewritten';
        return !validateV4Chain(chain).valid;
      });
      assert.equal(invalid.every(Boolean), expected.allInvalid);
    });
    exercise('RTR-020-V2-INVALID-SCHEMA-OR-ROOT', ({ input, expected }) => {
      const payload = v2('local_operator');
      payload.schemaVersion = input.schemaVersion;
      payload.trustRoot = input.trustRoot;
      assert.equal(validateV4Chain([appendReceiptToChain(payload)]).valid, expected.valid);
    });
    exercise('RTR-021-GENERIC-JOURNAL-NON-V4-VALID', ({ input, expected }) => {
      const generic = appendReceiptToChain({ version: input.family, receiptId: 'generic' });
      assert.equal(validateReceiptChain([generic]).valid, expected.preserved);
    });
    exercise('RTR-022-V4-DOES-NOT-RELABEL-NON-V4', ({ input, expected }) => {
      assert.equal(classifyReceiptFamily({ version: input.family }) === 'v4', expected.relabel);
    });
    exercise('RTR-024-READ-V2-PRESERVES-ROOT', ({ input, expected }) => {
      const receipt = materializedV2(input.trustRoot);
      const read = readReceiptById([{ workspaceId: receipt.workspaceId, details: { receipt } }], receipt.receiptId);
      assert.equal(read.canonicalPayload.trustRoot, expected.trustRoot);
    });
    exercise('RTR-026-READ-UNSUPPORTED-VERSION', ({ input, expected }) => {
      const receipt = { ...structuredClone(baseReceipt), ...input };
      const read = readReceiptById([{ workspaceId: receipt.workspaceId, details: { receipt } }], receipt.receiptId);
      assert.equal(read.ok, expected.valid);
      assert.equal(read.error.causeCode, V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION);
    });
    exercise('RTR-028-EXPORT-V2-VERSION-SELECTION', ({ input, expected }) => {
      const bundle = exportReceiptBundle(makeTransition().slice(0, input.receiptVersions.length), { exportedAt: '2026-01-01T00:00:00.000Z' });
      assert.equal(bundle.schemaVersion, expected.schemaVersion);
    });
    exercise('RTR-029-EXPORT-V2-VERIFY-STRUCTURE', ({ input, expected }) => {
      const bundle = exportReceiptBundle(makeTransition(), { exportedAt: '2026-01-01T00:00:00.000Z' });
      const verification = verifyExportedBundle(bundle);
      assert.equal(input.checks.length === 4 && verification.bundleVersionValid && verification.bundleHashValid && verification.chainValidation.valid, expected.allRequired);
    });
    exercise('RTR-030-EXPORT-V2-TAMPER-VARIANTS', ({ input, expected }) => {
      const base = exportReceiptBundle(makeTransition(), { exportedAt: '2026-01-01T00:00:00.000Z' });
      const invalid = input.variants.map((variant) => {
        const bundle = structuredClone(base);
        if (variant === 'versionMismatch') bundle.schemaVersion = 'v4-receipt-bundle-v1';
        if (variant === 'invalidTrustRoot') bundle.receipts[1].trustRoot = 'unknown';
        if (variant === 'arrayTamper') bundle.receipts[1].reason = 'tampered';
        if (variant === 'reorder') bundle.receipts.reverse();
        if (variant === 'v1Rewrite') bundle.receipts[0].reason = 'rewritten';
        return !verifyExportedBundle(bundle).valid;
      });
      assert.equal(invalid.every(Boolean), expected.allInvalid);
    });
    exercise('RTR-032-EXPORT-CROSS-FAMILY-OUT-OF-SCOPE', ({ input, expected }) => {
      assert.equal(input.families.length, 2);
      assert.throws(
        () => exportReceiptBundle([makeTransition()[0], { version: 'reviewed-external-graph' }]),
        (error) => error.code === V4_RECEIPT_ERROR_CODES.BUNDLE_MIXED_FAMILY,
      );
      assert.equal(expected.outOfScope, true);
    });
    exercise('RTR-033-V2-DETERMINISM', ({ input, expected }) => {
      const first = buildCanonicalReceiptPayloadV2(baseReceipt, { verdict: 'allow', trustRoot: input.trustRoot });
      const second = buildCanonicalReceiptPayloadV2(baseReceipt, { verdict: 'allow', trustRoot: input.trustRoot });
      assert.equal(stableStringify(first) === stableStringify(second), expected.deterministic);
    });

    const expectedIds = fixtures.filter(({ expected }) => expected.mode === 'futureV2Structural').map(({ caseId }) => caseId);
    assert.deepEqual([...exercised].sort(), expectedIds.sort());
  });
});
