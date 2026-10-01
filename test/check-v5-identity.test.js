'use strict';

/**
 * check:v5-identity tests (#3235).
 *
 * The gate shipped into CI in #3227 with no test of its own, unlike its
 * siblings (`test/check-coverage.test.js`, `test/enforcement-coverage.test.js`).
 * `buildAgentIdentityReadinessIndex` is well covered by
 * `test/v5-agent-identity-readiness*.test.js`, but the *verdict* — the four
 * conditions that decide pass/fail — was not. A gate whose failing branches
 * have never been exercised is not evidence that it can fail.
 *
 * The four conditions are independent failure modes, so each is flipped on its
 * own against a real index: the gate must reject every one of them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  NON_ENFORCEMENT_BOUNDARY,
  evaluateIdentityReadiness,
  main,
} = require('../scripts/check-v5-identity-readiness');
const { buildAgentIdentityReadinessIndex } = require('../schemas/v5/agent-identity-readiness');

const REPO_ROOT = path.resolve(__dirname, '..');

/** A deep-enough copy of a real index, so a flip cannot leak into another case. */
function realIndex() {
  return structuredClone(buildAgentIdentityReadinessIndex({ repoRoot: REPO_ROOT }));
}

test('the real repository passes and reports the measured boundary', () => {
  const report = evaluateIdentityReadiness(realIndex());

  assert.equal(report.ok, true);
  assert.equal(report.agentIdentityChainComplete, true);
  assert.equal(report.readyForRuntimeEnforcement, false);
  assert.equal(report.nonEnforcementBoundary, true);
  assert.equal(typeof report.conformance.totalFixtures, 'number');
  assert.equal(typeof report.conformance.passed, 'number');
  assert.equal(typeof report.conformance.failed, 'number');
});

test('the gate fires when the identity chain is incomplete', () => {
  const index = realIndex();
  index.agentIdentityChainComplete = false;

  const report = evaluateIdentityReadiness(index);
  assert.equal(report.ok, false);
  assert.equal(report.agentIdentityChainComplete, false);
});

test('the gate fires when runtime enforcement is claimed', () => {
  const index = realIndex();
  index.readyForRuntimeEnforcement = true;

  const report = evaluateIdentityReadiness(index);
  assert.equal(report.ok, false);
  assert.equal(report.readyForRuntimeEnforcement, true);
});

test('the gate fires when conformance does not pass', () => {
  const index = realIndex();
  index.coverage.conformanceSummary.ok = false;

  assert.equal(evaluateIdentityReadiness(index).ok, false);
});

test('the gate fires when the non-enforcement boundary leaves the non-claims', () => {
  const index = realIndex();
  index.nonClaims = index.nonClaims.filter((claim) => claim !== NON_ENFORCEMENT_BOUNDARY);

  const report = evaluateIdentityReadiness(index);
  assert.equal(report.ok, false);
  assert.equal(report.nonEnforcementBoundary, false);
});

test('main() exits 0 for the real repository and emits parseable JSON', () => {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(chunk); return true; };
  let status;
  try {
    status = main();
  } finally {
    process.stdout.write = original;
  }

  assert.equal(status, 0);
  const report = JSON.parse(written.join(''));
  assert.equal(report.ok, true);
  assert.equal(report.nonEnforcementBoundary, true);
});
