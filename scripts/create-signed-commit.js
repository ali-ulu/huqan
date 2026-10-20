#!/usr/bin/env node
'use strict';

/**
 * Publish one file as a *signed* commit on a fresh branch, without a checkout
 * dance and without a local `git commit`.
 *
 * Why this exists (#4123). The nightly `refresh-shard-weights` job used to cut
 * a branch from `main`, write the regenerated `config/shard-weights.json`, and
 * commit it with a plain local `git commit`. That commit is unsigned, and
 * `main` carries the `required_signatures` ruleset rule, so the pull request it
 * then opened could never merge: `Workflow governance` reported the unsigned
 * commit on every one of them (#4117, #4047, #4018, #4003), and each one had to
 * be rewritten by hand with an operator's signed commit before it would land.
 *
 * An exemption in `check-pr-signatures.js` would not have fixed it either: that
 * only turns the *check* green, while the ruleset still refuses the merge. The
 * signature has to exist, so this builds the commit where GitHub can supply it.
 *
 * GitHub's `createCommitOnBranch` mutation signs the commit server-side and
 * marks it verified, with no key on the runner and no secret to manage. The
 * commit is built from the API rather than a working tree, so the caller does
 * not need the branch checked out at all -- which also removes the
 * restore/switch/fetch shuffle the old step needed to base the change on
 * current `main` rather than the (often hours old) scheduled checkout.
 *
 * Usage:
 *   node scripts/create-signed-commit.js <branch> <base-ref> <path> <headline>
 *
 * The file's on-disk contents are compared against `<base-ref>` first. When
 * they already match, nothing is committed and `changed=false` is written to
 * `$GITHUB_OUTPUT` (and printed), so the caller can skip opening a pull
 * request instead of opening an empty one.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

const COMMIT_MUTATION = `mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid url } }
}`;

/**
 * The `CreateCommitOnBranchInput` for adding `file` with `contents`.
 *
 * Kept pure and separate from the API calls so a test can pin the shape --
 * especially `expectedHeadOid`, which is what makes the mutation refuse to
 * append to a branch that moved since the base was read.
 */
function buildCommitInput({ repo, branch, baseOid, file, contents, headline }) {
  return {
    branch: { repositoryNameWithOwner: repo, branchName: branch },
    message: { headline },
    fileChanges: {
      additions: [{
        path: file,
        contents: Buffer.from(contents, 'utf8').toString('base64'),
      }],
    },
    expectedHeadOid: baseOid,
  };
}

/** The four positional arguments, or a thrown usage error. */
function parseArgs(argv) {
  const [branch, base, file, ...headlineParts] = argv;
  const headline = headlineParts.join(' ').trim();
  if (!branch || !base || !file || !headline) {
    throw new Error('usage: create-signed-commit.js <branch> <base-ref> <path> <headline>');
  }
  return { branch, base, file, headline };
}

/** `gh api` with an argv array, so a path with spaces is never re-split. */
function gh(args, { input } = {}) {
  return execFileSync('gh', args, { input, encoding: 'utf8' });
}

/** The repository slug, from the Actions environment or the current checkout. */
function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
}

/** The commit `<base>` points at. */
function resolveBaseOid(repo, base) {
  return gh(['api', `repos/${repo}/git/ref/heads/${base}`, '--jq', '.object.sha']).trim();
}

/** The bytes `<base>` holds for `file`, or null when the file is absent there. */
function readBaseContents(repo, base, file) {
  let encoded;
  try {
    encoded = gh(['api', `repos/${repo}/contents/${file}?ref=${base}`, '--jq', '.content']);
  } catch (error) {
    const stderr = String(error.stderr || '');
    if (/HTTP 404/.test(stderr) || /Not Found/.test(stderr)) return null;
    throw error;
  }
  return Buffer.from(encoded.replace(/\s+/g, ''), 'base64').toString('utf8');
}

function report(changed) {
  const line = `changed=${changed}`;
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  }
  console.log(line);
}

/**
 * Create the signed commit on `branch`, cleaning up the ref we just cut when
 * the attempt fails.
 *
 * The branch ref is created before the mutation, so a failure that no commit
 * followed leaves a ref with no pull request, and `branch-cleanup.yml` only
 * fires on a closed pull request -- nothing else would ever remove it. But an
 * attempt can also fail *after* GitHub created the commit (a dropped response,
 * say), and deleting the ref then would throw away a commit that exists. So the
 * cleanup reads the ref back and deletes it only while it still points at
 * `baseOid`; the original error is always rethrown, and a failed cleanup is
 * only logged.
 *
 * `run` is the `gh` runner, injectable so a test can drive both outcomes.
 */
function publishCommit({ repo, branch, baseOid, file, contents, headline, run = gh }) {
  run(['api', '--method', 'POST', `repos/${repo}/git/refs`,
    '-f', `ref=refs/heads/${branch}`, '-f', `sha=${baseOid}`]);

  try {
    const body = JSON.stringify({
      query: COMMIT_MUTATION,
      variables: { input: buildCommitInput({ repo, branch, baseOid, file, contents, headline }) },
    });
    const response = JSON.parse(run(['api', 'graphql', '--input', '-'], { input: body }));
    const oid = response && response.data && response.data.createCommitOnBranch
      && response.data.createCommitOnBranch.commit && response.data.createCommitOnBranch.commit.oid;
    if (!oid) {
      throw new Error(`createCommitOnBranch returned no commit: ${JSON.stringify(response)}`);
    }
    console.log(`committed ${oid} to ${branch}`);
    report(true);
    return oid;
  } catch (error) {
    try {
      const ref = JSON.parse(run(['api', `repos/${repo}/git/ref/heads/${branch}`]));
      if (ref.object && ref.object.sha === baseOid) {
        run(['api', '--method', 'DELETE', `repos/${repo}/git/refs/heads/${branch}`]);
      }
    } catch (cleanupError) {
      console.error(`branch cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }
}

function main(argv) {
  const { branch, base, file, headline } = parseArgs(argv);
  const absolute = path.resolve(REPO_ROOT, file);
  const contents = fs.readFileSync(absolute, 'utf8');
  const repo = repository();

  const baseOid = resolveBaseOid(repo, base);
  if (readBaseContents(repo, base, file) === contents) {
    console.log(`${file} already matches ${base}; nothing to publish`);
    report(false);
    return 0;
  }

  publishCommit({ repo, branch, baseOid, file, contents, headline });
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`create-signed-commit: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { COMMIT_MUTATION, buildCommitInput, main, parseArgs, publishCommit, readBaseContents, resolveBaseOid };
