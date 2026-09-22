const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const { routeCandidateClaim } = require('./conflict-detector');
const { buildTrustReceipt } = require('./provenance-query');
const {
  readClaim,
  unwrapClaimRead,
  ClaimReadUnsettledError,
  CLAIM_READ_POLICY_VERSION,
} = require('./claim-read');
const { READ_BEHAVIORS, UNSETTLED_REASONS } = require('./contested-read-policy');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-claim-read-'));

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeProvenance(overrides = {}) {
  return {
    provenanceId: 'prov-claim-001',
    sourceRef: 'docs/claims.md#1',
    sourceTitle: 'Claims',
    sourceType: 'document',
    actor: 'builder',
    timestamp: '2026-06-02T00:00:00Z',
    confidence: 0.91,
    workspaceId: 'workspace-a',
    trustPolicyVersion: '0.8.0',
    ...overrides,
  };
}

function routeKernelCandidate(kernel, claim, opts = {}) {
  const admissionOwner = kernel.kernel || kernel;
  return routeCandidateClaim(kernel, claim, opts, {
    evaluateLearnAdmission: (text, admissionOpts, provenance, workspaceId) =>
      admissionOwner._evaluateLearnAdmission(text, admissionOpts, provenance, workspaceId),
  });
}

/**
 * Real contested state, no hand-written fixture: seed a canonical CAUSES
 * edge, then route a conflicting PREVENTS candidate through the actual
 * conflict-detector path (mirrors lib/conflict-detector.test.js's
 * seedCausalEdge/routeKernelCandidate pattern) so the contest is exactly
 * what production code produces, not an invented shape.
 */
function buildContestedKernel(name) {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(tempDir, `${name}.json`) });
  const edgeProvenance = makeProvenance({ provenanceId: 'prov-edge-001' });
  kernel.graph.addNode('fire', 'fire', edgeProvenance, { workspaceId: 'workspace-a' });
  kernel.graph.addNode('smoke', 'smoke', edgeProvenance, { workspaceId: 'workspace-a' });
  kernel.graph.addEdge('fire', 'smoke', 'CAUSES', {
    workspaceId: 'workspace-a',
    provenance: edgeProvenance,
    strength: 0.9,
    confidence: 0.88,
    source: 'manual',
    sourceRef: edgeProvenance.sourceRef,
    evidence: ['fire causes smoke'],
  });

  const routed = routeKernelCandidate(kernel, {
    claim: 'fire prevents smoke',
    subject: 'fire',
    relation: 'PREVENTS',
    object: 'smoke',
    provenance: makeProvenance({ provenanceId: 'prov-challenge-001', sourceRef: 'docs/claims.md#2' }),
  }, { workspaceId: 'workspace-a' });

  assert.strictEqual(routed.conflict.conflict, true, 'setup: candidate must actually conflict');
  assert.strictEqual(routed.candidate.recommendation, 'flag', 'setup: candidate must be flagged');
  assert.strictEqual(routed.candidate.status, 'pending', 'setup: candidate must be unreviewed');

  return kernel;
}

test('LOW risk reads a contested target as contested_marker with both sides, no settled value', () => {
  const kernel = buildContestedKernel('low');
  const result = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'READ_ONLY' } });

  assert.strictEqual(result.kind, 'unsettled');
  assert.strictEqual(result.behavior, READ_BEHAVIORS.CONTESTED_MARKER);
  assert.strictEqual(result.reader.riskLevel, 'LOW');
  assert.strictEqual('value' in result, false);
  assert.ok(result.sides.canonical);
  assert.strictEqual(result.sides.challengers.length, 1);
  assert.strictEqual(result.sides.challengers[0].proposedEdge.relation, 'PREVENTS');
  assert.ok(result.receipt);
  assert.strictEqual(result.policyVersion, CLAIM_READ_POLICY_VERSION);
});

test('MEDIUM risk reads a contested target as last_known_good, no sides', () => {
  const kernel = buildContestedKernel('medium');
  const result = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'NETWORK_CALL' } });

  assert.strictEqual(result.kind, 'unsettled');
  assert.strictEqual(result.behavior, READ_BEHAVIORS.LAST_KNOWN_GOOD);
  assert.strictEqual(result.reader.riskLevel, 'MEDIUM');
  assert.strictEqual(result.lastKnownGood.targetId, 'fire');
  assert.strictEqual('sides' in result, false);
  assert.strictEqual('value' in result, false);
});

test('HIGH risk reads a contested target as block, no lastKnownGood, no sides', () => {
  const kernel = buildContestedKernel('high');
  const result = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'CANONICAL_GRAPH_WRITE' } });

  assert.strictEqual(result.kind, 'unsettled');
  assert.strictEqual(result.behavior, READ_BEHAVIORS.BLOCK);
  assert.strictEqual(result.reader.riskLevel, 'HIGH');
  assert.strictEqual('lastKnownGood' in result, false);
  assert.strictEqual('sides' in result, false);
  assert.strictEqual('value' in result, false);
  assert.deepStrictEqual(Object.keys(result.receipt).sort(), ['id', 'status']);
});

test('CRITICAL risk reads a contested target as block', () => {
  const kernel = buildContestedKernel('critical');
  const result = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'PRODUCTION_MUTATION' } });

  assert.strictEqual(result.kind, 'unsettled');
  assert.strictEqual(result.behavior, READ_BEHAVIORS.BLOCK);
  assert.strictEqual(result.reader.riskLevel, 'CRITICAL');
});

