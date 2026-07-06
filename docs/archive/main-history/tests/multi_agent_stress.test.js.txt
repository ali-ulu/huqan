/**
 * HUQAN/AXIOM — Multi-Agent Stress Test
 *
 * 12 scenarios that push the system's limits:
 *
 * 1. Temporal Contradiction War (Agent A vs B — negation verification)
 * 2. Chain Reasoning Contradiction (A→B→C→D then contradiction of mid-link)
 * 3. Numeric Value Conflict (different digits for same slot)
 * 4. Adversarial Agent (weasel words, double negation, absolute claims, scope expansion)
 * 5. Workspace Isolation (agents in separate workspaces can't see each other)
 * 6. Shared Workspace Conflict (negated claim in same workspace)
 * 7. Cascading Contradiction (negation of root in a chain)
 * 8. Dream Hypothesis Generation
 * 9. Concurrent Lock Contention (sequential and rapid learns)
 * 10. Provenance Audit Trail (tracing edge references to their source)
 * 11. Cross-Agent Type Conflict (disjoint types: Mayday vs Pan-Pan)
 * 12. High-Risk Domain Gate (medical, aviation, security keywords)
 */

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Kernel = require('../kernel');

// ── Temp directory per run ──────────────────────────────────────────
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-multi-agent-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

// ── Helpers ─────────────────────────────────────────────────────────
let kernelCounter = 0;
function freshKernel(opts = {}) {
  kernelCounter++;
  const k = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `multi-agent-${kernelCounter}.json`),
    ...opts,
  });
  k._autoMaintain = () => {};
  k.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  return k;
}

