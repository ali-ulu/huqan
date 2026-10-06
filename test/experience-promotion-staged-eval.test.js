'use strict';

/**
 * Staged promotion gate tests (#3466, R11).
 *
 * Hermetic: no I/O, no storage, no timers. The staged trial is the real
 * `evaluateCanaryTrial()` and the CI comparison is the real
 * `evaluatePromotionGate()`; nothing here is mocked, so the composition is
 * exercised end to end.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  STAGED_CODES,
  evaluateStagedPromotion,
  stagedPromotionEvidence,
  guardStagedPromotion,
} = require('../lib/experience/promotion-staged-eval');
const { GATE_STATUS, GATE_CODES, lockPromotionContract } = require('../lib/experience/promotion-ci-gate');
const { MIN_CANARY_SAMPLE_SIZE } = require('../lib/experience/canary');
const { compile, qualify, KINDS } = require('../lib/experience/compiler');
const { createProcedureRegistry, CODES } = require('../lib/experience/procedure-registry');

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60 * 1000;
const PROVENANCE = Object.freeze({ sourceSha: 'sha-1', procedureVersion: '1', configHash: 'cfg-1' });

const CONTRACT = lockPromotionContract({
  direction: 'higher-is-better', confidenceLevel: 0.95, minSamples: 10,
}).contract;

function run(i, { negative = false, executionCost = 1, verificationCost = 1, declared } = {}) {
  return {
    occurredAt: T0 + i * MIN,
    declared: declared || { endpoint: 'replace_text', lang: 'en' },
    learningEligibility: negative ? 'negative_example' : 'positive_procedure',
    executionCost,
    verificationCost,
    canaryOverheadCost: 0,
  };
}

function makeRuns(count, opts) {
  return Array.from({ length: count }, (_, i) => run(i, opts));
}

/** A trial that passes: candidate strictly cheaper than baseline, enough samples. */
function passingTrial() {
  return {
    candidateRuns: makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 1, verificationCost: 1 }),
    baselineWindowRuns: makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 10, verificationCost: 10 }),
    startAt: T0,
  };
}

/** A trial still in progress: too few samples and the cap is not reached. */
function inTrial() {
  return {
    candidateRuns: makeRuns(3, { executionCost: 1, verificationCost: 1 }),
    baselineWindowRuns: makeRuns(3, { executionCost: 10, verificationCost: 10 }),
    startAt: T0,
    now: T0,
  };
}

const CLEARING_ACTIVE = { mean: 0.60, n: 40, ci: { lower: 0.55, upper: 0.65 }, version: 1 };
const CLEARING_CANDIDATE = { mean: 0.80, n: 40, ci: { lower: 0.72, upper: 0.88 }, version: 2 };

