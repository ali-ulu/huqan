'use strict';

// Issue #4531: the coder gate's secret scan looked only at paths and metadata
// vocabulary, never at the written content, so a credential embedded in a
// created source file (or even a docs file) landed on disk with --authorize.
// The fix routes the file content through the gate and scans it for
// credential-shaped values; a secret content hit is a BLOCK that --authorize
// cannot lift.
//
// Fixture credentials below are assembled from fragments so no usable
// credential literal exists in source; they are invalid example-shaped values.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { applyDerivation } = require('../lib/coder/apply-derivation');
const { evaluateCodeChange } = require('../lib/code-change-gate');
const { containsSecretLikeContent } = require('../lib/text-utils');

const REPO_STATE = { branch: 'feature/x', dirty: false, hasUntracked: false };

const SECRET_CONTENT = 'const AWS_SECRET_ACCESS_KEY = "'
  + ['AKIA', 'IOSFODNN7EXAMPLE', 'KEYXYZ'].join('') + '";\n'
  + 'const API_KEY = "' + ['sk-live', 'abcdefghijklmnopqrst'].join('-') + '";\n'
  + 'console.log(1);\n';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-issue-4531-'));
}

function resolveWithinRoot(root, relative) {
  const resolved = path.resolve(root, relative);
  assert.ok(resolved === root || resolved.startsWith(root + path.sep), `path escapes root: ${relative}`);
  return resolved;
}

function writeFixture(root, relative, content) {
  const full = resolveWithinRoot(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('containsSecretLikeContent detects credential-shaped values inside text', () => {
  assert.equal(containsSecretLikeContent(SECRET_CONTENT), true);
  assert.equal(containsSecretLikeContent('const key = "sk-' + 'proj-0123456789abcdefg";\n'), true);
  assert.equal(containsSecretLikeContent(['-----BEGIN RSA', ' PRIVATE KEY-----'].join('') + '\nabc\n'), true);
  assert.equal(containsSecretLikeContent('const x = 1;\n'), false);
  assert.equal(containsSecretLikeContent('require("sk-helper-module").init();\n'), false);
  assert.equal(containsSecretLikeContent(''), false);
  assert.equal(containsSecretLikeContent(null), false);
});

test('gate blocks secret-bearing content even on a docs path, with or without authorization', () => docsBlock());

function docsBlock() {
  const input = {
    files: [{ path: 'docs/notes.md', status: 'added', additions: 3, deletions: 0, content: SECRET_CONTENT }],
    intent: 'docs note',
    operationType: 'write',
    repoState: REPO_STATE,
  };
  const unauthorized = evaluateCodeChange(input, { authorized: false });
  assert.equal(unauthorized.decision, 'block');
  assert.equal(unauthorized.reason, 'SECRET_CHANGE_BLOCKED');
  const authorized = evaluateCodeChange(input, { authorized: true });
  assert.equal(authorized.decision, 'block');
  assert.equal(authorized.reason, 'SECRET_CHANGE_BLOCKED');
}

test('gate still allows ordinary content that merely mentions vocabulary words', () => {
  const result = evaluateCodeChange({
    files: [{ path: 'docs/notes.md', status: 'added', additions: 1, deletions: 0,
      content: 'How to rotate your api key and token safely.\n' }],
    intent: 'docs note',
    operationType: 'write',
    repoState: REPO_STATE,
  }, { authorized: true });
  assert.equal(result.decision, 'allow');
});

function createTask(relative) {
  return {
    id: 'secret-create',
    level: 1,
    allowedPaths: [relative],
    operation: { type: 'create_file', path: relative, content: SECRET_CONTENT },
    test: { command: 'node t.js' },
  };
}

test('coder create_file with embedded secrets is blocked and never written', () => {
  const root = tmpRoot();
  try {
    writeFixture(root, 't.js', 'process.exit(0);\n');
    for (const relative of ['a.js', 'docs/notes.md']) {
      const target = resolveWithinRoot(root, relative);
      const refused = applyDerivation({ task: createTask(relative), root, repoState: REPO_STATE });
      assert.equal(refused.ok, false, relative);
      assert.equal(refused.outcome, 'refused', relative);
      assert.equal(refused.reason, 'GATE_REFUSED', relative);
      assert.equal(refused.gate.decision, 'block', relative);
      assert.equal(refused.gate.reason, 'SECRET_CHANGE_BLOCKED', relative);

      const authorized = applyDerivation({ task: createTask(relative), root, repoState: REPO_STATE, authorized: true });
      assert.equal(authorized.ok, false, relative);
      assert.equal(authorized.reason, 'GATE_REFUSED', relative);
      assert.equal(authorized.gate.decision, 'block', relative);
      assert.equal(fs.existsSync(target), false, relative);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coder source file without secrets still flows through the gate unchanged', () => {
  const root = tmpRoot();
  try {
    const target = resolveWithinRoot(root, 'a.js');
    const task = {
      id: 'plain-create',
      level: 1,
      allowedPaths: ['a.js'],
      operation: { type: 'create_file', path: 'a.js', content: 'console.log(1);\n' },
    };
    const held = applyDerivation({ task, root, repoState: REPO_STATE });
    assert.equal(held.reason, 'GATE_REFUSED');
    assert.equal(held.gate.reason, 'SOURCE_CHANGE_REQUIRES_REVIEW');
    const applied = applyDerivation({ task, root, repoState: REPO_STATE, authorized: true });
    assert.equal(applied.ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'console.log(1);\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