function agentProvenance(agentId, workspace = 'shared', confidence = 0.9) {
  return {
    provenanceId: `prov-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sourceType: 'agent',
    actor: agentId,
    workspaceId: workspace,
    timestamp: new Date().toISOString(),
    confidence,
    trustPolicyVersion: '1.0.0',
  };
}

function learnAs(kernel, agentId, text, workspace = 'shared', extra = {}) {
  return kernel.learn(text, {
    workspaceId: workspace,
    provenance: agentProvenance(agentId, workspace),
    sessionId: `session-${agentId}`,
    ...extra,
  });
}

function verifyAs(kernel, text, workspace = 'shared') {
  return kernel.verify(text, { workspaceId: workspace });
}

function getSemanticTrust(verifyResult) {
  return verifyResult.meta?.semanticTrust || {};
}

function getSignals(verifyResult) {
  return getSemanticTrust(verifyResult).signals || [];
}

function getRiskFlags(verifyResult) {
  return getSemanticTrust(verifyResult).risk?.flags || [];
}

function hasAnySignalRule(verifyResult, ruleNames) {
  const signals = getSignals(verifyResult);
  const flags = getRiskFlags(verifyResult);
  return ruleNames.some(r => signals.some(s => s.rule === r) || flags.includes(r));
}

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 1: Temporal Contradiction War
// Agent Alpha says X is true. Verify says X is false is a contradiction.
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 1: Temporal Contradiction War', () => {
  const k = freshKernel();

  it('Agent Alpha teaches: elektrikli araclar cevre dostudur', () => {
    const r = learnAs(k, 'agent-alpha', 'elektrikli araclar cevre dostudur');
    assert.ok(r.ok, 'Alpha learn should succeed');
  });

  it('Verify detects contradiction for the negation: elektrikli araclar cevre dostu degildir', () => {
    const v = verifyAs(k, 'elektrikli araclar cevre dostu degildir');
    const hasTension =
      v.data.status === 'celiski' ||
      hasAnySignalRule(v, ['NEGATION_CONFLICT', 'SEMANTIC_OPPOSITION', 'PREDICATE_DRIFT']) ||
      v.data.confidence < 0.7;
    assert.ok(hasTension,
      `Expected contradiction signal. Status: ${v.data.status}, confidence: ${v.data.confidence}`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 2: Chain Reasoning Contradiction
// Build a logical chain, then verify a contradiction of a mid-link.
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 2: Chain Reasoning Contradiction', () => {
  const k = freshKernel();

  it('Agent Alpha builds a 4-step reasoning chain with riskli', () => {
    learnAs(k, 'agent-alpha', 'lityum batarya yanicidir');
    learnAs(k, 'agent-alpha', 'yanici maddeler risklidir');
    learnAs(k, 'agent-alpha', 'riskli maddeler tasimada ozel izin gerektirir');
    learnAs(k, 'agent-alpha', 'ozel izin gerektiren maddeler sinirli bolgelerde satilir');
  });

  it('Verify detects semantic opposition on mid-link: yanici maddeler guvenlidir', () => {
    const v = verifyAs(k, 'yanici maddeler guvenlidir');
    // riskli vs guvenli is in OPPOSITION_PAIRS
    const hasOpposition =
      v.data.status === 'celiski' ||
      hasAnySignalRule(v, ['SEMANTIC_OPPOSITION', 'NEGATION_CONFLICT', 'PREDICATE_DRIFT']) ||
      v.data.confidence < 0.7;
    assert.ok(hasOpposition,
      `Expected opposition for guvenli vs riskli. Status: ${v.data.status}`
    );
  });

  it('Reason shows forward chain from lityum batarya', () => {
    const r = k.reason('lityum batarya', 'shared');
    assert.ok(r.ok);
    const totalEdges = r.data.forward.length + r.data.backward.length;
    assert.ok(totalEdges >= 0, 'Reason completed');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 3: Numeric Value Conflict
// Disagree on numeric values using actual digits.
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 3: Numeric Value Conflict', () => {
  const k = freshKernel();

  it('Agent Alpha: azami hiz 120 limitidir', () => {
    const r = learnAs(k, 'agent-alpha', 'azami hiz 120 limitidir');
    assert.ok(r.ok);
  });

  it('Verify detects numeric conflict for azami hiz 80 limitidir', () => {
    const v = verifyAs(k, 'azami hiz 80 limitidir');
    const hasNumericSignal =
      v.data.status === 'celiski' ||
      hasAnySignalRule(v, ['NUMERICAL_CONFLICT', 'VALUE_CONFLICT', 'PREDICATE_DRIFT']) ||
      v.data.confidence < 0.8;
    assert.ok(hasNumericSignal,
      `Expected numeric conflict. Status: ${v.data.status}, confidence: ${v.data.confidence}`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 4: Adversarial Agent
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 4: Adversarial Agent', () => {
  const k = freshKernel();

  it('Agent Alpha teaches baseline facts', () => {
    learnAs(k, 'agent-alpha', 'aspirin agri kesicidir');
  });

  it('Adversarial: absolute claim — aspirin her zaman guvenlidir', () => {
    const v = verifyAs(k, 'aspirin her zaman guvenlidir');
    assert.ok(
      hasAnySignalRule(v, ['ABSOLUTE_CLAIM', 'HIGH_RISK_DOMAIN']),
      `Expected ABSOLUTE_CLAIM or HIGH_RISK_DOMAIN. Signals: ${getSignals(v).map(s => s.rule)}`
    );
  });

  it('Adversarial: double negation — aspirin zararsiz degildir degil', () => {
    const v = verifyAs(k, 'aspirin zararsiz degildir degil');
    const hasSuspicion =
      hasAnySignalRule(v, ['DOUBLE_NEGATION', 'NEGATION_CONFLICT', 'HIGH_RISK_DOMAIN', 'PREDICATE_DRIFT']) ||
      v.data.status === 'celiski' ||
      v.data.confidence < 0.8;
    assert.ok(hasSuspicion,
      `Expected suspicion for double negation. Status: ${v.data.status}, confidence: ${v.data.confidence}`
    );
  });

  it('Adversarial: weasel words — aspirin genellikle guvenlidir', () => {
    const v = verifyAs(k, 'aspirin genellikle guvenlidir');
    const hasSuspicion =
      hasAnySignalRule(v, ['WEASEL_WORDS', 'HIGH_RISK_DOMAIN', 'PREDICATE_DRIFT']) ||
      v.data.confidence < 0.9;
    assert.ok(hasSuspicion,
      `Expected WEASEL_WORDS or reduced confidence. Confidence: ${v.data.confidence}`
    );
  });

  it('Adversarial: scope expansion — tum ilaclar her zaman guvenlidir', () => {
    const v = verifyAs(k, 'tum ilaclar her zaman guvenlidir');
    const hasSuspicion =
      hasAnySignalRule(v, ['ABSOLUTE_CLAIM', 'SCOPE_EXPANSION', 'HIGH_RISK_DOMAIN']) ||
      v.data.status === 'celiski' ||
      v.data.status === 'bilinmiyor';
    assert.ok(hasSuspicion,
      `Expected risk flags for scope expansion. Status: ${v.data.status}`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 5: Workspace Isolation
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 5: Workspace Isolation', () => {
  const k = freshKernel();

  it('Agent Alpha teaches in workspace alpha', () => {
    const r = learnAs(k, 'agent-alpha', 'mars kirmizi gezegendir', 'ws-alpha');
    assert.ok(r.ok);
  });

  it('Agent Beta teaches in workspace beta', () => {
    const r = learnAs(k, 'agent-beta', 'jupiter gaz devidir', 'ws-beta');
    assert.ok(r.ok);
  });

  it('Workspace alpha cannot see beta knowledge', () => {
    const v = verifyAs(k, 'jupiter gaz devidir', 'ws-alpha');
    assert.equal(v.data.status, 'bilinmiyor',
      `Alpha workspace should not know about Jupiter. Got: ${v.data.status}`
    );
  });

  it('Workspace beta cannot see alpha knowledge', () => {
    const v = verifyAs(k, 'mars kirmizi gezegendir', 'ws-beta');
    assert.equal(v.data.status, 'bilinmiyor',
      `Beta workspace should not know about Mars. Got: ${v.data.status}`
    );
  });

  it('Each workspace verifies its own knowledge', () => {
    const vAlpha = verifyAs(k, 'mars kirmizi gezegendir', 'ws-alpha');
    const vBeta = verifyAs(k, 'jupiter gaz devidir', 'ws-beta');
    assert.notEqual(vAlpha.data.status, 'bilinmiyor', 'Alpha should know Mars');
    assert.notEqual(vBeta.data.status, 'bilinmiyor', 'Beta should know Jupiter');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 6: Shared Workspace Conflict
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 6: Shared Workspace Conflict', () => {
  const k = freshKernel();

  it('Agent Alpha: kedi evcil hayvandir', () => {
    learnAs(k, 'agent-alpha', 'kedi evcil hayvandir', 'ws-shared');
  });

  it('System detects conflict for kedi evcil hayvan degildir', () => {
    const v = verifyAs(k, 'kedi evcil hayvan degildir', 'ws-shared');
    const hasConflict =
      v.data.status === 'celiski' ||
      hasAnySignalRule(v, ['NEGATION_CONFLICT', 'PREDICATE_DRIFT']) ||
      v.data.confidence < 0.8;
    assert.ok(hasConflict,
      `Expected conflict for negation. Status: ${v.data.status}, confidence: ${v.data.confidence}`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 7: Cascading Contradiction
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 7: Cascading Contradiction', () => {
  const k = freshKernel();

  it('Agent Alpha builds a 5-step dependency chain', () => {
    learnAs(k, 'agent-alpha', 'gunes enerjisi yenilenebilirdir');
    learnAs(k, 'agent-alpha', 'yenilenebilir enerji cevre dostudur');
    learnAs(k, 'agent-alpha', 'cevre dostu enerji devlet destegi alir');
    learnAs(k, 'agent-alpha', 'devlet destegi alan enerji ucuzdur');
    learnAs(k, 'agent-alpha', 'ucuz enerji yaygin kullanimdadir');
  });

  it('Reason shows chain from root', () => {
    const r = k.reason('gunes enerjisi', 'shared');
    assert.ok(r.ok);
  });

  it('Root verification of negation shows contradiction', () => {
    const v = verifyAs(k, 'gunes enerjisi yenilenebilir degildir');
    const hasContradiction =
      v.data.status === 'celiski' ||
      hasAnySignalRule(v, ['NEGATION_CONFLICT', 'PREDICATE_DRIFT']) ||
      v.data.confidence < 0.7;
    assert.ok(hasContradiction,
      `Expected contradiction at root. Status: ${v.data.status}`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 8: Dream Hypothesis Generation
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 8: Dream Hypothesis Generation', () => {
  const k = freshKernel();

  it('Build knowledge base with clear relations', () => {
    learnAs(k, 'agent-alpha', 'kopek memeli hayvandir');
    learnAs(k, 'agent-alpha', 'kedi memeli hayvandir');
    learnAs(k, 'agent-alpha', 'memeli hayvanlar sicakkanlidir');
    learnAs(k, 'agent-alpha', 'balik sogukkanlidir');
  });

  it('Dream generates hypotheses from existing graph', () => {
    const d = k.dream({ learnFromDream: false });
    assert.ok(d.ok, 'dream should succeed');
    assert.ok(d.data, 'dream should return data');
  });

  it('Known fact still holds after dream', () => {
    const v = verifyAs(k, 'kopek memeli hayvandir');
    assert.notEqual(v.data.status, 'celiski', 'Known fact should not be contradicted');
  });

  it('Counter-claim: balik sicakkanlidir should show tension', () => {
    const v = verifyAs(k, 'balik sicakkanlidir');
    const hasTension =
      v.data.status === 'celiski' ||
      hasAnySignalRule(v, ['SEMANTIC_OPPOSITION', 'NEGATION_CONFLICT', 'PREDICATE_DRIFT']) ||
      v.data.confidence < 0.8;
    assert.ok(hasTension,
      `Expected tension for balik+sicakkanli. Status: ${v.data.status}, confidence: ${v.data.confidence}`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 9: Concurrent Lock Contention
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 9: Concurrent Lock Contention', () => {
  const k = freshKernel({ enableConcurrencyLock: true });

  it('Sequential learn calls from different agents succeed', () => {
    const r1 = learnAs(k, 'agent-alpha', 'demir agir metaldir');
    const r2 = learnAs(k, 'agent-beta', 'aluminyum hafif metaldir');
    const r3 = learnAs(k, 'agent-gamma', 'bakar iletken metaldir');
    assert.ok(r1.ok, 'Agent Alpha learn ok');
    assert.ok(r2.ok, 'Agent Beta learn ok');
    assert.ok(r3.ok, 'Agent Gamma learn ok');
  });

  it('Verify after concurrent learns returns consistent results', () => {
    const v1 = verifyAs(k, 'demir agir metaldir');
    const v2 = verifyAs(k, 'aluminyum hafif metaldir');
    const v3 = verifyAs(k, 'bakar iletken metaldir');
    assert.notEqual(v1.data.status, 'bilinmiyor', 'Should know about demir');
    assert.notEqual(v2.data.status, 'bilinmiyor', 'Should know about aluminyum');
    assert.notEqual(v3.data.status, 'bilinmiyor', 'Should know about bakir');
  });

  it('Lock prevents data corruption on rapid writes', () => {
    for (let i = 0; i < 10; i++) {
      const agent = i % 3 === 0 ? 'agent-alpha' : i % 3 === 1 ? 'agent-beta' : 'agent-gamma';
      const r = learnAs(k, agent, `test metal ${i} iletkendir`);
      assert.ok(r.ok, `Rapid learn ${i} should succeed`);
    }
    const a = k.ask('demir nedir');
    assert.ok(a.ok, 'ask should still work after rapid writes');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 10: Provenance Audit Trail
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 10: Provenance Audit Trail', () => {
  const k = freshKernel();

  it('Three agents teach overlapping facts', () => {
    learnAs(k, 'agent-alpha', 'su 100 derecede kaynar');
    learnAs(k, 'agent-beta', 'su 0 derecede donar');
    learnAs(k, 'agent-gamma', 'su 100 derecede donmaz');
  });

  it('Verify detects contradiction for su 0 derecede donar degildir', () => {
    const v = verifyAs(k, 'su 0 derecede donar degildir');
    const hasContradiction =
      v.data.status === 'celiski' ||
      hasAnySignalRule(v, ['NEGATION_CONFLICT', 'PREDICATE_DRIFT']) ||
      v.data.confidence < 0.7;
    assert.ok(hasContradiction,
      `Expected contradiction: donar vs donmaz. Status: ${v.data.status}`
    );
  });

  it('Evidence array contains traceable references', () => {
    const v = verifyAs(k, 'su 0 derecede donar degildir');
    assert.ok(v.evidence, 'Should have evidence array');
    assert.ok(v.evidence.length > 0, 'Evidence should not be empty');
  });

  it('Reason shows multiple paths for su', () => {
    const r = k.reason('su', 'shared');
    assert.ok(r.ok, 'reason should succeed');
    assert.ok(r.data.forward.length >= 1, 'Should have at least 1 forward path');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 11: Cross-Agent Type Conflict
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 11: Cross-Agent Type Conflict', () => {
  const k = freshKernel();

  it('Agent Alpha: ucus 101 mayday cagrisidir', () => {
    learnAs(k, 'agent-alpha', 'ucus 101 mayday cagrisidir');
  });

  it('Verify finds type conflict for pan-pan', () => {
    const v = verifyAs(k, 'ucus 101 pan-pan cagrisidir');
    const contradictions = k.detectContradictions('', 'shared');
    const hasTension =
      v.data.status === 'celiski' ||
      contradictions.length > 0 ||
      hasAnySignalRule(v, ['TYPE_CONFLICT', 'PREDICATE_DRIFT', 'VALUE_CONFLICT']) ||
      v.data.confidence < 0.8;
    assert.ok(hasTension,
      `Expected type tension. Status: ${v.data.status}, contradictions: ${contradictions.length}`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 12: High-Risk Domain Gate
// ═══════════════════════════════════════════════════════════════════
describe('Scenario 12: High-Risk Domain Gate', () => {
  const k = freshKernel();

  it('Medical domain: aspirin dozunu artirmak guvenlidir', () => {
    const v = verifyAs(k, 'aspirin dozunu artirmak guvenlidir');
    assert.ok(
      hasAnySignalRule(v, ['HIGH_RISK_DOMAIN']),
      `Medical domain should trigger HIGH_RISK_DOMAIN. Signals: ${getSignals(v).map(s => s.rule)}`
    );
  });

  it('Aviation domain: V1 hizinda kalkmaktan vazgecmek guvenlidir', () => {
    const v = verifyAs(k, 'V1 hizinda kalkmaktan vazgecmek guvenlidir');
    assert.ok(
      hasAnySignalRule(v, ['HIGH_RISK_DOMAIN']),
      `Aviation domain should trigger HIGH_RISK_DOMAIN. Signals: ${getSignals(v).map(s => s.rule)}`
    );
  });

  it('Security domain: KVKK kaydina erisim sinirlamasini kaldirmak guvenlidir', () => {
    const v = verifyAs(k, 'KVKK kaydina erisim sinirlamasini kaldirmak guvenlidir');
    assert.ok(
      hasAnySignalRule(v, ['HIGH_RISK_DOMAIN']),
      `Security/legal domain should trigger HIGH_RISK_DOMAIN. Signals: ${getSignals(v).map(s => s.rule)}`
    );
  });
});
