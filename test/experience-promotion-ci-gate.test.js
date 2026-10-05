'use strict';

/**
 * Promotion CI gate tests (#3463, R08).
 *
 * The pure gate is characterized directly (a disjoint interval promotes, a
 * touching or overlapping interval is refused, too few samples is
 * INSUFFICIENT, malformed input is refused), and then the registry seam is
 * exercised with real `compiler.js`/`qualify()` output so the optional
 * `promotionEvidence` wiring is proven end to end: a candidate whose interval
 * does not clear the incumbent's leaves the active pointer where it was, and
 * the evidence is optional so an unmeasured activation is unchanged.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  GATE_STATUS,
  GATE_CODES,
  DIRECTIONS,
  lockPromotionContract,
  evaluatePromotionGate,
} = require('../lib/experience/promotion-ci-gate');
const { compile, qualify, KINDS } = require('../lib/experience/compiler');
const { createProcedureRegistry, CODES } = require('../lib/experience/procedure-registry');

const CONTRACT = Object.freeze({ direction: DIRECTIONS.HIGHER_IS_BETTER, confidenceLevel: 0.95, minSamples: 10 });
const LOWER_CONTRACT = Object.freeze({ direction: DIRECTIONS.LOWER_IS_BETTER, confidenceLevel: 0.95, minSamples: 10 });

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
      const result = evaluatePromotionGate({
        contract,
        activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 } },
        candidateScore: { mean: 0.75, n: 40, ci: { lower: 0.70, upper: 0.80 } },
      });
      assert.equal(result.ok, false, `contract ${JSON.stringify(contract)} must be refused`);
      assert.equal(result.code, GATE_CODES.INVALID_CONTRACT);
    }
    assert.equal(lockPromotionContract(CONTRACT).ok, true);
  });

  it('fails closed on a malformed score: non-finite mean, bad n, inverted or non-finite interval', () => {
    const bad = [
      undefined,
      { mean: NaN, n: 40, ci: { lower: 0.5, upper: 0.6 } },
      { mean: 0.6, n: -1, ci: { lower: 0.5, upper: 0.6 } },
      { mean: 0.6, n: 40, ci: { lower: 0.7, upper: 0.5 } },
      { mean: 0.6, n: 40, ci: { lower: Infinity, upper: 0.6 } },
      { mean: 0.6, n: 40, ci: null },
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
});

describe('Promotion CI gate: registry seam (#3463)', () => {
  it('refuses activation when the supplied candidate interval does not clear the active version', () => {
    const procedure = compileReplaceText();
    const registry = qualifiedRegistry(procedure);

    const refused = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version,
      promotionEvidence: {
        contract: CONTRACT,
        activeScore: { mean: 0.60, n: 40, ci: { lower: 0.50, upper: 0.70 } },
        candidateScore: { mean: 0.62, n: 40, ci: { lower: 0.55, upper: 0.69 } },
      },
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, GATE_CODES.CI_NOT_CLEARED);
    assert.equal(registry.getActiveVersion({ workspaceId: 'ws-a', kind: procedure.kind }).code, CODES.NO_ACTIVE_VERSION);
  });

  it('activates when the supplied candidate interval strictly clears the active version', () => {
    const procedure = compileReplaceText();
    const registry = qualifiedRegistry(procedure);

    const activated = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version,
      promotionEvidence: {
        contract: CONTRACT,
        activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 } },
        candidateScore: { mean: 0.80, n: 40, ci: { lower: 0.72, upper: 0.88 } },
      },
    });
    assert.equal(activated.ok, true);
    assert.equal(registry.getActiveVersion({ workspaceId: 'ws-a', kind: procedure.kind }).version, procedure.version);
  });

  it('reports INSUFFICIENT as a refusal, not a promotion', () => {
    const procedure = compileReplaceText();
    const registry = qualifiedRegistry(procedure);

    const insufficient = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version,
      promotionEvidence: {
        contract: CONTRACT,
        activeScore: { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 } },
        candidateScore: { mean: 0.90, n: 2, ci: { lower: 0.85, upper: 0.95 } },
      },
    });
    assert.equal(insufficient.ok, false);
    assert.equal(insufficient.code, GATE_CODES.INSUFFICIENT);
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
      promotionEvidence: {
        contract: CONTRACT,
        activeScore: { mean: 0.10, n: 40, ci: { lower: 0.05, upper: 0.15 } },
        candidateScore: { mean: 0.90, n: 40, ci: { lower: 0.85, upper: 0.95 } },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.QUALIFICATION_MISSING);
  });
});
