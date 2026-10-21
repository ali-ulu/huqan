#!/usr/bin/env node
'use strict';

/**
 * Fail a pull request in CI when a commit attributes the work to an AI agent
 * (AGENTS.md section 10).
 *
 * The ban existed as prose and nothing read it. PR #4157 landed with all three
 * commits authored and committed by `Claude <noreply@anthropic.com>`, and a
 * squash merge carried `Co-authored-by: Claude <noreply@anthropic.com>` into
 * `main`; the identity was only found by hand, after the merge. This check moves
 * that verdict onto the pull request, next to the commits that carry it.
 *
 * Scope is deliberately narrow: the commit's own identity (author and
 * committer) and its co-author trailers. The pull request body is not read
 * here. A body scan would need to tell an attribution line apart from ordinary
 * prose that happens to contain the word "agent" -- the doctor check's own
 * description says "host-reported agent identity" and "no agent has called it
 * yet" -- and a gate that fails on that teaches authors to work around it.
 *
 * Fail closed: a payload that is not a commit array is refused, never read as
 * "no attribution found".
 *
 * CLI: node scripts/check-ai-attribution.js <commits.json>
 *
 * The JSON is the pull request's commit list in either shape: GitHub's raw
 * `/pulls/{n}/commits` payload, or the flattened shape a workflow builds with
 * `gh api --jq`.
 */

const fs = require('node:fs');

/**
 * Infrastructure bots that are not an AI agent authoring on the owner's behalf.
 * The `Refresh shard weights` job commits as `github-actions[bot]`; gating it
 * would break a job that is not the thing this check is about.
 */
const ALLOWED_BOTS = /^(github-actions|dependabot|renovate)\[bot\]$/i;

/**
 * An AI agent identity. Matched against a display name and the whole email, so
 * both `Claude <noreply@anthropic.com>` and a bare `openhands` are caught. A
 * human whose name merely contains one of these tokens would need an entry in
 * ALLOWED_BOTS or a rename; that is the fail-closed direction, and the check's
 * message names the commit so the case is visible rather than silent.
 */
const AGENT_IDENTITY = /(openhands|all-hands\.dev|anthropic|\bclaude\b|copilot|codebuff|openai|\bcodex\b|\bcursor\b|\baider\b|\bdevin\b|gemini|chatgpt)/i;

/** A trailer that names a co-author, whatever its spelling. */
const CO_AUTHOR_TRAILER = /^\s*(?:co-authored-by|authored-by|generated-by|assisted-by)\s*:\s*(.+)$/gim;

/** Normalize one commit from the raw API shape or the flattened workflow shape. */
function commitIdentity(commit) {
  const nested = commit && commit.commit;
  const author = (nested && nested.author) || (typeof commit?.author === 'object' ? commit.author : null) || {};
  const committer = (nested && nested.committer) || (typeof commit?.committer === 'object' ? commit.committer : null) || {};
  const message = (nested && nested.message) || commit?.message || '';
  return {
    sha: (commit && commit.sha) || 'unknown',
    authorName: author.name || 'unknown',
    authorEmail: author.email || '',
    committerName: committer.name || 'unknown',
    committerEmail: committer.email || '',
    message: String(message),
  };
}

/** The co-author trailer values in a commit message. */
function coAuthors(message) {
  const values = [];
  for (const match of String(message).matchAll(CO_AUTHOR_TRAILER)) values.push(match[1].trim());
  return values;
}

function isAgent(name, email) {
  if (ALLOWED_BOTS.test(name)) return false;
  return AGENT_IDENTITY.test(name) || AGENT_IDENTITY.test(email);
}

/**
 * Every commit that carries an agent identity, with the field that carries it.
 * A commit is reported once per offending field so the fix is unambiguous.
 */
function attributionFindings(commits) {
  if (!Array.isArray(commits)) throw new TypeError('the pull request commit list must be an array');
  // `gh api --paginate --slurp` emits an array of page arrays; flatten it so
  // both the single-page and multi-page payloads read the same way.
  const flat = commits.flat();
  const findings = [];
  for (const commit of flat) {
    const identity = commitIdentity(commit);
    const fields = [
      ['author', identity.authorName, identity.authorEmail],
      ['committer', identity.committerName, identity.committerEmail],
    ];
    for (const [field, name, email] of fields) {
      if (isAgent(name, email)) findings.push({ sha: identity.sha, field, value: email ? `${name} <${email}>` : name });
    }
    for (const value of coAuthors(identity.message)) {
      if (isAgent(value, value)) findings.push({ sha: identity.sha, field: 'co-author', value });
    }
  }
  return findings;
}

function formatFailures(findings) {
  const lines = [
    'AI attribution check failed: AGENTS.md section 10 forbids an agent name in a commit',
    'identity or a co-author trailer, so these commits cannot be merged as they stand.',
  ];
  for (const finding of findings) {
    lines.push(`- ${finding.sha.slice(0, 9)} ${finding.field}: ${finding.value}`);
  }
  lines.push(
    'Recreate the commit with the owner as author and committer, and drop the agent '
    + 'trailer. A local `git commit --amend` cannot fix a signed commit without the '
    + 'signing key; use a signed flow such as scripts/create-signed-commit.js.',
  );
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const file = argv[0];
  if (!file) {
    process.stderr.write('usage: check-ai-attribution.js <commits.json>\n');
    return 2;
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    process.stderr.write(`AI attribution check failed: could not read ${file}: ${error.message}\n`);
    return 1;
  }
  let findings;
  try {
    findings = attributionFindings(payload);
  } catch (error) {
    process.stderr.write(`AI attribution check failed: ${error.message}\n`);
    return 1;
  }
  if (findings.length > 0) {
    process.stderr.write(`${formatFailures(findings)}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`check-ai-attribution: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { AGENT_IDENTITY, ALLOWED_BOTS, attributionFindings, coAuthors, commitIdentity, formatFailures, isAgent, main };
