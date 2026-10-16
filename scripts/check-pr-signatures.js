#!/usr/bin/env node
'use strict';

/**
 * Fail a pull request in CI when any of its commits is unsigned.
 *
 * `main` carries the `required_signatures` ruleset rule, so an unsigned commit
 * cannot be merged at all -- but nothing said so until the merge button was
 * pressed, after every other check had already gone green. The pull request
 * looked mergeable and was not, and the only signal was GitHub's "must have
 * verified signatures" banner at the end of the line. This check moves that
 * verdict onto the pull request itself, where the offending commits and their
 * GitHub verification reasons sit next to the fix.
 *
 * GitHub's own `verification.verified` is the authority here, because it is
 * exactly what `required_signatures` evaluates: it accepts a GPG or SSH
 * signature registered to the author's account and GitHub's own web/API
 * commits, and rejects a local commit that was never signed. Reading
 * `git log --format=%G?` instead would disagree with the ruleset -- a commit
 * created through the GitHub web flow carries no local signature to check yet
 * merges fine -- so the two would report different answers for the same commit.
 *
 * CLI: node scripts/check-pr-signatures.js <commits.json>
 *
 * The JSON is the pull request's commit list in either shape: GitHub's raw
 * `/pulls/{n}/commits` payload, or the flattened shape the workflow builds with
 * `gh api --jq`, where each entry carries `verified` and `reason` directly.
 */

const fs = require('node:fs');

/** Normalize one commit from the raw API shape or the flattened workflow shape. */
function commitVerification(commit) {
  const nested = commit && commit.commit && commit.commit.verification;
  const verification = nested || commit || {};
  const nestedAuthor = commit && commit.commit && commit.commit.author && commit.commit.author.name;
  const author = nestedAuthor
    || (commit && typeof commit.author === 'string' ? commit.author : null)
    || (commit && commit.author && commit.author.name)
    || 'unknown';
  const message = (commit && commit.commit && commit.commit.message)
    || (commit && commit.message)
    || '';
  return {
    sha: (commit && commit.sha) || 'unknown',
    verified: verification.verified === true,
    reason: verification.reason || 'unknown',
    author,
    headline: String(message).split('\n')[0],
  };
}

/** Every commit GitHub does not report as verified, in the order given. */
function unsignedCommits(commits) {
  if (!Array.isArray(commits)) throw new TypeError('the pull request commit list must be an array');
  // `gh api --paginate --slurp` emits an array of page arrays; flatten it so
  // both the single-page and multi-page payloads read the same way.
  const flat = commits.flat();
  return flat.map(commitVerification).filter((commit) => !commit.verified);
}

function formatFailures(unsigned) {
  const lines = [
    'Commit signature check failed: the main-branch ruleset requires verified signatures,',
    'so these commits cannot be merged as they stand.',
  ];
  for (const commit of unsigned) {
    lines.push(`- ${commit.sha.slice(0, 9)} (${commit.reason}) by ${commit.author}: ${commit.headline}`);
  }
  lines.push('Sign every commit (git commit -S) or recreate it through a signed flow, then push again.');
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const file = argv[0];
  if (!file) {
    process.stderr.write('usage: check-pr-signatures.js <commits.json> [expected-commit-count]\n');
    return 2;
  }
  const expected = argv[1] === undefined ? null : Number(argv[1]);
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const retrieved = Array.isArray(payload) ? payload.flat().length : null;
  // GitHub caps `/pulls/{n}/commits` at 250 commits even with --paginate, so a
  // large pull request can hand back fewer commits than it has. Reading only
  // those and reporting success would let an unverified commit hide past the
  // check while the ruleset still blocks the merge. Fail closed on the gap.
  if (expected !== null && Number.isFinite(expected) && retrieved !== null && retrieved < expected) {
    process.stderr.write(
      `Commit signature check failed: the pull request has ${expected} commits but only `
      + `${retrieved} were retrieved, so every commit could not be verified.\n`
      + 'GitHub caps this endpoint at 250 commits; split the pull request, or verify the '
      + 'remaining commits another way before merging.\n',
    );
    return 1;
  }
  const unsigned = unsignedCommits(payload);
  if (unsigned.length > 0) {
    process.stderr.write(`${formatFailures(unsigned)}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`check-pr-signatures: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { commitVerification, unsignedCommits, formatFailures, main };
