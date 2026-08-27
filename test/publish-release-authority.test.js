'use strict';

/**
 * #1673: the npm publish path must be bound to an authorized immutable ref.
 *
 * The manual `workflow_dispatch` trigger could previously reach the publish
 * step from any ref a maintainer selected -- including a branch, whose tip
 * moves, and a tag whose name had no relationship to package.json#version. The
 * tag/version binding that the push path enforced was skipped entirely
 * (`if: github.event_name == 'push'`).
 *
 * Rather than assert on the YAML text, this test extracts the authority
 * script from the workflow and runs it against a real temporary repository,
 * so the guarantee is checked by execution: a branch ref, a non-v tag, a
 * version mismatch, and a tag off the default branch must all fail closed,
 * and the legitimate release tag must pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'publish.yml');
const workflowSource = fs.readFileSync(WORKFLOW, 'utf8');

/** Pull the `run: |` block out of the named step. */
function extractRunScript(stepName) {
  const lines = workflowSource.split('\n');
  const start = lines.findIndex(line => line.trim() === `- name: ${stepName}`);
  assert.notEqual(start, -1, `step "${stepName}" is missing from publish.yml`);
  const runIndex = lines.findIndex((line, index) => index > start && line.trim() === 'run: |');
  assert.notEqual(runIndex, -1, `step "${stepName}" has no run block`);
  const indent = lines[runIndex].search(/\S/) + 2;
  const body = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

const authorityScript = extractRunScript('Require an authorized immutable release ref');

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * A repository with a default branch, a release tag on it, and a second tag
 * on a commit that was never merged.
 */
function makeRepo(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-publish-authority-'));
  const upstream = path.join(dir, 'upstream');
  fs.mkdirSync(upstream);
  git(upstream, 'init', '--initial-branch=main', '--quiet');
  git(upstream, 'config', 'user.email', 'test@example.com');
  git(upstream, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ name: 'huqan', version }));
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-m', 'release', '--quiet');
  const releaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream }).toString().trim();

  // An unmerged commit, reachable only by its own tag.
  git(upstream, 'checkout', '-b', 'side', '--quiet');
  fs.writeFileSync(path.join(upstream, 'unreviewed.txt'), 'not on main');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-m', 'unreviewed', '--quiet');
  const sideSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream }).toString().trim();
  git(upstream, 'checkout', 'main', '--quiet');

  const workspace = path.join(dir, 'workspace');
  git(dir, 'clone', '--quiet', upstream, workspace);
  git(workspace, 'fetch', '--quiet', 'origin', 'side:refs/remotes/origin/side');
  return { dir, workspace, releaseSha, sideSha };
}

function runAuthority(repo, env) {
  const scriptPath = path.join(repo.dir, 'authority.sh');
  fs.writeFileSync(scriptPath, authorityScript);
  const outputPath = path.join(repo.dir, 'github_output');
  fs.writeFileSync(outputPath, '');
  return spawnSync('bash', [scriptPath], {
    cwd: repo.workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      DEFAULT_BRANCH: 'main',
      ...env,
    },
  });
}

test('a matching release tag on the default branch is authorized', () => {
  const repo = makeRepo('1.2.3');
  const result = runAuthority(repo, {
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: 'v1.2.3',
    GITHUB_SHA: repo.releaseSha,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Publishing version 1\.2\.3/);
});

test('a branch ref is refused, whatever the trigger', () => {
  const repo = makeRepo('1.2.3');
  const result = runAuthority(repo, {
    GITHUB_REF_TYPE: 'branch',
    GITHUB_REF_NAME: 'main',
    GITHUB_SHA: repo.releaseSha,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /immutable v\* tag/);
});

test('a tag that is not a v* release tag is refused', () => {
  const repo = makeRepo('1.2.3');
  const result = runAuthority(repo, {
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: 'nightly-2026-08-27',
    GITHUB_SHA: repo.releaseSha,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a v\* release tag/);
});

test('a tag that disagrees with package.json#version is refused', () => {
  const repo = makeRepo('1.2.3');
  const result = runAuthority(repo, {
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: 'v9.9.9',
    GITHUB_SHA: repo.releaseSha,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match package\.json version/);
});

test('a release tag on an unmerged commit is refused', () => {
  const repo = makeRepo('1.2.3');
  const result = runAuthority(repo, {
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: 'v1.2.3',
    GITHUB_SHA: repo.sideSha,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not an ancestor of main/);
});

test('the authority gate runs before any step that could publish', () => {
  const authorityIndex = workflowSource.indexOf('- name: Require an authorized immutable release ref');
  const publishIndex = workflowSource.indexOf('- name: Publish');
  assert.ok(authorityIndex > -1 && publishIndex > authorityIndex);
  assert.equal(
    /^\s*if:.*github\.event_name == 'push'\s*$/m.test(workflowSource.slice(authorityIndex, publishIndex)),
    false,
    'the authority gate must not be limited to the push trigger',
  );
});

test('the publish job is bound to a protected environment', () => {
  assert.match(workflowSource, /^\s*environment:\s*npm-publish\s*$/m);
});

test('a dry run still withholds the upload', () => {
  const publishStep = workflowSource.slice(workflowSource.indexOf('- name: Publish'));
  assert.match(publishStep, /if:\s*github\.event_name == 'push' \|\| inputs\.dry_run == false/);
  assert.match(publishStep, /npm publish --provenance --access public/);
  assert.match(workflowSource, /- name: Dry run complete/);
});