test('a legacy caller with no intent is blocked, fail-safe', () => {
  const kernel = buildContestedKernel('legacy');
  const result = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire' });

  assert.strictEqual(result.kind, 'unsettled');
  assert.strictEqual(result.behavior, READ_BEHAVIORS.BLOCK);
  assert.strictEqual(result.reason, UNSETTLED_REASONS.INTENT_ABSENT);
  assert.strictEqual(result.value, undefined);
  assert.throws(() => unwrapClaimRead(result), ClaimReadUnsettledError);
});

test('block never unwraps, even when explicitly accepted', () => {
  const kernel = buildContestedKernel('block-accept');
  const result = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'CANONICAL_GRAPH_WRITE' } });

  assert.throws(() => unwrapClaimRead(result, { accept: ['block'] }), (err) => {
    assert.ok(err instanceof ClaimReadUnsettledError);
    assert.strictEqual(err.code, 'CLAIM_READ_BLOCKED');
    return true;
  });
});

test('unwrapClaimRead throws CLAIM_UNSETTLED for an unsettled behavior not in accept', () => {
  const kernel = buildContestedKernel('unwrap-reject');
  const result = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'READ_ONLY' } });

  assert.throws(() => unwrapClaimRead(result), (err) => {
    assert.ok(err instanceof ClaimReadUnsettledError);
    assert.strictEqual(err.code, 'CLAIM_UNSETTLED');
    assert.strictEqual(err.behavior, READ_BEHAVIORS.CONTESTED_MARKER);
    return true;
  });
});

test('unwrapClaimRead returns the payload when the behavior is explicitly accepted', () => {
  const kernel = buildContestedKernel('unwrap-accept');
  const markerResult = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'READ_ONLY' } });
  const unwrappedMarker = unwrapClaimRead(markerResult, { accept: ['contested_marker'] });
  assert.strictEqual(unwrappedMarker.canonical.targetId, 'fire');

  const lkgResult = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'NETWORK_CALL' } });
  const unwrappedLkg = unwrapClaimRead(lkgResult, { accept: ['last_known_good'] });
  assert.strictEqual(unwrappedLkg.targetId, 'fire');
});

test('a settled target (no contest) returns kind: settled, and unwraps to its value', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(tempDir, 'settled.json') });
  const provenance = makeProvenance();
  kernel.learn('kedi hayvandir', {
    provenance,
    admissionRequired: true,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: 'apr-settled',
  });

  const result = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'kedi' });
  assert.strictEqual(result.kind, 'settled');
  assert.ok(result.value);
  assert.strictEqual(result.value.targetId, 'kedi');
  assert.strictEqual(unwrapClaimRead(result), result.value);
});

test('an unknown target returns kind: not_found', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(tempDir, 'not-found.json') });
  const result = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'does-not-exist' });
  assert.strictEqual(result.kind, 'not_found');
  assert.strictEqual(unwrapClaimRead(result), undefined);
});

test('MEDIUM risk escalates to block when there is no last-known-good value to serve', () => {
  // No canonical record at all: contest detection requires a canonical
  // target (matchesCanonicalTarget needs canonicalRecord.targetId), so a
  // contest is only reachable here via a target that does resolve to a
  // canonical record. This asserts the escalation path directly against
  // the policy layer instead, since claim-read.js can only reach
  // no_last_known_good through selectReadBehavior's own contract, which
  // lib/contested-read-policy.test.js already pins with hasLastKnownGood:
  // false. Re-asserted here at the integration boundary: a target with a
  // canonical record removed mid-contest is out of scope for Phase 1 (no
  // write path removes canonical records), so this documents the contract
  // rather than re-deriving a fixture for an unreachable state.
  const { selectReadBehavior, resolveReaderRiskLevel } = require('./contested-read-policy');
  const resolution = resolveReaderRiskLevel({ category: 'NETWORK_CALL' });
  const behavior = selectReadBehavior(resolution, { hasLastKnownGood: false });
  assert.strictEqual(behavior.behavior, READ_BEHAVIORS.BLOCK);
  assert.strictEqual(behavior.reason, UNSETTLED_REASONS.NO_LAST_KNOWN_GOOD);
});

test('a frozen result cannot be mutated in strict mode', () => {
  const kernel = buildContestedKernel('frozen');
  const result = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'CANONICAL_GRAPH_WRITE' } });
  assert.throws(() => {
    'use strict';
    result.value = 'mutated';
  }, TypeError);
  assert.throws(() => {
    'use strict';
    result.ledgerEvents.push({ injected: true });
  }, TypeError);
});

test('readClaim does not change buildTrustReceipt output for the same target (ATP 0.1 untouched)', () => {
  const kernel = buildContestedKernel('receipt-parity');
  const before = buildTrustReceipt({ targetId: 'fire', workspaceId: 'workspace-a' }, { target: kernel.graph });
  readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'READ_ONLY' } });
  readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'PRODUCTION_MUTATION' } });
  const after = buildTrustReceipt({ targetId: 'fire', workspaceId: 'workspace-a' }, { target: kernel.graph });

  const strip = ({ receiptId, generatedAt, ...rest }) => rest;
  assert.deepStrictEqual(strip(before), strip(after));
});

test('an unsettled read appends ledgerEvents but writes nothing to the graph audit log', () => {
  const kernel = buildContestedKernel('audit-parity');
  const before = kernel.graph.getAuditEvents({ workspaceId: 'workspace-a' }).length;
  const result = readClaim(kernel, { workspaceId: 'workspace-a', targetId: 'fire', intent: { category: 'READ_ONLY' } });
  const after = kernel.graph.getAuditEvents({ workspaceId: 'workspace-a' }).length;

  assert.strictEqual(result.ledgerEvents.length, 1);
  assert.strictEqual(result.ledgerEvents[0].type, 'claim_read_unsettled');
  assert.strictEqual(after, before);
});
