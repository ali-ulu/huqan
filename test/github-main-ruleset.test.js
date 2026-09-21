const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const RULESET_PATHS = [
  '.github/rulesets/main-branch.json',
  '.github/rulesets/huqan-main-ruleset.json',
];

const REQUIRED_RULES = [
  'deletion',
  'non_fast_forward',
  'required_linear_history',
  'required_signatures',
  'pull_request',
  'required_status_checks',
];

const REQUIRED_CHECKS = [
  'npm test gate',
  'Benchmark gate',
  'Docker build gate',
  'Rust accelerator gate',
  'Conformance Gate',
  'Validate BDD/Gherkin contracts',
  'Security Checks',
  'Workflow governance',
  'Package Smoke',
  'CodeQL',
  'Forbid raw control characters in tracked sources',
  'Require living documentation to agree with the source',
  'Require graph is acyclic',
  'Require every V5 document to declare its status',
  'Enforce the large-file threshold',
  'Enforce a lint-clean tree',
  'Require architecture tracker snapshot to be current',
];

function readRuleset(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'));
}

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

for (const relativePath of RULESET_PATHS) {
  test(`${relativePath} encodes the protected-main contract`, () => {
    const ruleset = readRuleset(relativePath);

    assert.equal(ruleset.name, 'HUQAN main protection');
    assert.equal(ruleset.target, 'branch');
    assert.equal(ruleset.enforcement, 'active');
    assert.deepEqual(ruleset.conditions?.ref_name?.include, ['refs/heads/main']);
    assert.deepEqual(ruleset.conditions?.ref_name?.exclude, []);

    const ruleTypes = new Set(ruleset.rules.map(rule => rule.type));
    for (const ruleType of REQUIRED_RULES) {
      assert.equal(ruleTypes.has(ruleType), true, `missing ruleset rule: ${ruleType}`);
    }

    const pullRequest = ruleset.rules.find(rule => rule.type === 'pull_request');
    assert.deepEqual(pullRequest.parameters.allowed_merge_methods, ['squash']);
    assert.equal(pullRequest.parameters.dismiss_stale_reviews_on_push, true);
    assert.equal(pullRequest.parameters.required_review_thread_resolution, true);

    const statusChecks = ruleset.rules.find(rule => rule.type === 'required_status_checks');
    assert.equal(statusChecks.parameters.strict_required_status_checks_policy, true);

    const contexts = new Set(
      statusChecks.parameters.required_status_checks.map(check => check.context),
    );
    for (const context of REQUIRED_CHECKS) {
      assert.equal(contexts.has(context), true, `missing required check: ${context}`);
    }
  });
}

test('main ruleset exports stay semantically equivalent', () => {
  assert.deepEqual(
    readRuleset(RULESET_PATHS[0]),
    readRuleset(RULESET_PATHS[1]),
  );
});

test('required Package Smoke and CodeQL contexts are emitted on every main PR', () => {
  const smoke = read('.github/workflows/launch-smoke.yml');
  const codeql = read('.github/workflows/codeql.yml');

  assert.match(smoke, /^\s*pull_request:\s*\n\s*branches:\s*\[main\]\s*$/m);
  assert.match(smoke, /^\s*name:\s*Package Smoke\s*$/m);
  assert.doesNotMatch(smoke, /^\s*paths:\s*$/m);

  assert.match(codeql, /^\s*pull_request:\s*\n\s*branches:\s*\[main\]\s*$/m);
  assert.match(codeql, /^\s*name:\s*CodeQL\s*$/m);
  assert.doesNotMatch(codeql, /^\s*paths:\s*$/m);
});