describe('Staged promotion gate: staged trial must pass first (#3466)', () => {
  it('promotes only when the trial passed AND the interval strictly clears the incumbent', () => {
    const verdict = evaluateStagedPromotion({
      trial: passingTrial(), activeScore: CLEARING_ACTIVE, candidateScore: CLEARING_CANDIDATE, contract: CONTRACT,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.status, GATE_STATUS.PROMOTE);
    assert.equal(verdict.staged.status, 'passed');
  });

  it('an in-trial (under-sampled) hypothesis is INSUFFICIENT, never a promotion', () => {
    const verdict = evaluateStagedPromotion({
      trial: inTrial(), activeScore: CLEARING_ACTIVE, candidateScore: CLEARING_CANDIDATE, contract: CONTRACT,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.status, GATE_STATUS.INSUFFICIENT);
    assert.equal(verdict.code, STAGED_CODES.STAGED_NOT_PASSED);
    assert.equal(verdict.promotion, null);
    assert.equal(verdict.staged.status, 'in_trial');
  });

  it('a trial that failed (candidate did not clear baseline) refuses before the CI gate runs', () => {
    const trial = {
      candidateRuns: makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 10, verificationCost: 10 }),
      baselineWindowRuns: makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 1, verificationCost: 1 }),
      startAt: T0,
    };
    const verdict = evaluateStagedPromotion({
      trial, activeScore: CLEARING_ACTIVE, candidateScore: CLEARING_CANDIDATE, contract: CONTRACT,
    });
    assert.equal(verdict.status, GATE_STATUS.REFUSE);
    assert.equal(verdict.code, STAGED_CODES.STAGED_NOT_PASSED);
    assert.equal(verdict.staged.reason, 'did_not_clear_baseline');
  });

  it('a cap reached without enough evidence fails closed (REFUSE, not pass)', () => {
    const trial = {
      candidateRuns: makeRuns(3, { executionCost: 1, verificationCost: 1 }),
      baselineWindowRuns: makeRuns(3, { executionCost: 10, verificationCost: 10 }),
      startAt: T0, maxRuns: 3, now: T0 + 100 * MIN,
    };
    const verdict = evaluateStagedPromotion({
      trial, activeScore: CLEARING_ACTIVE, candidateScore: CLEARING_CANDIDATE, contract: CONTRACT,
    });
    assert.equal(verdict.status, GATE_STATUS.REFUSE);
    assert.equal(verdict.staged.reason, 'cap_reached_insufficient_sample');
  });

  it('a shape-refused comparison never reaches the CI gate', () => {
    const trial = {
      candidateRuns: makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 1, verificationCost: 1, declared: { endpoint: 'a' } }),
      baselineWindowRuns: makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 10, verificationCost: 10, declared: { endpoint: 'b' } }),
      startAt: T0,
    };
    const verdict = evaluateStagedPromotion({
      trial, activeScore: CLEARING_ACTIVE, candidateScore: CLEARING_CANDIDATE, contract: CONTRACT,
    });
    assert.equal(verdict.status, GATE_STATUS.REFUSE);
    assert.equal(verdict.code, STAGED_CODES.STAGED_NOT_PASSED);
    assert.equal(verdict.staged.code, 'comparison_refused_no_shape_overlap');
  });

  it('a passed trial still has to clear the CI gate: overlapping intervals refuse', () => {
    const verdict = evaluateStagedPromotion({
      trial: passingTrial(),
      activeScore: { mean: 0.60, n: 40, ci: { lower: 0.50, upper: 0.70 }, version: 1 },
      candidateScore: { mean: 0.62, n: 40, ci: { lower: 0.55, upper: 0.69 }, version: 2 },
      contract: CONTRACT,
    });
    assert.equal(verdict.status, GATE_STATUS.REFUSE);
    assert.equal(verdict.code, GATE_CODES.CI_NOT_CLEARED);
    assert.equal(verdict.staged.status, 'passed');
  });

  it('a passed trial with too few CI samples is INSUFFICIENT, not a promotion', () => {
    const verdict = evaluateStagedPromotion({
      trial: passingTrial(),
      activeScore: { mean: 0.60, n: 2, ci: { lower: 0.55, upper: 0.65 }, version: 1 },
      candidateScore: { mean: 0.80, n: 2, ci: { lower: 0.72, upper: 0.88 }, version: 2 },
      contract: CONTRACT,
    });
    assert.equal(verdict.status, GATE_STATUS.INSUFFICIENT);
    assert.equal(verdict.code, GATE_CODES.INSUFFICIENT);
  });

  it('malformed input fails closed without throwing', () => {
    assert.equal(evaluateStagedPromotion({ trial: null }).ok, false);
    assert.equal(evaluateStagedPromotion({ trial: null }).code, STAGED_CODES.INVALID_TRIAL);
    assert.equal(evaluateStagedPromotion().ok, false);
    const badContract = evaluateStagedPromotion({
      trial: passingTrial(), activeScore: CLEARING_ACTIVE, candidateScore: CLEARING_CANDIDATE,
      contract: { direction: 'higher-is-better', confidenceLevel: 0.95, minSamples: 10 },
    });
    assert.equal(badContract.ok, false);
    assert.equal(badContract.code, STAGED_CODES.INVALID_EVIDENCE);
  });
});

