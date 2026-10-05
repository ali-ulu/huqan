'use strict';

/**
 * Promotion CI gate tests (#3463, R08).
 *
 * The pure gate is characterized directly (a disjoint interval promotes, a
 * touching or overlapping interval is refused, too few samples is
 * INSUFFICIENT, malformed input is refused, the contract must be pre-locked and
 * scores bound to the versions compared), and then the registry seam is
 * exercised with real `compiler.js`/`qualify()` output so the optional
 * `promotionEvidence` wiring is proven end to end: a candidate whose interval
 * does not clear the incumbent's leaves the active pointer where it was, a
 * promotion is version-bound, and the evidence is optional so an unmeasured
 * activation is unchanged.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  GATE_STATUS,
  GATE_CODES,
  DIRECTIONS,
  lockPromotionContract,
  evaluatePromotionGate,
  guardPromotionMove,
} = require('../lib/experience/promotion-ci-gate');
const { compile, qualify, KINDS } = require('../lib/experience/compiler');
const { createProcedureRegistry, CODES } = require('../lib/experience/procedure-registry');

const CONTRACT = lockPromotionContract({
  direction: DIRECTIONS.HIGHER_IS_BETTER, confidenceLevel: 0.95, minSamples: 10,
}).contract;
const LOWER_CONTRACT = lockPromotionContract({
  direction: DIRECTIONS.LOWER_IS_BETTER, confidenceLevel: 0.95, minSamples: 10,
}).contract;

const PROVENANCE = Object.freeze({ sourceSha: 'sha-1', procedureVersion: '1', configHash: 'cfg-1' });

function candidate(sources = ['src-1']) {
  return Object.freeze({
    status: 'candidate',
    trace: Object.freeze({ sources: Object.freeze([...sources]), scope: Object.freeze({ repo: 'huqan' }), revision: 'rev-1' }),
  });
}

function compileReplaceText(overrides = {}) {
  const result = compile({
    candidate: candidate(),
    kind: KINDS.REPLACE_TEXT,
    params: { path: 'a.txt', oldText: 'foo', newText: 'bar' },
    parentVersion: 0,
    ...overrides,
  });
  assert.equal(result.ok, true, 'fixture compile() must succeed');
  return result.procedure;
}

function applySingleSite(procedure, input) {
  return { sites: 1, after: input.replace(procedure.params.oldText, procedure.params.newText) };
}

function qualifiedRegistry(procedure) {
  const registry = createProcedureRegistry();
  registry.register({ workspaceId: 'ws-a', procedure, provenance: PROVENANCE });
  const pass = qualify({ procedure, inputs: ['line with foo in it'], apply: applySingleSite, observe: (value) => value });
  assert.equal(pass.ok, true);
  registry.recordQualification({ workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version, details: pass });
  return registry;
}

describe('Promotion CI gate: pure rule (#3463)', () => {
  it('promotes only when the candidate interval is strictly above the incumbent', () => {
    const result = evaluatePromotionGate({
      contract: CONTRACT,
      activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 } },
      candidateScore: { mean: 0.75, n: 40, ci: { lower: 0.70, upper: 0.80 } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, GATE_STATUS.PROMOTE);
    assert.equal(result.code, null);
    assert.ok(result.margin > 0);
  });

  it('refuses a candidate whose interval merely touches the incumbent (still inside the noise)', () => {
    const result = evaluatePromotionGate({
      contract: CONTRACT,
      activeScore: { mean: 0.60, n: 40, ci: { lower: 0.50, upper: 0.70 } },
      candidateScore: { mean: 0.72, n: 40, ci: { lower: 0.70, upper: 0.74 } },
    });
    assert.equal(result.status, GATE_STATUS.REFUSE);
    assert.equal(result.code, GATE_CODES.CI_NOT_CLEARED);
    assert.equal(result.margin, 0, 'touching intervals are not a strict improvement');
  });

  it('refuses a candidate whose interval overlaps the incumbent, even with a higher mean', () => {
    const result = evaluatePromotionGate({
      contract: CONTRACT,
      activeScore: { mean: 0.60, n: 40, ci: { lower: 0.45, upper: 0.75 } },
      candidateScore: { mean: 0.68, n: 40, ci: { lower: 0.60, upper: 0.76 } },
    });
    assert.equal(result.status, GATE_STATUS.REFUSE);
    assert.equal(result.code, GATE_CODES.CI_NOT_CLEARED);
    assert.ok(result.margin < 0);
  });

  it('is direction aware: lower-is-better promotes when the candidate interval is strictly below', () => {
    const better = evaluatePromotionGate({
      contract: LOWER_CONTRACT,
      activeScore: { mean: 0.40, n: 40, ci: { lower: 0.35, upper: 0.45 } },
      candidateScore: { mean: 0.25, n: 40, ci: { lower: 0.20, upper: 0.30 } },
    });
    assert.equal(better.status, GATE_STATUS.PROMOTE);
    const worse = evaluatePromotionGate({
      contract: LOWER_CONTRACT,
      activeScore: { mean: 0.40, n: 40, ci: { lower: 0.35, upper: 0.45 } },
      candidateScore: { mean: 0.55, n: 40, ci: { lower: 0.50, upper: 0.60 } },
    });
    assert.equal(worse.status, GATE_STATUS.REFUSE);
  });

  it('INSUFFICIENT is not zero: too few samples refuses as absence of evidence, never a pass', () => {
    const result = evaluatePromotionGate({
      contract: CONTRACT,
      activeScore: { mean: 0.60, n: 4, ci: { lower: 0.55, upper: 0.65 } },
      candidateScore: { mean: 0.90, n: 40, ci: { lower: 0.85, upper: 0.95 } },
    });
    assert.equal(result.status, GATE_STATUS.INSUFFICIENT);
    assert.equal(result.code, GATE_CODES.INSUFFICIENT);
    const zero = evaluatePromotionGate({
      contract: CONTRACT,
      activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 } },
      candidateScore: { mean: 0.90, n: 0, ci: { lower: 0.85, upper: 0.95 } },
    });
    assert.equal(zero.status, GATE_STATUS.INSUFFICIENT);
  });

  it('refuses a score whose declared direction disagrees with the locked contract', () => {
    const result = evaluatePromotionGate({
      contract: CONTRACT,
      activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 }, direction: DIRECTIONS.LOWER_IS_BETTER },
      candidateScore: { mean: 0.75, n: 40, ci: { lower: 0.70, upper: 0.80 } },
    });
    assert.equal(result.status, GATE_STATUS.REFUSE);
    assert.equal(result.code, GATE_CODES.DIRECTION_MISMATCH);
  });

  it('binds scores to the versions compared: a stale or unrelated version is refused, not read as clearance', () => {
    const result = evaluatePromotionGate({
      contract: CONTRACT,
      expect: { activeVersion: 1, candidateVersion: 2 },
      activeScore: { mean: 0.10, n: 40, ci: { lower: 0.05, upper: 0.15 }, version: 0 },
      candidateScore: { mean: 0.90, n: 40, ci: { lower: 0.85, upper: 0.95 }, version: 2 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, GATE_CODES.VERSION_MISMATCH);
    const ok = evaluatePromotionGate({
      contract: CONTRACT,
      expect: { activeVersion: 1, candidateVersion: 2 },
      activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 }, version: 1 },
      candidateScore: { mean: 0.80, n: 40, ci: { lower: 0.72, upper: 0.88 }, version: 2 },
    });
    assert.equal(ok.status, GATE_STATUS.PROMOTE);
  });

  it('refuses a contract that was not pre-locked: only lockPromotionContract() output is accepted', () => {
    const bare = { direction: DIRECTIONS.HIGHER_IS_BETTER, confidenceLevel: 0.95, minSamples: 10 };
    const frozenBare = Object.freeze({ ...bare });
    for (const contract of [bare, frozenBare, { ...CONTRACT }]) {
      const result = evaluatePromotionGate({
        contract,
        activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 } },
        candidateScore: { mean: 0.75, n: 40, ci: { lower: 0.70, upper: 0.80 } },
      });
      assert.equal(result.ok, false, 'a scoring-time contract must be refused');
      assert.equal(result.code, GATE_CODES.INVALID_CONTRACT);
    }
  });

  it('fails closed on a malformed contract: missing, unknown, non-finite or out-of-range fields', () => {
    const bad = [
      undefined,
      {},
      { ...CONTRACT, extra: 1 },
      { ...CONTRACT, confidenceLevel: 1 },
      { ...CONTRACT, confidenceLevel: 0 },
      { ...CONTRACT, confidenceLevel: NaN },
      { ...CONTRACT, minSamples: 0 },
      { ...CONTRACT, minSamples: 2.5 },
      { ...CONTRACT, direction: 'sideways' },
    ];
    for (const contract of bad) {
      const result = lockPromotionContract(contract);
      assert.equal(result.ok, false, `contract ${JSON.stringify(contract)} must be refused`);
      assert.equal(result.code, GATE_CODES.INVALID_CONTRACT);
    }
  });

  it('fails closed on a malformed score: non-finite mean, bad n, inverted or non-finite interval', () => {
    const bad = [
      undefined,
      { mean: NaN, n: 40, ci: { lower: 0.5, upper: 0.6 } },
      { mean: 0.6, n: -1, ci: { lower: 0.5, upper: 0.6 } },
      { mean: 0.6, n: 40, ci: { lower: 0.7, upper: 0.5 } },
      { mean: 0.6, n: 40, ci: { lower: Infinity, upper: 0.6 } },
      { mean: 0.6, n: 40, ci: null },
      { mean: 0.6, n: 40, ci: { lower: 0.5, upper: 0.6 }, version: '' },
    ];
    for (const candidateScore of bad) {
      const result = evaluatePromotionGate({
        contract: CONTRACT,
        activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 } },
        candidateScore,
      });
      assert.equal(result.ok, false, `score ${JSON.stringify(candidateScore)} must be refused`);
      assert.equal(result.code, GATE_CODES.INVALID_SCORE);
    }
  });

  it('returns a failure result for null evidence instead of throwing', () => {
    const result = evaluatePromotionGate(null);
    assert.equal(result.ok, false);
    assert.equal(result.code, GATE_CODES.INVALID_SCORE);
  });
});

describe('Promotion CI gate: move guard (#3463)', () => {
  it('lets the move proceed when no evidence is supplied, on first activation, or when re-activating', () => {
    assert.equal(guardPromotionMove({ promotionEvidence: undefined, currentVersion: 1, candidateVersion: 2 }).ok, true);
    assert.equal(guardPromotionMove({ promotionEvidence: { contract: CONTRACT }, currentVersion: undefined, candidateVersion: 2 }).ok, true);
    assert.equal(guardPromotionMove({ promotionEvidence: { contract: CONTRACT }, currentVersion: 2, candidateVersion: 2 }).ok, true);
    assert.equal(guardPromotionMove().ok, true);
  });

  it('fails closed without throwing when the supplied evidence is null or malformed', () => {
    const guard = guardPromotionMove({ promotionEvidence: null, currentVersion: 1, candidateVersion: 2 });
    assert.equal(guard.ok, false);
    assert.equal(guard.code, GATE_CODES.INVALID_CONTRACT);
    const bare = guardPromotionMove({
      promotionEvidence: {
        contract: { direction: DIRECTIONS.HIGHER_IS_BETTER, confidenceLevel: 0.95, minSamples: 10 },
        activeScore: { mean: 0.6, n: 40, ci: { lower: 0.55, upper: 0.65 } },
        candidateScore: { mean: 0.8, n: 40, ci: { lower: 0.72, upper: 0.88 } },
      },
      currentVersion: 1, candidateVersion: 2,
    });
    assert.equal(bare.ok, false);
    assert.equal(bare.code, GATE_CODES.INVALID_CONTRACT);
  });

  it('returns the gate verdict when a real promotion is compared', () => {
    const guard = guardPromotionMove({
      promotionEvidence: {
        contract: CONTRACT,
        activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 }, version: 1 },
        candidateScore: { mean: 0.80, n: 40, ci: { lower: 0.72, upper: 0.88 }, version: 2 },
      },
      currentVersion: 1, candidateVersion: 2,
    });
    assert.equal(guard.ok, true);
    assert.equal(guard.promotion.status, GATE_STATUS.PROMOTE);
  });
});

describe('Promotion CI gate: registry seam (#3463)', () => {
  function promotionEvidence(overrides = {}) {
    return {
      contract: CONTRACT,
      activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 }, version: 1 },
      candidateScore: { mean: 0.80, n: 40, ci: { lower: 0.72, upper: 0.88 }, version: 2 },
      ...overrides,
    };
  }

  function twoVersionRegistry() {
    const v1 = compileReplaceText({ parentVersion: 0 });
    const v2 = compileReplaceText({ parentVersion: v1.version, params: { path: 'a.txt', oldText: 'bar', newText: 'baz' } });
    const registry = createProcedureRegistry();
    for (const procedure of [v1, v2]) {
      registry.register({ workspaceId: 'ws-a', procedure, provenance: PROVENANCE });
      const input = procedure.version === 1 ? 'line with foo in it' : 'line with bar in it';
      const pass = qualify({ procedure, inputs: [input], apply: applySingleSite, observe: (value) => value });
      assert.equal(pass.ok, true);
      registry.recordQualification({ workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version, details: pass });
    }
    assert.equal(registry.setActiveVersion({ workspaceId: 'ws-a', kind: v1.kind, version: v1.version }).ok, true);
    return { registry, v1, v2 };
  }

  it('refuses promotion when the candidate interval does not clear the active version', () => {
    const { registry, v1, v2 } = twoVersionRegistry();
    const refused = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: v2.kind, version: v2.version,
      promotionEvidence: promotionEvidence({
        activeScore: { mean: 0.60, n: 40, ci: { lower: 0.50, upper: 0.70 }, version: v1.version },
        candidateScore: { mean: 0.62, n: 40, ci: { lower: 0.55, upper: 0.69 }, version: v2.version },
      }),
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, GATE_CODES.CI_NOT_CLEARED);
    assert.equal(registry.getActiveVersion({ workspaceId: 'ws-a', kind: v2.kind }).version, v1.version);
  });

  it('promotes when the candidate interval strictly clears the active version', () => {
    const { registry, v1, v2 } = twoVersionRegistry();
    const activated = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: v2.kind, version: v2.version,
      promotionEvidence: promotionEvidence({
        activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 }, version: v1.version },
        candidateScore: { mean: 0.80, n: 40, ci: { lower: 0.72, upper: 0.88 }, version: v2.version },
      }),
    });
    assert.equal(activated.ok, true);
    assert.equal(registry.getActiveVersion({ workspaceId: 'ws-a', kind: v2.kind }).version, v2.version);
  });

  it('refuses a promotion whose scores are not bound to the versions being compared', () => {
    const { registry, v2 } = twoVersionRegistry();
    const stale = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: v2.kind, version: v2.version,
      promotionEvidence: promotionEvidence({
        activeScore: { mean: 0.10, n: 40, ci: { lower: 0.05, upper: 0.15 }, version: 99 },
      }),
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, GATE_CODES.VERSION_MISMATCH);
  });

  it('reports INSUFFICIENT as a refusal, not a promotion', () => {
    const { registry, v2 } = twoVersionRegistry();
    const insufficient = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: v2.kind, version: v2.version,
      promotionEvidence: promotionEvidence({
        candidateScore: { mean: 0.90, n: 2, ci: { lower: 0.85, upper: 0.95 }, version: v2.version },
      }),
    });
    assert.equal(insufficient.ok, false);
    assert.equal(insufficient.code, GATE_CODES.INSUFFICIENT);
  });

  it('first activation and re-activation are not promotions, so refusing evidence does not block them', () => {
    const procedure = compileReplaceText();
    const registry = qualifiedRegistry(procedure);
    const refusing = {
      contract: CONTRACT,
      activeScore: { mean: 0.90, n: 40, ci: { lower: 0.85, upper: 0.95 } },
      candidateScore: { mean: 0.10, n: 40, ci: { lower: 0.05, upper: 0.15 } },
    };
    // No incumbent yet: nothing to clear.
    const first = registry.setActiveVersion({ workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version,
      promotionEvidence: refusing });
    assert.equal(first.ok, true);
    // Already active: idempotent, gate skipped even though the evidence refuses.
    const again = registry.setActiveVersion({ workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version,
      promotionEvidence: refusing });
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);
  });

  it('omitting the evidence keeps the pre-#3463 behaviour: qualification alone activates', () => {
    const procedure = compileReplaceText();
    const registry = qualifiedRegistry(procedure);
    const activated = registry.setActiveVersion({ workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version });
    assert.equal(activated.ok, true);
  });

  it('still refuses qualification-missing before the CI gate is ever consulted', () => {
    const procedure = compileReplaceText();
    const registry = createProcedureRegistry();
    registry.register({ workspaceId: 'ws-a', procedure, provenance: PROVENANCE });
    const result = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version,
      promotionEvidence: promotionEvidence(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.QUALIFICATION_MISSING);
  });
});
