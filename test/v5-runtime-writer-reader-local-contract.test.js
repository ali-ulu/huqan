const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { writeRuntimePackage } = require('../lib/v5/runtime-writer');
const { readRuntimePackage } = require('../lib/v5/runtime-reader');

function makeWriterInput(overrides = {}) {
  return {
    schemaVersion: 'v5.shared_trust_package.writer_input.v1',
    packageId: 'local-contract-package-001',
    issuer: {
      agentId: 'agent.local.contract',
      workspaceId: 'workspace.local.contract'
    },
    subject: {
      type: 'agent_action',
      id: 'action.local.contract.001'
    },
    verdict: {
      status: 'review',
      reason: 'local_contract_test'
    },
    routeReceipt: {
      routeId: 'route.local.contract.001',
      decisionPath: ['writer_helper', 'local_reader']
    },
    reasoning: {
      summary: 'Local contract test metadata.',
      inputsReviewed: ['local_fixture'],
      modelGenerated: false
    },
    provenance: {
      traceId: 'trace.local.contract.001',
      source: 'local_test'
    },
    nonClaims: [
      'local_in_memory_only',
      'no_runtime_exchange',
      'no_transport',
      'no_persistence',
      'no_signing',
      'no_verification'
    ],
    ...overrides
  };
}

test('writer output is readable by the reader as a local in-memory candidate', () => {
  const writerResult = writeRuntimePackage(makeWriterInput());

  assert.equal(writerResult.ok, true);
  assert.equal(writerResult.verdict, 'ACCEPT');

  const readerResult = readRuntimePackage(writerResult.package);

  assert.equal(readerResult.ok, true);
  assert.equal(readerResult.status, 'readable');
  assert.equal(readerResult.reason_category, 'valid_route_receipt_metadata');
  assert.deepEqual(readerResult.package, writerResult.package);
});

test('local writer-to-reader handoff preserves metadata and nonClaims exactly', () => {
  const input = makeWriterInput();
  const writerResult = writeRuntimePackage(input);
  const readerResult = readRuntimePackage(writerResult.package);

  assert.deepEqual(readerResult.package.issuer, input.issuer);
  assert.deepEqual(readerResult.package.subject, input.subject);
  assert.deepEqual(readerResult.package.verdict, input.verdict);
  assert.deepEqual(readerResult.package.routeReceipt, input.routeReceipt);
  assert.deepEqual(readerResult.package.reasoning, input.reasoning);
  assert.deepEqual(readerResult.package.provenance, input.provenance);
  assert.deepEqual(readerResult.package.nonClaims, input.nonClaims);
});

test('local writer-to-reader handoff is deterministic and does not mutate input', () => {
  const input = makeWriterInput();
  const before = JSON.parse(JSON.stringify(input));

  const first = readRuntimePackage(writeRuntimePackage(input).package);
  const second = readRuntimePackage(writeRuntimePackage(input).package);

  assert.deepEqual(second, first);
  assert.deepEqual(input, before);
});

test('reader fails closed for invalid local candidates in the handoff path', () => {
  const missingPackageId = makeWriterInput({ packageId: undefined });
  const unsupportedClaim = makeWriterInput({
    claims: { runtimeReaderImplemented: true }
  });

  const missingResult = readRuntimePackage(missingPackageId);
  const claimResult = readRuntimePackage(unsupportedClaim);

  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.status, 'missing_required_field');
  assert.equal(missingResult.reason_category, 'missing_trust_package_identity');
  assert.equal(claimResult.ok, false);
  assert.equal(claimResult.status, 'unsupported_claim');
  assert.equal(claimResult.reason_category, 'runtime_reader_claim');
});

