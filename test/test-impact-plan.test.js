'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  IMPACT_RULES,
  MUST_HAVE_PATTERNS,
  buildTestImpactPlan,
  discoverKnownTests,
  isRuntimeOrTestFile,
  matchesPattern,
  validateAgentPlan,
  validateImpactPlan,
} = require('../scripts/ci-impact-plan');

const knownTests = discoverKnownTests();

function tempPlan(contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-agent-plan-'));
  const file = path.join(directory, 'agent-test-plan.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  return { directory, file };
}

test('path classifier is fail-closed for root production JavaScript', () => {
  assert.equal(isRuntimeOrTestFile('new-root-module.js'), true);
  assert.equal(isRuntimeOrTestFile('docs/new-guide.md'), false);
  assert.equal(isRuntimeOrTestFile('test/new-test.test.js'), true);
  assert.equal(isRuntimeOrTestFile('unknown/nested-file.txt'), false);
});

test('glob matcher handles nested impact patterns without matching siblings', () => {
  assert.equal(matchesPattern('lib/memory-store.js', 'lib/memory-*.js'), true);
  assert.equal(matchesPattern('lib/memory/nested.js', 'lib/memory-*.js'), false);
  assert.equal(matchesPattern('test/v4-wb2d-memory-context-route-smoke.test.js', 'test/v4-wb*.test.js'), true);
  assert.equal(matchesPattern('test/v5-c5-external-conformance.test.js', 'test/a2a-*.test.js'), false);
});

test('docs-only plan selects no runtime tests when the classifier says no', () => {
  const plan = buildTestImpactPlan({
    changedFiles: ['docs/guide.md'],
    runtimeOrTest: false,
  });
  assert.equal(plan.runTests, false);
  assert.equal(plan.fullSuite, false);
  assert.deepEqual(plan.selectedTests, []);
});

test('changed graph surface plan includes the mandatory safety union and graph impact tests', () => {
  const plan = buildTestImpactPlan({
    changedFiles: ['graph.js'],
    runtimeOrTest: true,
  });
  assert.equal(plan.runTests, true);
  assert.equal(plan.fullSuite, false);
  assert.ok(plan.selectedTests.includes('graph.test.js'));
  assert.ok(plan.selectedTests.includes('test/mutation-journal-fail-closed.test.js'));
  assert.ok(plan.selectedTests.includes('test/receipt-read-chain-integrity.test.js'));
  assert.ok(plan.selectedTestCount < plan.knownTestCount);
  assert.ok(plan.matchedImpactRules.includes('graph-kernel-memory'));
});

test('the wiring-debt ratchet stays in the mandatory selection floor', () => {
  // #3014's ratchet reads the live reachability surface and pins it to a
  // recorded baseline, so it is not reachable from any changed file and the
  // dependency graph can never select it. Pin it to the floor with the exact
  // change #3170 made: a new leaf benchmark module that nothing requires.
  const plan = buildTestImpactPlan({
    changedFiles: ['benchmarks/bench-scale-10k.js'],
    runtimeOrTest: true,
  });
  assert.equal(plan.runTests, true);
  assert.ok(
    plan.mandatoryPatterns.includes('test/reachability-baseline.test.js'),
    'the reachability ratchet must be in the mandatory floor',
  );
  assert.ok(
    plan.selectedTests.includes('test/reachability-baseline.test.js'),
    'a change that moves the unreachable total must select the ratchet that pins it',
  );
});

test('package and workflow changes fail closed to the complete known test set', () => {
  for (const changedFile of ['package.json', 'package-lock.json', '.github/workflows/benchmark.yml']) {
    const plan = buildTestImpactPlan({ changedFiles: [changedFile], runtimeOrTest: true });
    assert.equal(plan.fullSuite, true, changedFile);
    assert.deepEqual(plan.selectedTests, knownTests, changedFile);
    assert.match(plan.fallbackReason, /high-risk/);
  }
});

test('valid agent plan can add known tests but cannot reduce deterministic coverage', () => {
  const selected = tempPlan({
    schemaVersion: 1,
    addTests: ['test/v5-c5-external-conformance.test.js'],
    confidence: 'high',
    rationale: 'graph evidence crosses the external trust package boundary',
    fallback: 'none',
  });
  try {
    const plan = buildTestImpactPlan({
      changedFiles: ['graph.test.js'],
      runtimeOrTest: true,
      agentPlanPath: selected.file,
    });
    assert.equal(plan.agent.status, 'valid');
    assert.ok(plan.agent.addedTests.includes('test/v5-c5-external-conformance.test.js'));
    assert.ok(plan.selectedTests.includes('test/mutation-journal-fail-closed.test.js'));
    assert.ok(plan.selectedTests.includes('test/v5-c5-external-conformance.test.js'));
  } finally {
    fs.rmSync(selected.directory, { recursive: true, force: true });
  }
});

test('invalid or low-confidence agent plan falls back to the complete set', () => {
  const invalid = tempPlan({
    schemaVersion: 1,
    addTests: ['test/does-not-exist.test.js'],
    confidence: 'high',
    rationale: 'invalid file reference',
  });
  try {
    const plan = buildTestImpactPlan({
      changedFiles: ['graph.test.js'],
      runtimeOrTest: true,
      agentPlanPath: invalid.file,
    });
    assert.equal(plan.agent.status, 'invalid');
    assert.equal(plan.fullSuite, true);
    assert.deepEqual(plan.selectedTests, knownTests);
  } finally {
    fs.rmSync(invalid.directory, { recursive: true, force: true });
  }

  assert.throws(
    () => validateAgentPlan({
      schemaVersion: 1,
      addTests: [],
      removeTests: ['test/graph.test.js'],
      confidence: 'high',
    }, knownTests),
    /removeTests|not allowed/,
  );
});

test('nightly and release modes select every discovered test', () => {
  for (const mode of ['nightly', 'release']) {
    const plan = buildTestImpactPlan({
      changedFiles: [],
      runtimeOrTest: true,
      mode,
    });
    assert.equal(plan.fullSuite, true, mode);
    assert.deepEqual(plan.selectedTests, knownTests, mode);
  }
});

test('public UI changes select UI impact tests without forcing the full suite', () => {
  const plan = buildTestImpactPlan({
    changedFiles: ['public/index.html'],
    runtimeOrTest: false,
  });
  assert.equal(plan.runTests, true);
  assert.equal(plan.fullSuite, false);
  assert.ok(plan.matchedImpactRules.includes('ui-workbench'));
  assert.ok(plan.selectedTests.some((file) => file.startsWith('test/ui-') || file.startsWith('test/v4-wb')));
  assert.equal(validateImpactPlan(plan, knownTests), true);
});

test('a README-only change runs the tests that pin the README (#3895)', () => {
  const plan = buildTestImpactPlan({ changedFiles: ['README.md'], runtimeOrTest: false });
  assert.equal(plan.runTests, true);
  assert.equal(plan.fullSuite, false);
  assert.ok(plan.selectedTests.includes('test/readme-inventory-pin.test.js'));
  assert.ok(plan.selectedTests.includes('test/readme-decision-vocabulary.test.js'));
});

test('every selection pattern matches a discovered test, so none is silently dead', () => {
  // A pattern that matches no file is worse than a missing one: the plan looks
  // healthy, the union is a name shorter, and nothing fails. #2610 wrote
  // `test/path-containment-*.test.js` and `test/reasonSandbox.test.js` for two
  // tests that have always lived at the repository root, so neither glob ever
  // matched and both security-critical tests sat outside the mandatory floor
  // from the day the rules were authored.
  const patterns = [...new Set([...MUST_HAVE_PATTERNS, ...IMPACT_RULES.flatMap((rule) => rule.tests)])];
  const dead = patterns.filter((pattern) => !knownTests.some((file) => matchesPattern(file, pattern)));
  assert.deepEqual(dead, [], `selection patterns match no discovered test: ${dead.join(', ')}`);
});

test('the mandatory floor keeps the path-containment safety test on an impact-only change', () => {
  // An impact-only surface (a root document) is exactly where the hand-written
  // rules are the only selector: the dependency graph reaches nothing, so a dead
  // pattern in the floor is a silent omission.
  const plan = buildTestImpactPlan({ changedFiles: ['README.md'], runtimeOrTest: false });
  assert.equal(plan.runTests, true);
  assert.equal(plan.fullSuite, false);
  assert.ok(
    plan.selectedTests.includes('path-containment-386.test.js'),
    'the CLI path-containment safety test must stay in the mandatory floor',
  );
});
