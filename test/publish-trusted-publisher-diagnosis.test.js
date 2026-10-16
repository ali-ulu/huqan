'use strict';

/**
 * The publish workflow failed eight times in a row with npm's unauthorized-PUT
 * 404 while the package's trusted publisher was never configured. The error npm
 * returns names the package -- "'huqan@0.11.1' is not in this registry" -- which
 * reads as a missing package rather than a missing credential, so the run log
 * gave a release engineer nothing to act on.
 *
 * These assertions cover the diagnosis that now runs on a failed publish: it has
 * to fire on the real signature, stay quiet on unrelated failures, and name all
 * four values that must match on npmjs.com.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'explain-npm-publish-failure.js');
const { isUnauthorizedPublish, diagnosis } = require(SCRIPT);

// Copied from run 33343813607, the last release attempt before this change.
const REAL_FAILURE = [
  'npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access',
  'npm error code E404',
  'npm error 404 Not Found - PUT https://registry.npmjs.org/huqan - Not found',
  'npm error 404',
  "npm error 404  'huqan@0.11.1' is not in this registry.",
  'npm error 404',
  'npm error 404 Note that you can also install from a',
  'npm error 404 tarball, folder, http url, or git url.',
].join('\n');

function run(logText, env = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-publish-')), 'npm.log');
  fs.writeFileSync(file, logText);
  return execFileSync(process.execPath, [SCRIPT, file], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('the real unauthorized-PUT failure is recognised', () => {
  assert.equal(isUnauthorizedPublish(REAL_FAILURE), true);
});

test('an unrelated publish failure is left alone', () => {
  // A version already on the registry, a network error, and a failing lifecycle
  // script must not be reported as a trusted-publisher problem.
  for (const log of [
    'npm error code EPUBLISHCONFLICT\nnpm error You cannot publish over the previously published versions: 0.11.1.',
    'npm error code ENOTFOUND\nnpm error request to https://registry.npmjs.org/ failed, reason: getaddrinfo ENOTFOUND',
    'npm error code ELIFECYCLE\nnpm error errno 1\nnpm error huqan@0.11.1 prepublishOnly script failed',
  ]) {
    assert.equal(isUnauthorizedPublish(log), false, log.split('\n')[0]);
  }
  assert.equal(run('npm error code EPUBLISHCONFLICT').trim(), '');
});

test('the diagnosis names all four values that have to match', () => {
  const text = diagnosis({ repository: 'ali-ulu/huqan', workflow: 'publish.yml', environment: 'npm-publish' });
  assert.match(text, /Organization or user\s*:\s*ali-ulu/);
  assert.match(text, /Repository\s*:\s*huqan/);
  assert.match(text, /Workflow filename\s*:\s*publish\.yml/);
  assert.match(text, /Environment\s*:\s*npm-publish/);
  // The failure mode that wasted the most time: assuming a dry run proves it.
  assert.match(text, /dry run cannot confirm/i);
});

test('a failed publish emits the diagnosis as a workflow annotation', () => {
  const out = run(REAL_FAILURE, {
    GITHUB_REPOSITORY: 'ali-ulu/huqan',
    PUBLISH_WORKFLOW_FILENAME: 'publish.yml',
    PUBLISH_ENVIRONMENT: 'npm-publish',
  });
  assert.match(out, /^::error title=npm trusted publisher is not configured::/m);
  assert.match(out, /Workflow filename\s*:\s*publish\.yml/);
});

test('the workflow captures the publish output and explains a failure', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'publish.yml'), 'utf8');
  // Without the capture there is nothing to diagnose, and without the exit the
  // release would pass on a failed upload -- the diagnosis must not swallow it.
  assert.match(workflow, /npm publish --access public 2>&1 \| tee/);
  assert.match(workflow, /publish_status="\$\{PIPESTATUS\[0\]\}"/);
  assert.match(workflow, /node scripts\/explain-npm-publish-failure\.js/);
  assert.match(workflow, /exit "\$\{publish_status\}"/);
});
