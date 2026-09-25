'use strict';

/**
 * Experience Core — adapter scope and observation coverage (#2388).
 *
 * Pure: no I/O, no journal, no store. The behaviour under test is the one
 * `#2379` names — a required adapter that observed nothing refuses positive
 * learning, an unmeasured effect stays `unknown`, and an unsupported class
 * produces no invented event.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  ADAPTER_CLASSES,
  COVERAGE_VERDICTS,
  declareAdapterScope,
  resolveObservationCoverage,
  coverageProof,
} = require('../lib/experience/adapter-scope');
const { resolveLearningEligibility } = require('../lib/experience/contract');

describe('declareAdapterScope', () => {
  it('accepts an empty declaration', () => {
    const result = declareAdapterScope({});
    assert.equal(result.ok, true);
    assert.deepEqual(result.scope.installed, []);
    assert.deepEqual(result.scope.active, []);
    assert.deepEqual(result.scope.required, []);
  });

  it('freezes the scope so a caller cannot widen it after the fact', () => {
    const { scope } = declareAdapterScope({ installed: ['tool'], required: ['tool'] });
    assert.equal(Object.isFrozen(scope), true);
    assert.equal(Object.isFrozen(scope.required), true);
  });

  it('refuses an unknown class rather than ignoring it', () => {
    const result = declareAdapterScope({ installed: ['telepathy'] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unknown_adapter_class:telepathy');
  });

  it('refuses a duplicate class', () => {
    const result = declareAdapterScope({ required: ['tool', 'tool'] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'duplicate_adapter_class:tool');
  });

  it('refuses a non-list declaration', () => {
    assert.deepEqual(declareAdapterScope({ installed: 'tool' }),
      { ok: false, code: 'invalid_installed' });
    assert.deepEqual(declareAdapterScope({ active: 7 }),
      { ok: false, code: 'invalid_active' });
  });

  it('refuses an active class that was never installed', () => {
    // Active without installed is a contradiction, not a warning: the run
    // cannot have exercised what it did not have.
    const result = declareAdapterScope({ installed: ['tool'], active: ['browser'] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'active_not_installed:browser');
  });

  it('refuses a required class that was never installed', () => {
    const result = declareAdapterScope({ installed: ['tool'], required: ['network'] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'required_not_installed:network');
  });
});

describe('resolveObservationCoverage', () => {
  const scope = (input) => declareAdapterScope(input).scope;

  it('covers a required class that observed something', () => {
    const report = resolveObservationCoverage(scope({ installed: ['tool'], required: ['tool'] }), ['tool']);
    assert.equal(report.perClass.tool, COVERAGE_VERDICTS.COVERED);
    assert.equal(report.coverage, true);
    assert.deepEqual(report.missingRequired, []);
  });

  it('refuses the coverage proof when a required adapter observed nothing', () => {
    // The rule #2379 states: gerekli adapter eksikse positive learning
    // reddedilir. It is refused by name, not silently.
    const report = resolveObservationCoverage(
      scope({ installed: ['tool', 'browser'], required: ['tool', 'browser'] }), ['tool'],
    );
    assert.equal(report.coverage, false);
    assert.deepEqual(report.missingRequired, ['browser']);
    assert.equal(report.perClass.browser, COVERAGE_VERDICTS.UNKNOWN);
  });

  it('leaves an unmeasured installed adapter unknown, not unsupported', () => {
    // The distinction the phase turns on: we did not observe it. Reading that
    // as "it did not happen" is the defect.
    const report = resolveObservationCoverage(scope({ installed: ['tool', 'network'] }), ['tool']);
    assert.equal(report.perClass.network, COVERAGE_VERDICTS.UNKNOWN);
    assert.deepEqual(report.unknown, ['network']);
  });

  it('reports a class the run never had as unsupported, without inventing an event', () => {
    const report = resolveObservationCoverage(scope({ installed: ['tool'] }), ['tool']);
    assert.equal(report.perClass.a2a, COVERAGE_VERDICTS.UNSUPPORTED);
    assert.equal(report.perClass.external_outcome, COVERAGE_VERDICTS.UNSUPPORTED);
    assert.equal(report.unknown.includes('a2a'), false);
    assert.equal(report.missingRequired.includes('a2a'), false);
  });

  it('gives every class in the taxonomy a verdict', () => {
    const report = resolveObservationCoverage(scope({ installed: ['tool'] }), ['tool']);
    assert.deepEqual(Object.keys(report.perClass).sort(), [...ADAPTER_CLASSES].sort());
  });

  it('does not claim coverage from an empty declaration', () => {
    // No required classes means nothing was promised, which is not the same
    // as everything being covered. `coverage: false` with no named gap is the
    // honest answer, and it must stay distinguishable from a named gap.
    const report = resolveObservationCoverage(scope({}), []);
    assert.equal(report.coverage, false);
    assert.deepEqual(report.missingRequired, []);
  });

  it('does not let an unobserved class be covered by a similarly named one', () => {
    const report = resolveObservationCoverage(scope({ installed: ['tool'], required: ['tool'] }), ['tools']);
    assert.equal(report.coverage, false);
    assert.deepEqual(report.missingRequired, ['tool']);
  });

  it('ignores an unknown observed class rather than crediting it', () => {
    const report = resolveObservationCoverage(scope({ installed: ['tool'], required: ['tool'] }), ['telepathy']);
    assert.equal(report.coverage, false);
    assert.deepEqual(report.missingRequired, ['tool']);
  });

  it('is deterministic and order-independent', () => {
    const a = resolveObservationCoverage(scope({ installed: ['tool', 'browser'], required: ['tool', 'browser'] }), ['browser', 'tool']);
    const b = resolveObservationCoverage(scope({ installed: ['browser', 'tool'], required: ['browser', 'tool'] }), ['tool', 'browser']);
    assert.deepEqual(a, b);
  });
});

describe('coverageProof feeds resolveLearningEligibility', () => {
  const fullProofs = (coverage) => ({
    integrity: true, coverage, verification: true, provenance: true, permission: true,
  });

  it('withholds positive_procedure when a required adapter is missing', () => {
    const { scope } = declareAdapterScope({ installed: ['tool', 'browser'], required: ['tool', 'browser'] });
    const proof = coverageProof(scope, ['tool']);
    const eligibility = resolveLearningEligibility({
      executionStatus: 'completed', outcomeStatus: 'verified', proofs: fullProofs(proof.coverage),
    });
    assert.equal(proof.coverage, false);
    assert.notEqual(eligibility.eligibility, 'positive_procedure');
    assert.equal(eligibility.eligibility, 'ineligible');
  });

  it('allows positive_procedure once every required adapter was observed', () => {
    const { scope } = declareAdapterScope({ installed: ['tool', 'browser'], required: ['tool', 'browser'] });
    const proof = coverageProof(scope, ['tool', 'browser']);
    const eligibility = resolveLearningEligibility({
      executionStatus: 'completed', outcomeStatus: 'verified', proofs: fullProofs(proof.coverage),
    });
    assert.equal(proof.coverage, true);
    assert.equal(eligibility.eligibility, 'positive_procedure');
  });

  it('carries the report so the refusal stays explainable', () => {
    const { scope } = declareAdapterScope({ installed: ['terminal'], required: ['terminal'] });
    const proof = coverageProof(scope, []);
    assert.deepEqual(proof.report.missingRequired, ['terminal']);
  });
});
