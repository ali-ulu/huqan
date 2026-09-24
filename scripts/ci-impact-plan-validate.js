'use strict';

const { MUST_HAVE_PATTERNS } = require('./ci-impact-rules');
const { assertDerivedTestsSelected } = require('./ci-test-selection');
const { PLAN_SCHEMA_VERSION } = require('./ci-impact-plan-agent');
const { addMatchingTests } = require('./ci-impact-plan-paths');

function validateImpactPlan(plan, knownTests) {
  if (!plan || plan.schemaVersion !== PLAN_SCHEMA_VERSION) throw new Error('impact plan schemaVersion is invalid');
  if (!Array.isArray(plan.selectedTests) || !Array.isArray(plan.changedFiles)) throw new Error('impact plan arrays are invalid');
  const known = new Set(knownTests);
  const selected = [...new Set(plan.selectedTests)];
  if (selected.length !== plan.selectedTests.length) throw new Error('impact plan contains duplicate selected tests');
  const unknown = selected.filter((file) => !known.has(file));
  if (unknown.length > 0) throw new Error(`impact plan references unknown tests: ${unknown.join(', ')}`);
  if (!plan.runTests && selected.length > 0) throw new Error('non-runtime impact plan must not select tests');
  if (plan.runTests) {
    const mandatory = new Set();
    addMatchingTests(mandatory, new Map(), knownTests, MUST_HAVE_PATTERNS, 'mandatory');
    for (const file of mandatory) {
      if (!selected.includes(file)) throw new Error(`impact plan omitted mandatory test: ${file}`);
    }
  }
  if (plan.fullSuite && plan.runTests && selected.length !== knownTests.length) {
    throw new Error('full-suite impact plan must select every known test');
  }
  if (!plan.agent || !Array.isArray(plan.agent.addedTests)) throw new Error('impact plan agent metadata is invalid');
  for (const file of plan.agent.addedTests) {
    if (!selected.includes(file)) throw new Error(`agent-added test is absent from selectedTests: ${file}`);
  }
  if (!plan.dependencyDerived || !Array.isArray(plan.dependencyDerived.tests)) {
    throw new Error('impact plan dependency-derived metadata is invalid');
  }
  assertDerivedTestsSelected(plan.dependencyDerived.tests, selected);
  return true;
}

module.exports = { validateImpactPlan };