test('writer carries a valid source snapshot exactly as supplied and the reader accepts it', () => {
  // Convergence: written package with source snapshot passes the
  // writer-to-reader local handoff unchanged. Carried or rejected, never
  // fixed up — the reader must accept the snapshot the writer carried
  // and must not mutate, re-hash, or re-version it. Contract:
  // docs/v5/v5-immutable-source-snapshot-contract.md (Section 3).
  const snapshot = {
    snapshotId: 'snap.local.contract.001',
    snapshotVersion: 'huqan.external-source-snapshot.v1',
    hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    algorithm: 'sha256'
  };
  const input = makeWriterInput({ sourceSnapshot: snapshot });
  const writerResult = writeRuntimePackage(input);

  assert.equal(writerResult.ok, true);
  assert.equal(writerResult.verdict, 'ACCEPT');
  assert.deepEqual(writerResult.package.sourceSnapshot, input.sourceSnapshot);

  const readerResult = readRuntimePackage(writerResult.package);

  assert.equal(readerResult.ok, true);
  assert.equal(readerResult.status, 'readable');
  assert.deepEqual(readerResult.package.sourceSnapshot, input.sourceSnapshot);
});

test('source snapshot alone is a sufficient acceptance reason when no higher-priority metadata is present', () => {
  // Without route receipt, reasoning, or provenance, a valid source
  // snapshot alone makes the writer output acceptable with the snapshot's
  // own reason category.
  const snapshot = {
    snapshotId: 'snap.local.contract.002',
    snapshotVersion: 'huqan.external-source-snapshot.v1',
    hash: 'b'.repeat(64),
    algorithm: 'sha256'
  };
  const input = makeWriterInput({
    routeReceipt: undefined,
    reasoning: undefined,
    provenance: undefined,
    sourceSnapshot: snapshot
  });
  const writerResult = writeRuntimePackage(input);

  assert.equal(writerResult.ok, true);
  assert.equal(writerResult.reason_category, 'valid_source_snapshot_metadata');
  assert.deepEqual(writerResult.package.sourceSnapshot, input.sourceSnapshot);
});



test('absent source snapshot input stays absent — writer and reader emit nothing', () => {
  // Absent input stays absent; the writer never invents a snapshot shape.
  const input = makeWriterInput();
  const writerResult = writeRuntimePackage(input);

  assert.equal(writerResult.ok, true);
  assert.equal(Object.hasOwn(writerResult.package, 'sourceSnapshot'), false);

  const readerResult = readRuntimePackage(writerResult.package);

  assert.equal(readerResult.ok, true);
  assert.equal(Object.hasOwn(readerResult.package, 'sourceSnapshot'), false);
});

test('readable local output does not imply trust, authorization, or verification', () => {
  const result = readRuntimePackage(writeRuntimePackage(makeWriterInput()).package);

  assert.equal(result.status, 'readable');
  assert.equal(Object.hasOwn(result, 'trusted'), false);
  assert.equal(Object.hasOwn(result, 'authorized'), false);
  assert.equal(Object.hasOwn(result, 'verified'), false);
  assert.equal(Object.hasOwn(result, 'signed'), false);
});

test('writer and reader helpers remain isolated from exchange and persistence surfaces', () => {
  const writerSource = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'v5', 'runtime-writer.js'),
    'utf8'
  );
  const readerSource = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'v5', 'runtime-reader.js'),
    'utf8'
  );
  const forbiddenDependencyPattern = /fetch\(|axios|require\(['"](?:node:)?(?:http|https|net|tls|crypto)|require\(['"](?:sqlite3|better-sqlite3)/i;

  assert.equal(forbiddenDependencyPattern.test(writerSource), false);
  assert.equal(forbiddenDependencyPattern.test(readerSource), false);
});

test('a BigInt anywhere in the input fails closed with BLOCK instead of throwing (#1298)', () => {
  const input = makeWriterInput({ provenance: { traceId: 'trace.bigint', weight: 10n } });
  let result;
  assert.doesNotThrow(() => {
    result = writeRuntimePackage(input);
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.reason_category, 'invalid_json_value');
});

test('a circular reference in the input fails closed with BLOCK instead of throwing (#1298)', () => {
  const provenance = { traceId: 'trace.cycle', source: 'local_test' };
  provenance.self = provenance;
  const input = makeWriterInput({ provenance });
  let result;
  assert.doesNotThrow(() => {
    result = writeRuntimePackage(input);
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.reason_category, 'invalid_json_value');
});
