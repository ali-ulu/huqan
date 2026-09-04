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

// --- Windows bash selection (#1870) ---
//
// `spawnSync('bash', [scriptPath])` breaks on Windows boxes where `bash`
// resolves to the WSL stub (C:\Windows\System32\bash.exe): the stub receives
// a native path like `C:\Users\...\authority.sh`, eats the backslashes and
// reports `C:Users...: No such file or directory`. The authority scripts must
// therefore run under a consciously chosen shell with paths translated for it.
//
// On win32 this resolves to Git Bash (native git, same filesystem view) and
// translates native paths to its POSIX form (`C:\a\b` -> `/c/a/b`). Any other
// platform keeps plain `bash` with untouched paths, so Linux/CI behaviour is
// unchanged. When no suitable shell exists the exec tests fail with an
// explicit environment error instead of a misleading script error.
function toGitBashPath(absolutePath) {
  const normalized = path.resolve(absolutePath);
  const drive = normalized.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive) return `/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
  if (normalized.startsWith('\\\\')) return `//${normalized.slice(2).replace(/\\/g, '/')}`;
  return normalized.replace(/\\/g, '/');
}

function resolveBash() {
  if (process.platform !== 'win32') return { command: 'bash', needsPosixPaths: false };
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  try {
    const where = execFileSync('where', ['git'], { encoding: 'utf8' });
    for (const line of where.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) candidates.push(path.join(path.dirname(path.dirname(trimmed)), 'bin', 'bash.exe'));
    }
  } catch {
    // `where` failed; the static candidates above still apply.
  }
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { command: candidate, needsPosixPaths: true };
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    'No usable bash found on Windows: install Git for Windows (which provides Git Bash). '
    + 'The WSL stub bash.exe cannot run these authority scripts against native Windows paths.',
  );
}

// Lazily resolved so the pure-text assertions in this file still run on a
// machine without any bash at all; only the executing tests need a shell.
let cachedBash = null;
function selectedBash() {
  if (cachedBash === null) cachedBash = resolveBash();
  return cachedBash;
}

function toBashEnv(env, bash) {
  if (!bash.needsPosixPaths) return env;
  const converted = { ...env };
  for (const key of ['GITHUB_OUTPUT', 'NPM_CONFIG_USERCONFIG', 'HOME', 'RUNNER_TEMP']) {
    if (typeof converted[key] === 'string') converted[key] = toGitBashPath(converted[key]);
  }
  if (typeof converted.PATH === 'string') {
    converted.PATH = converted.PATH.split(path.delimiter)
      .map(entry => (/^[A-Za-z]:[\\/]/.test(entry) ? toGitBashPath(entry) : entry))
      .join(':');
  }
  return converted;
}

function spawnBash(scriptPath, options) {
  const bash = selectedBash();
  const args = bash.needsPosixPaths ? [toGitBashPath(scriptPath)] : [scriptPath];
  const env = options && options.env ? toBashEnv(options.env, bash) : options && options.env;
  return spawnSync(bash.command, args, { ...options, env });
}

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
  return spawnBash(scriptPath, {
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
  assert.match(publishStep, /npm publish --access public/);
  assert.match(workflowSource, /- name: Dry run complete/);
});

// --- The credential is minted, not stored ---
//
// Publishing authenticates with GitHub's OIDC identity: npm checks the
// repository, workflow file and environment in the claim against the trusted
// publisher configured on the package, then mints a short-lived credential
// for that one upload. Nothing is stored, so nothing expires and nothing is
// rotated.
//
// The tests below pin the three things that silently revert this to the
// long-lived-token arrangement it replaced. Each has already cost a failed
// release once, and each surfaces as the same misleading error: npm answers
// an unauthorized PUT with 404, not 403, so a credential problem reads as
// "the package does not exist" and sends everyone to look at the registry.

const publishScript = extractRunScript('Publish');

test('the job can obtain an OIDC token', () => {
  // Without `id-token: write` the runner has no identity to exchange and the
  // publish falls back to looking for a token that is no longer there.
  assert.match(workflowSource, /^\s*id-token:\s*write\s*$/m);
});

test('no long-lived npm credential is referenced anywhere in the workflow', () => {
  // Comments are stripped first: the prose explains why the token is gone and
  // has to be free to name it. Only executable lines are pinned.
  const executable = workflowSource
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  assert.doesNotMatch(
    executable,
    /secrets\.NPM_TOKEN|NODE_AUTH_TOKEN/,
    'a stored token reintroduces the expiry-and-rotation failure mode that trusted publishing removes',
  );
});

test('npm is upgraded past the version that can exchange OIDC', () => {
  // setup-node's Node 22 ships npm 10.x. The OIDC exchange landed in 11.5.1;
  // on an older CLI `npm publish` looks for an _authToken instead and fails.
  const upgradeIndex = workflowSource.indexOf('npm install -g npm@latest');
  const publishIndex = workflowSource.indexOf('- name: Publish');
  assert.ok(upgradeIndex > -1, 'the publish job must install an npm that supports trusted publishing');
  assert.ok(upgradeIndex < publishIndex, 'the upgrade must happen before the publish step');
});

// The step below is executed rather than pattern-matched: the assertion is
// about the state of the file npm will actually consult, not about the text
// of the script that produces it.

function runPublishCredentials(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-publish-npmrc-'));
  const home = path.join(dir, 'home');
  const runnerTemp = path.join(dir, 'runner-temp');
  fs.mkdirSync(home);
  fs.mkdirSync(runnerTemp);

  // What setup-node leaves behind, verbatim.
  const userConfig = path.join(runnerTemp, '.npmrc');
  fs.writeFileSync(
    userConfig,
    'registry=https://registry.npmjs.org/\n'
    + '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n',
  );

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'huqan', version: '9.9.9' }));
  // Stub npm so the credentials are checked without contacting a registry.
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const scriptPath = path.join(dir, 'publish.sh');
  fs.writeFileSync(scriptPath, publishScript);
  const bash = selectedBash();
  if (bash.needsPosixPaths) {
    // Files created by Node on Windows may lack the msys executable bit the
    // stub relies on (`#!/bin/sh` + PATH lookup under Git Bash).
    spawnSync(bash.command, ['-c', `chmod +x ${toGitBashPath(path.join(binDir, 'npm'))}`], {
      encoding: 'utf8',
    });
  }
  const result = spawnBash(scriptPath, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      HOME: home,
      RUNNER_TEMP: runnerTemp,
      NPM_CONFIG_USERCONFIG: userConfig,
      NODE_AUTH_TOKEN: 'XXXXX-XXXXX-XXXXX-XXXXX',
      GITHUB_REF_NAME: 'v9.9.9',
      GITHUB_REF_TYPE: 'tag',
      ...env,
    },
  });
  return { result, userConfig, home };
}

test('the setup-node auth placeholder is cleared before publishing', () => {
  // setup-node seeds the userconfig with `_authToken=${NODE_AUTH_TOKEN}`,
  // which is unset here. npm reads that as an empty stored credential and
  // never attempts the OIDC exchange, so the line has to go.
  const { result, userConfig } = runPublishCredentials({});

  assert.equal(result.status, 0, result.stderr);
  const effective = fs.readFileSync(userConfig, 'utf8');
  assert.match(effective, /^registry=https:\/\/registry\.npmjs\.org\/$/m);
  assert.doesNotMatch(
    effective,
    /_authToken/,
    'any _authToken line, placeholder or not, suppresses the OIDC exchange',
  );
});
