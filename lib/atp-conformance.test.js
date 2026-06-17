const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  ATP_OBJECT_TYPES,
  validateATPObject,
  validateATPFixture,
  runATPConformance,
  normalizeATPValidationError,
} = require('./atp-conformance');
const { validateAxiomPackage } = require('./axiom-package-format');

const specRoot = path.join(__dirname, '..', 'specs', 'axiom-trust-protocol', '0.1');
const examples = (name) => path.join(specRoot, 'examples', name);

describe('ATP Conformance', () => {
  it('normalizes validation errors', () => {
    const err = normalizeATPValidationError(new Error('boom'));
    assert.strictEqual(err.code, 'VALIDATION_ERROR');
    assert.strictEqual(err.message, 'boom');
  });

  it('valid provenance fixture passes', () => {
    const result = validateATPFixture(ATP_OBJECT_TYPES.provenanceRecord, examples('provenance.github.merged_pr.json'));
    assert.strictEqual(result.ok, true);
  });

  it('missing provenanceId fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.provenanceRecord, {
      sourceRef: 'github://repo/pull/1',
      sourceTitle: 'Missing provenanceId',
      sourceType: 'github',
      actor: 'axiom-bot',
      timestamp: '2026-06-02T00:00:00Z',
      confidence: 0.8,
      workspaceId: 'default',
      trustPolicyVersion: '0.8.0',
    });
    assert.strictEqual(result.ok, false);
  });

  it('invalid confidence > 1 fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.provenanceRecord, {
      provenanceId: 'prov-bad',
      sourceRef: 'github://repo/pull/1',
      sourceTitle: 'Bad confidence',
      sourceType: 'github',
      actor: 'axiom-bot',
      timestamp: '2026-06-02T00:00:00Z',
      confidence: 1.2,
      workspaceId: 'default',
      trustPolicyVersion: '0.8.0',
    });
    assert.strictEqual(result.ok, false);
  });

  it('missing workspaceId fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.provenanceRecord, {
      provenanceId: 'prov-bad',
      sourceRef: 'github://repo/pull/1',
      sourceTitle: 'Missing workspace',
      sourceType: 'github',
      actor: 'axiom-bot',
      timestamp: '2026-06-02T00:00:00Z',
      confidence: 0.8,
      trustPolicyVersion: '0.8.0',
    });
    assert.strictEqual(result.ok, false);
  });

  it('invalid sourceType fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.provenanceRecord, {
      provenanceId: 'prov-bad',
      sourceRef: 'github://repo/pull/1',
      sourceTitle: 'Bad source type',
      sourceType: 'bogus',
      actor: 'axiom-bot',
      timestamp: '2026-06-02T00:00:00Z',
      confidence: 0.8,
      workspaceId: 'default',
      trustPolicyVersion: '0.8.0',
    });
    assert.strictEqual(result.ok, false);
  });

  it('invalid confidence < 0 fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.provenanceRecord, {
      provenanceId: 'prov-bad',
      sourceRef: 'github://repo/pull/1',
      sourceTitle: 'Bad confidence',
      sourceType: 'github',
      actor: 'axiom-bot',
      timestamp: '2026-06-02T00:00:00Z',
      confidence: -0.1,
      workspaceId: 'default',
      trustPolicyVersion: '0.8.0',
    });
    assert.strictEqual(result.ok, false);
  });

  it('valid audit fixture passes', () => {
    const result = validateATPFixture(ATP_OBJECT_TYPES.auditEvent, examples('audit.learn.json'));
    assert.strictEqual(result.ok, true);
  });

  it('invalid eventType fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.auditEvent, {
      auditId: 'audit-bad',
      eventType: 'NOT_REAL',
      targetType: 'edge',
      targetId: 'a|CAUSES|b',
      workspaceId: 'default',
      actor: 'axiom-bot',
      timestamp: '2026-06-02T00:00:00Z',
      sourceRef: 'github://repo/pull/1',
      provenanceId: 'prov-001',
      trustPolicyVersion: '0.8.0',
      details: {},
    });
    assert.strictEqual(result.ok, false);
  });

  it('missing auditId fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.auditEvent, {
      eventType: 'LEARN',
      targetType: 'edge',
      targetId: 'a|CAUSES|b',
      workspaceId: 'default',
      actor: 'axiom-bot',
      timestamp: '2026-06-02T00:00:00Z',
      sourceRef: 'github://repo/pull/1',
      provenanceId: 'prov-001',
      trustPolicyVersion: '0.8.0',
      details: {},
    });
    assert.strictEqual(result.ok, false);
  });

  it('valid flagged candidate passes', () => {
    const result = validateATPFixture(ATP_OBJECT_TYPES.candidateClaim, examples('candidate.flagged.json'));
    assert.strictEqual(result.ok, true);
  });

  it('invalid status fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.candidateClaim, {
      candidateId: 'cand-bad',
      claim: 'bad candidate',
      proposedEdge: { from: 'a', relation: 'CAUSES', to: 'b' },
      provenance: {
        provenanceId: 'prov-001',
        sourceRef: 'github://repo/pull/1',
        sourceTitle: 'PR',
        sourceType: 'github',
        actor: 'axiom-bot',
        timestamp: '2026-06-02T00:00:00Z',
        confidence: 0.9,
        workspaceId: 'default',
        trustPolicyVersion: '0.8.0',
      },
      conflict: {},
      recommendation: 'flag',
      status: 'unknown',
      workspaceId: 'default',
      createdAt: '2026-06-02T00:00:00Z',
    });
    assert.strictEqual(result.ok, false);
  });

  it('pending candidate is not canonical', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.candidateClaim, {
      candidateId: 'cand-pending',
      claim: 'pending candidate',
      proposedEdge: { from: 'a', relation: 'CAUSES', to: 'b' },
      provenance: {
        provenanceId: 'prov-001',
        sourceRef: 'github://repo/pull/1',
        sourceTitle: 'PR',
        sourceType: 'github',
        actor: 'axiom-bot',
        timestamp: '2026-06-02T00:00:00Z',
        confidence: 0.9,
        workspaceId: 'default',
        trustPolicyVersion: '0.8.0',
      },
      conflict: {},
      recommendation: 'flag',
      status: 'pending',
      workspaceId: 'default',
      createdAt: '2026-06-02T00:00:00Z',
      canonical: true,
    });
    assert.strictEqual(result.ok, false);
  });

  it('valid conflict result passes', () => {
    const result = validateATPFixture(ATP_OBJECT_TYPES.conflictResult, examples('conflict.agent_vs_graph.json'));
    assert.strictEqual(result.ok, true);
  });

  it('invalid recommendation fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.conflictResult, {
      conflict: true,
      type: 'agent-vs-graph',
      recommendation: 'maybe',
      reason: 'bad recommendation',
      confidenceDelta: -0.2,
      existingEvidence: [],
      proposedEvidence: [],
      workspaceId: 'default',
    });
    assert.strictEqual(result.ok, false);
  });

  it('conflict=false may allow type=null', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.conflictResult, {
      conflict: false,
      type: null,
      recommendation: 'accept',
      reason: 'no conflict',
      confidenceDelta: 0,
      existingEvidence: [],
      proposedEvidence: [],
      workspaceId: 'default',
    });
    assert.strictEqual(result.ok, true);
  });

  it('valid trust receipt passes', () => {
    const result = validateATPFixture(ATP_OBJECT_TYPES.trustReceipt, examples('trust-receipt.github_pr.json'));
    assert.strictEqual(result.ok, true);
  });

  it('canonical with canonical=false fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.trustReceipt, {
      receiptId: 'receipt-bad',
      targetType: 'node',
      targetId: 'kedi',
      claim: 'kedi hayvandir',
      status: 'canonical',
      workspaceId: 'default',
      provenance: {
        provenanceId: 'prov-001',
        sourceRef: 'github://repo/pull/1',
        sourceTitle: 'PR',
        sourceType: 'github',
        actor: 'axiom-bot',
        timestamp: '2026-06-02T00:00:00Z',
        confidence: 0.9,
        workspaceId: 'default',
        trustPolicyVersion: '0.8.0',
      },
      trustPolicyVersion: '0.8.0',
      confidence: 0.9,
      auditTrail: [],
      conflict: null,
      candidateClaim: null,
      canonical: false,
      generatedAt: '2026-06-02T00:00:00Z',
    });
    assert.strictEqual(result.ok, false);
  });

  it('pending with canonical=true fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.trustReceipt, {
      receiptId: 'receipt-bad',
      targetType: 'node',
      targetId: 'kedi',
      claim: 'kedi hayvandir',
      status: 'pending',
      workspaceId: 'default',
      provenance: {
        provenanceId: 'prov-001',
        sourceRef: 'github://repo/pull/1',
        sourceTitle: 'PR',
        sourceType: 'github',
        actor: 'axiom-bot',
        timestamp: '2026-06-02T00:00:00Z',
        confidence: 0.9,
        workspaceId: 'default',
        trustPolicyVersion: '0.8.0',
      },
      trustPolicyVersion: '0.8.0',
      confidence: 0.9,
      auditTrail: [],
      conflict: null,
      candidateClaim: null,
      canonical: true,
      generatedAt: '2026-06-02T00:00:00Z',
    });
    assert.strictEqual(result.ok, false);
  });

  it('missing auditTrail fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.trustReceipt, {
      receiptId: 'receipt-bad',
      targetType: 'node',
      targetId: 'kedi',
      claim: 'kedi hayvandir',
      status: 'canonical',
      workspaceId: 'default',
      provenance: {
        provenanceId: 'prov-001',
        sourceRef: 'github://repo/pull/1',
        sourceTitle: 'PR',
        sourceType: 'github',
        actor: 'axiom-bot',
        timestamp: '2026-06-02T00:00:00Z',
        confidence: 0.9,
        workspaceId: 'default',
        trustPolicyVersion: '0.8.0',
      },
      trustPolicyVersion: '0.8.0',
      confidence: 0.9,
      conflict: null,
      candidateClaim: null,
      canonical: true,
      generatedAt: '2026-06-02T00:00:00Z',
    });
    assert.strictEqual(result.ok, false);
  });

  it('valid unsupported verification result passes as not verified', () => {
    const result = validateATPFixture(ATP_OBJECT_TYPES.verificationResult, examples('verification.unsupported.json'));
    assert.strictEqual(result.ok, true);
    assert.ok(result.warnings.includes('not_verified'));
  });

  it('contradicted result is not verified', () => {
    const result = validateATPFixture(ATP_OBJECT_TYPES.verificationResult, examples('verification.contradicted.json'));
    assert.strictEqual(result.ok, true);
    assert.ok(result.warnings.includes('not_verified'));
  });

  it('package validation rejects unsupported verification results and unknown embedded collections', () => {
    const pkg = {
      manifest: {
        packageId: 'pkg-1',
        format: 'axiom-package',
        formatVersion: '0.1',
        createdAt: '2026-06-13T00:00:00.000Z',
        createdBy: 'axiom',
        workspaceId: 'default',
        description: 'test package',
        atpVersion: '0.1',
        objectCounts: {
          provenanceRecords: 0,
          auditEvents: 0,
          candidateClaims: 0,
          conflictResults: 0,
          verificationResults: 1,
          trustReceipts: 0,
          causalChains: 0,
          simulationResults: 0,
        },
      },
      objects: {
        verificationResults: [{
          verificationId: 'ver-1',
          ok: true,
          claim: 'kedi hayvandir',
          status: 'unsupported',
          mode: 'unsupported',
          confidence: 0.2,
          evidence: [],
          provenance: {
            provenanceId: 'prov-1',
            sourceRef: 'github://repo/pull/1',
            sourceTitle: 'PR',
            sourceType: 'github',
            actor: 'axiom-bot',
            timestamp: '2026-06-13T00:00:00.000Z',
            confidence: 0.2,
            workspaceId: 'default',
            trustPolicyVersion: '0.8.0',
          },
          conflict: null,
          receipt: {
            receiptId: 'r-1',
            targetType: 'claim',
            targetId: 'claim-1',
            claim: 'kedi hayvandir',
            status: 'pending',
            workspaceId: 'default',
            provenance: {
              provenanceId: 'prov-1',
              sourceRef: 'github://repo/pull/1',
              sourceTitle: 'PR',
              sourceType: 'github',
              actor: 'axiom-bot',
              timestamp: '2026-06-13T00:00:00.000Z',
              confidence: 0.2,
              workspaceId: 'default',
              trustPolicyVersion: '0.8.0',
            },
            trustPolicyVersion: '0.8.0',
            confidence: 0.2,
            auditTrail: [],
            candidateClaim: null,
            canonical: false,
            generatedAt: '2026-06-13T00:00:00.000Z',
          },
        }],
        unexpectedCollection: [{
          id: 'oops',
        }],
      },
      index: {
        byId: {},
        bySourceRef: {},
        byWorkspaceId: {},
        byType: {},
      },
      metadata: {},
    };

    const result = validateAxiomPackage(pkg);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((entry) => String(entry.field || '').includes('objects.unexpectedCollection')));
    assert.ok(result.errors.some((entry) => String(entry.field || '').includes('objects.verificationResults')));
  });

  it('graph-backed verification result may be verified if ok=true and evidence exists', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.verificationResult, {
      ok: true,
      claim: 'kedi hayvandir',
      status: 'verified',
      mode: 'graph-backed',
      confidence: 0.96,
      evidence: [{ kind: 'direct_edge', text: 'kedi --[tur]--> hayvan' }],
      provenance: {
        provenanceId: 'prov-001',
        sourceRef: 'github://repo/pull/1',
        sourceTitle: 'PR',
        sourceType: 'github',
        actor: 'axiom-bot',
        timestamp: '2026-06-02T00:00:00Z',
        confidence: 0.96,
        workspaceId: 'default',
        trustPolicyVersion: '0.8.0',
      },
      conflict: null,
      receipt: { receiptId: 'receipt-001' },
    });
    assert.strictEqual(result.ok, true);
  });

  it('valid causal chain passes', () => {
    const result = validateATPFixture(ATP_OBJECT_TYPES.causalChain, examples('causal-chain.autolearn.json'));
    assert.strictEqual(result.ok, true);
  });

  it('invalid causal relation fails if relation is present', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.causalChain, {
      start: 'autoLearn true',
      chain: [
        { from: 'autoLearn true', relation: 'CAUSES', to: 'unsupported output can enter graph' },
        { from: 'unsupported output can enter graph', relation: 'NOT_A_RELATION', to: 'graph trust degrades' },
      ],
      visited: ['autoLearn true'],
      loops: [],
      stoppedReason: 'maxDepth',
      maxDepth: 3,
      confidence: 0.9,
      evidence: [],
    });
    assert.strictEqual(result.ok, false);
  });

  it('valid simulation result passes', () => {
    const result = validateATPFixture(ATP_OBJECT_TYPES.simulationResult, examples('simulation.autolearn.json'));
    assert.strictEqual(result.ok, true);
  });

  it('invalid risk level fails', () => {
    const result = validateATPObject(ATP_OBJECT_TYPES.simulationResult, {
      mode: 'causal',
      input: { claim: 'bad risk' },
      affectedNodes: [],
      causalChains: [],
      risks: [{ level: 'danger', reason: 'bad level' }],
      confidence: 0.5,
      recommendation: 'Change is not recommended.',
      evidence: [],
      unknowns: [],
    });
    assert.strictEqual(result.ok, false);
  });

  it('valid error fixture passes', () => {
    const result = validateATPFixture(ATP_OBJECT_TYPES.error, examples('error.provenance_required.json'));
    assert.strictEqual(result.ok, true);
  });

  it('fixture runner validates all example fixtures', () => {
    const fixtureList = [
      [ATP_OBJECT_TYPES.provenanceRecord, examples('provenance.github.merged_pr.json')],
      [ATP_OBJECT_TYPES.auditEvent, examples('audit.learn.json')],
      [ATP_OBJECT_TYPES.candidateClaim, examples('candidate.flagged.json')],
      [ATP_OBJECT_TYPES.conflictResult, examples('conflict.agent_vs_graph.json')],
      [ATP_OBJECT_TYPES.trustReceipt, examples('trust-receipt.github_pr.json')],
      [ATP_OBJECT_TYPES.verificationResult, examples('verification.unsupported.json')],
      [ATP_OBJECT_TYPES.verificationResult, examples('verification.contradicted.json')],
      [ATP_OBJECT_TYPES.causalChain, examples('causal-chain.autolearn.json')],
      [ATP_OBJECT_TYPES.simulationResult, examples('simulation.autolearn.json')],
      [ATP_OBJECT_TYPES.error, examples('error.provenance_required.json')],
    ].map(([type, filePath]) => ({ type, filePath }));

    const report = runATPConformance(fixtureList);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.errors.length, 0);
    assert.strictEqual(report.results.length, fixtureList.length);
  });

  it('intentionally invalid fixture fails inline', () => {
    const report = validateATPObject(ATP_OBJECT_TYPES.error, {
      ok: false,
      error: {
        code: 'NOT_A_REAL_CODE',
        message: 'bad error',
        details: { field: 'error.code' },
      },
    });
    assert.strictEqual(report.ok, false);
  });
});