describe('Staged promotion gate: fail-closed hand-off (#3466)', () => {
  it('yields no evidence object from a trial that has not passed', () => {
    const derived = stagedPromotionEvidence({
      trial: inTrial(), activeScore: CLEARING_ACTIVE, candidateScore: CLEARING_CANDIDATE, contract: CONTRACT,
    });
    assert.equal(derived.ok, false);
    assert.equal(derived.code, STAGED_CODES.STAGED_NOT_PASSED);
    assert.equal(derived.promotionEvidence, undefined);
  });

  it('yields the registry-shaped evidence only from a passed, clearing trial', () => {
    const derived = stagedPromotionEvidence({
      trial: passingTrial(), activeScore: CLEARING_ACTIVE, candidateScore: CLEARING_CANDIDATE, contract: CONTRACT,
    });
    assert.equal(derived.ok, true);
    assert.equal(derived.promotionEvidence.activeScore, CLEARING_ACTIVE);
    assert.equal(derived.promotionEvidence.contract, CONTRACT);
  });

  it('guardStagedPromotion passes the pre-derived evidence through and refuses the ambiguous both-forms call', () => {
    assert.deepEqual(guardStagedPromotion({ promotionEvidence: { x: 1 } }).promotionEvidence, { x: 1 });
    assert.equal(guardStagedPromotion({ promotionEvidence: {}, stagedEvidence: {} }).ok, false);
    assert.equal(guardStagedPromotion({
      stagedEvidence: { trial: inTrial(), activeScore: CLEARING_ACTIVE, candidateScore: CLEARING_CANDIDATE, contract: CONTRACT },
    }).ok, false);
  });
});

describe('Staged promotion gate: registry seam (#3466)', () => {
  function candidate(sources = ['src-1']) {
    return Object.freeze({
      status: 'candidate',
      trace: Object.freeze({ sources: Object.freeze([...sources]), scope: Object.freeze({ repo: 'huqan' }), revision: 'rev-1' }),
    });
  }

  function compileReplaceText(overrides = {}) {
    const result = compile({
      candidate: candidate(), kind: KINDS.REPLACE_TEXT,
      params: { path: 'a.txt', oldText: 'foo', newText: 'bar' }, parentVersion: 0, ...overrides,
    });
    assert.equal(result.ok, true, 'fixture compile() must succeed');
    return result.procedure;
  }

  function applySingleSite(procedure, input) {
    return { sites: 1, after: input.replace(procedure.params.oldText, procedure.params.newText) };
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

  function staged(overrides = {}) {
    return {
      trial: passingTrial(),
      activeScore: { ...CLEARING_ACTIVE, version: 1 },
      candidateScore: { ...CLEARING_CANDIDATE, version: 2 },
      contract: CONTRACT,
      ...overrides,
    };
  }

  it('promotes through the registry only from a passed staged trial with a clearing interval', () => {
    const { registry, v1, v2 } = twoVersionRegistry();
    const activated = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: v2.kind, version: v2.version, stagedEvidence: staged(),
    });
    assert.equal(activated.ok, true);
    assert.equal(registry.getActiveVersion({ workspaceId: 'ws-a', kind: v2.kind }).version, v2.version);
    void v1;
  });

  it('refuses an in-trial staged promotion and leaves the pointer alone', () => {
    const { registry, v1, v2 } = twoVersionRegistry();
    const refused = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: v2.kind, version: v2.version, stagedEvidence: staged({ trial: inTrial() }),
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, STAGED_CODES.STAGED_NOT_PASSED);
    assert.equal(registry.getActiveVersion({ workspaceId: 'ws-a', kind: v2.kind }).version, v1.version);
  });

  it('refuses a passed-but-not-clearing staged promotion with the CI code', () => {
    const { registry, v2 } = twoVersionRegistry();
    const refused = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: v2.kind, version: v2.version,
      stagedEvidence: staged({
        activeScore: { mean: 0.60, n: 40, ci: { lower: 0.50, upper: 0.70 }, version: 1 },
        candidateScore: { mean: 0.62, n: 40, ci: { lower: 0.55, upper: 0.69 }, version: 2 },
      }),
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, GATE_CODES.CI_NOT_CLEARED);
  });

  it('refuses supplying both promotionEvidence and stagedEvidence (the two could disagree)', () => {
    const { registry, v2 } = twoVersionRegistry();
    const both = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: v2.kind, version: v2.version,
      promotionEvidence: { activeScore: CLEARING_ACTIVE, candidateScore: CLEARING_CANDIDATE, contract: CONTRACT },
      stagedEvidence: staged(),
    });
    assert.equal(both.ok, false);
    assert.equal(both.code, STAGED_CODES.INVALID_EVIDENCE);
  });

  it('still refuses qualification-missing before the staged gate is ever consulted', () => {
    const procedure = compileReplaceText();
    const registry = createProcedureRegistry();
    registry.register({ workspaceId: 'ws-a', procedure, provenance: PROVENANCE });
    const result = registry.setActiveVersion({
      workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version, stagedEvidence: staged(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.QUALIFICATION_MISSING);
  });
});
