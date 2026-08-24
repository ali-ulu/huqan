'use strict';

/**
 * Sandbox containment must read paths the way the host does, and must not be
 * fooled by a symlink.
 *
 * `normalizeSandboxPath` and `isInsideSandbox` hardcoded `path.win32`, so on a
 * POSIX host they applied the wrong grammar: backslash is a separator in one
 * and a legal filename character in the other, and `win32.resolve` prefixes a
 * drive letter a POSIX path does not have.
 *
 * They were also lexical-only. `sandboxRoot/link -> /etc` resolved as inside
 * the sandbox, so `TEMP_ARTIFACT_OUTSIDE_SANDBOX` never fired for a
 * symlink-based escape -- fail-open in a containment classifier.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { evaluateSandboxIsolation } = require('../lib/sandbox-isolation');

const OUTSIDE = 'TEMP_ARTIFACT_OUTSIDE_SANDBOX';

const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-sandbox-')));

function classify(tempArtifactPath, sandboxRoot) {
  return evaluateSandboxIsolation({
    action: 'write temp artifact',
    context: { tempArtifactPath, sandboxRoot },
  });
}

/** The finding codes the classifier raised, which is where containment shows up. */
function codesOf(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  return new Set(findings.map((finding) => finding.code));
}

test('a path inside the sandbox is not flagged as outside', () => {
  const root = path.join(tempDir, 'sandbox-plain');
  fs.mkdirSync(root, { recursive: true });
  const inside = path.join(root, 'artifact.txt');
  fs.writeFileSync(inside, 'x');

  assert.equal(
    codesOf(classify(inside, root)).has(OUTSIDE),
    false,
  );
});

test('a path outside the sandbox is flagged', () => {
  const root = path.join(tempDir, 'sandbox-outside');
  fs.mkdirSync(root, { recursive: true });
  const outside = path.join(tempDir, 'elsewhere.txt');
  fs.writeFileSync(outside, 'x');

  assert.equal(
    codesOf(classify(outside, root)).has(OUTSIDE),
    true,
  );
});

test('a symlink pointing out of the sandbox is flagged as outside', (t) => {
  const root = path.join(tempDir, 'sandbox-symlink');
  const target = path.join(tempDir, 'escape-target');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(target, link, 'junction');
  } catch (_) {
    return t.skip('symlink creation is not permitted in this environment');
  }

  const escaped = path.join(link, 'secret.txt');
  fs.writeFileSync(escaped, 'x');

  assert.equal(
    codesOf(classify(escaped, root)).has(OUTSIDE),
    true,
    'a lexically-inside path that really lives outside must not pass containment',
  );
});

test('a symlinked sandbox root still contains its own children', (t) => {
  const realRoot = path.join(tempDir, 'sandbox-real');
  fs.mkdirSync(realRoot, { recursive: true });
  const linkedRoot = path.join(tempDir, 'sandbox-linked');
  try {
    fs.symlinkSync(realRoot, linkedRoot, 'junction');
  } catch (_) {
    return t.skip('symlink creation is not permitted in this environment');
  }
  const inside = path.join(realRoot, 'artifact.txt');
  fs.writeFileSync(inside, 'x');

  assert.equal(
    codesOf(classify(path.join(linkedRoot, 'artifact.txt'), realRoot)).has(OUTSIDE),
    false,
    'resolving both sides keeps a symlinked root usable',
  );
});

test('the sandbox root itself is inside the sandbox', () => {
  const root = path.join(tempDir, 'sandbox-self');
  fs.mkdirSync(root, { recursive: true });

  assert.equal(
    codesOf(classify(root, root)).has(OUTSIDE),
    false,
  );
});

test('a sibling whose name merely starts with the root name is outside', () => {
  const root = path.join(tempDir, 'sandbox-prefix');
  fs.mkdirSync(root, { recursive: true });
  const sibling = `${root}-other`;
  fs.mkdirSync(sibling, { recursive: true });
  const file = path.join(sibling, 'artifact.txt');
  fs.writeFileSync(file, 'x');

  assert.equal(
    codesOf(classify(file, root)).has(OUTSIDE),
    true,
  );
});

test('a path that does not exist is still classified lexically', () => {
  const root = path.join(tempDir, 'sandbox-missing');
  fs.mkdirSync(root, { recursive: true });

  assert.equal(
    codesOf(classify(path.join(root, 'not-created-yet.txt'), root)).has(OUTSIDE),
    false,
    'planned artifact paths are the normal case for this classifier',
  );
  assert.equal(
    codesOf(classify(path.join(tempDir, 'nowhere-near.txt'), root)).has(OUTSIDE),
    true,
  );
});

// --- grammar, independent of the host -------------------------------------
// The classifier describes a sandbox that may have run on a different OS than
// the one evaluating the record, so both path grammars have to stay readable
// on either host. These cases use literal paths rather than the temp fixtures
// above, so they assert the same thing on Windows and on Linux CI.

const { isInsideSandbox } = require('../lib/sandbox-path-containment');

test('windows paths are read as windows paths on any host', () => {
  assert.equal(isInsideSandbox('C:\\sandbox\\tmp\\artifact.json', 'C:\\sandbox'), true);
  assert.equal(isInsideSandbox('C:\\elsewhere\\artifact.json', 'C:\\sandbox'), false);
  assert.equal(isInsideSandbox('C:\\sandbox-other\\artifact.json', 'C:\\sandbox'), false);
});

test('posix paths are read as posix paths on any host', () => {
  assert.equal(isInsideSandbox('/srv/sandbox/tmp/artifact.json', '/srv/sandbox'), true);
  assert.equal(isInsideSandbox('/etc/passwd', '/srv/sandbox'), false);
  assert.equal(isInsideSandbox('/srv/sandbox-other/artifact.json', '/srv/sandbox'), false);
  assert.equal(isInsideSandbox('/srv/sandbox', '/srv/sandbox'), true);
});

test('two paths written in different grammars are not compared', () => {
  assert.equal(isInsideSandbox('C:\\sandbox\\artifact.json', '/srv/sandbox'), false);
  assert.equal(isInsideSandbox('/srv/sandbox/artifact.json', 'C:\\sandbox'), false);
});
