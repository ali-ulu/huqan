'use strict';

const { REPO_ROOT } = require('./ci-shard-manifest');
const { buildDependencyIndex, selectionPlan } = require('./ci-test-selection');
const { FULL_SUITE_PATTERNS, IMPACT_ONLY_PATTERNS, IMPACT_RULES, MUST_HAVE_PATTERNS } = require('./ci-impact-rules');
const { discoverKnownTests, readChangedFiles, isRuntimeOrTestFile, matchesAny, addMatchingTests } = require('./ci-impact-plan-paths');
const { PLAN_SCHEMA_VERSION, loadAgentPlan } = require('./ci-impact-plan-agent');

function buildTestImpactPlan({ root = REPO_ROOT, base, head, changedFiles, mode = 'pr', runtimeOrTest, agentPlanPath, dependencyIndex } = {}) {
  const knownTests = discoverKnownTests(root);
  const changed = (!changedFiles && (mode === 'nightly' || mode === 'release') && (!base || !head))
    ? []
    : readChangedFiles({ root, base, head, changedFiles });
  const runtimeSignal = runtimeOrTest === undefined
    ? changed.some(isRuntimeOrTestFile)
    : Boolean(runtimeOrTest);
  const allTests = mode === 'nightly' || mode === 'release';
  const fullByPath = matchesAny(changed, FULL_SUITE_PATTERNS);
  const impactOnlyByPath = matchesAny(changed, IMPACT_ONLY_PATTERNS);
  const shouldRun = allTests || runtimeSignal || fullByPath || impactOnlyByPath;
  const deterministic = new Set();
  const reasons = new Map();
  let matchedRuleNames = [];
  let dependencyDerived = { tests: [], source: 'not-run' };

  if (shouldRun) {
    addMatchingTests(deterministic, reasons, knownTests, MUST_HAVE_PATTERNS, 'mandatory safety and contract union');
    for (const changedFile of changed) {
      if (knownTests.includes(changedFile)) {
        deterministic.add(changedFile);
        reasons.set(changedFile, ['changed test file']);
      }
      for (const rule of IMPACT_RULES) {
        if (!matchesAny(changedFile, rule.changed)) continue;
        matchedRuleNames.push(rule.name);
        addMatchingTests(deterministic, reasons, knownTests, rule.tests, `impact rule: ${rule.name}`);
      }
    }

    // Dependency-derived selection (#2610). The glob rules above are a
    // hand-maintained description of the tree, and #2505 C is what happens when
    // that description drifts: the plan looked healthy and selected none of the
    // five suites that then failed on main. This layer asks the source directly.
    // It only ever adds tests, so the union and the rules above remain the floor.
    const derived = selectionPlan(changed, dependencyIndex || buildDependencyIndex({ root }));
    dependencyDerived.tests = derived.tests;
    dependencyDerived.source = 'require graph plus named-file references';
    for (const [file, why] of derived.reasons) {
      if (!reasons.has(file)) reasons.set(file, []);
      for (const reason of why) {
        if (!reasons.get(file).includes(reason)) reasons.get(file).push(reason);
      }
      deterministic.add(file);
    }
  }

  const agent = loadAgentPlan({ root, agentPlanPath, knownTests });
  const fallbackFull = allTests || fullByPath || agent.status === 'invalid' || agent.confidence === 'low' || agent.fallback === 'full';
  const selected = fallbackFull && shouldRun ? [...knownTests] : [...deterministic, ...agent.addTests].filter((file, index, list) => list.indexOf(file) === index).sort();
  const selectedTests = selected.filter((file) => knownTests.includes(file));
  const selectedReasons = Object.fromEntries(selectedTests.map((file) => [file, reasons.get(file) || (agent.addTests.includes(file) ? ['agent addition'] : ['full-suite fallback'])]));

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    mode,
    base: base || null,
    head: head || null,
    changedFiles: changed,
    runTests: shouldRun,
    fullSuite: fallbackFull && shouldRun,
    knownTestCount: knownTests.length,
    selectedTestCount: selectedTests.length,
    selectedTests,
    mandatoryPatterns: [...MUST_HAVE_PATTERNS],
    matchedImpactRules: [...new Set(matchedRuleNames)].sort(),
    dependencyDerived,
    agent: {
      status: agent.status,
      confidence: agent.confidence,
      rationale: agent.rationale,
      addedTests: agent.addTests,
      fallback: agent.fallback,
    },
    selectedReasons,
    fallbackReason: fallbackFull ? (allTests ? 'nightly/release mode' : fullByPath ? 'high-risk manifest or workflow path' : agent.rationale || 'agent confidence or validation fallback') : null,
  };
}

module.exports = { buildTestImpactPlan };
