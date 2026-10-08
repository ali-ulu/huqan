'use strict';

// #3651: `coder` must be able to land a real source change, not only docs.
//
// Two layers are covered here:
//   1. a path-hint regression -- slash-terminated hints (`test/`, `memory/`)
//      stopped matching, so ordinary test and memory files were misclassified;
//   2. the operator authorization that releases a source change's REVIEW hold
//      into an APPLY, while leaving BLOCK and DRY_RUN_ONLY fail-closed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { applyDerivation } = require('../lib/coder/apply-derivation');
const { classifyChangedFile } = require('../lib/code-change-file-classifier');

const REPO_STATE = { branch: 'feature/x', dirty: false, hasUntracked: false };

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-coder-auth-'));
}

function writeFixture(root, relative, content) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function sourceTask(relative) {
  return {
    id: 'source-write',
    level: 'l0',
    allowedPaths: [relative],
    operation: { type: 'replace_text', path: relative, find: 'BEFORE', replace: 'AFTER' },
  };
}

test('path hints that end in a slash classify the directory surface again', () => {
  const cases = [
    ['test/a.test.js', 'tests', 'allow', 'LOW_RISK_TESTS_ONLY'],
    ['tests/a.js', 'tests', 'allow', 'LOW_RISK_TESTS_ONLY'],
    ['memory/index.js', 'memory', 'dry_run_only', 'RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN'],
    ['.github/workflows/ci.yml', 'workflow', 'review', 'CI_WORKFLOW_CHANGE_REQUIRES_REVIEW'],
  ];
  for (const [filePath, category, decision, reason] of cases) {
    const finding = classifyChangedFile({ path: filePath, status: 'modified' });
    assert.equal(finding.category, category, filePath);
    assert.equal(finding.decision, decision, filePath);
    assert.equal(finding.reason, reason, filePath);
  }
});

test('content terms still match whole words, so token/deploy substrings do not block', () => {
  for (const filePath of ['lib/tokenizer.js', 'lib/secret-scrub-gate.js', 'docs/deployment.md']) {
    const finding = classifyChangedFile({ path: filePath, status: 'modified', changeType: 'source' });
    assert.notEqual(finding.decision, 'block', filePath);
  }
});

test('a source change is reviewed without authorization and applied with it', () => {
  const root = tmpRoot();
  try {
    const target = writeFixture(root, 'src/greeting.js', 'const x = BEFORE;\n');
    const task = sourceTask('src/greeting.js');

    const refused = applyDerivation({ task, root, repoState: REPO_STATE });
    assert.equal(refused.ok, false);
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.reason, 'GATE_REFUSED');
    assert.equal(refused.gate.decision, 'review');
    assert.equal(refused.gate.reason, 'SOURCE_CHANGE_REQUIRES_REVIEW');
    assert.equal(refused.gate.operatorAuthorized, false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'const x = BEFORE;\n');

    const applied = applyDerivation({ task, root, repoState: REPO_STATE, authorized: true });
    assert.equal(applied.ok, true);
    assert.equal(applied.outcome, 'applied');
    assert.equal(applied.gate.decision, 'allow');
    assert.equal(applied.gate.reason, 'OPERATOR_AUTHORIZED_REVIEW');
    assert.equal(applied.gate.operatorAuthorized, true);
    assert.equal(applied.record.gate.operatorAuthorized, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'const x = AFTER;\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authorization never waives a critical block or a runtime dry-run', () => {
  const root = tmpRoot();
  try {
    writeFixture(root, 'scripts/release.js', 'release BEFORE\n');
    const blocked = applyDerivation({
      task: {
        id: 'release',
        level: 'l0',
        allowedPaths: ['scripts/release.js'],
        operation: { type: 'replace_text', path: 'scripts/release.js', find: 'BEFORE', replace: 'AFTER' },
      },
      root,
      repoState: REPO_STATE,
      authorized: true,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.gate.decision, 'block');
    assert.equal(blocked.gate.reason, 'RELEASE_OR_DEPLOY_CHANGE_BLOCKED');
    assert.equal(blocked.gate.operatorAuthorized, true);

    writeFixture(root, 'server.js', 'server BEFORE\n');
    const dryRun = applyDerivation({
      task: {
        id: 'runtime',
        level: 'l0',
        allowedPaths: ['server.js'],
        operation: { type: 'replace_text', path: 'server.js', find: 'BEFORE', replace: 'AFTER' },
      },
      root,
      repoState: REPO_STATE,
      authorized: true,
    });
    assert.equal(dryRun.ok, false);
    assert.equal(dryRun.gate.decision, 'dry_run_only');
    assert.equal(dryRun.gate.reason, 'RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN');
    assert.equal(dryRun.gate.operatorAuthorized, true);
    assert.equal(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), 'server BEFORE\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dirty repository still holds the change even with authorization', () => {
  const root = tmpRoot();
  try {
    const target = writeFixture(root, 'src/greeting.js', 'const x = BEFORE;\n');
    const result = applyDerivation({
      task: sourceTask('src/greeting.js'),
      root,
      repoState: { branch: 'feature/x', dirty: true, hasUntracked: false },
      authorized: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.gate.decision, 'review');
    assert.equal(result.gate.reason, 'DIRTY_REPO_REVIEW_REQUIRED');
    assert.equal(fs.readFileSync(target, 'utf8'), 'const x = BEFORE;\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
