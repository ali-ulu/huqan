'use strict';

/**
 * Runs HUQAN's own PR Guardian policy over the pull request that triggered this
 * workflow, inside the runner.
 *
 * The webhook path in `pr-guardian-webhook.yml` is the one an operator wires to
 * a deployed HUQAN. It has never fired here, because it is gated on a
 * `PR_GUARDIAN_WEBHOOK_URL` that does not exist and a webhook cannot reach a
 * laptop (#1968). That left the repository shipping a governance product it did
 * not apply to itself, and a permanently skipped check that reads on the pull
 * request page exactly like a passing one.
 *
 * `evaluatePullRequest` is a pure function over a snapshot, so self-governance
 * needs no endpoint at all: fetch the snapshot, evaluate, report. What this
 * cannot do is emit a canonical Trust Receipt -- that belongs to the runtime,
 * and is the thing the webhook path adds once there is somewhere to send it.
 */

const fs = require('node:fs');
const { evaluatePullRequest, DECISIONS } = require('../lib/pr-guardian/policy');

const MAX_PAGES = 3;
const PER_PAGE = 100;

async function fetchFiles({ api, repo, number, token }) {
  const files = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${api}/repos/${repo}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`;
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'huqan-pr-guardian-self',
      },
    });
    if (!response.ok) throw new Error(`GitHub files read failed: HTTP ${response.status}`);
    const page_ = await response.json();
    files.push(...page_.map(file => ({ filename: file.filename, patch: file.patch || '' })));
    if (page_.length < PER_PAGE) return { files, truncated };
    truncated = page === MAX_PAGES;
  }
  return { files, truncated };
}

function summarize(verdict, snapshot) {
  const lines = [
    '## HUQAN PR Guardian',
    '',
    `**Decision:** \`${verdict.decision}\``,
    `**Reason:** \`${verdict.reason || 'none'}\``,
    `**Risk labels:** ${verdict.riskLabels?.length ? verdict.riskLabels.map(l => `\`${l}\``).join(', ') : '_none_'}`,
    '',
    `Snapshot: ${snapshot.files.length} file(s)${snapshot.filesTruncated ? ' (truncated)' : ''}, head \`${snapshot.headSha.slice(0, 12)}\`.`,
    '',
    'Evaluated in the runner by `lib/pr-guardian/policy.js` from the base tree.',
    'Only `block` fails this check; `review` is a note, not a gate.',
  ];
  return lines.join('\n');
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !token) {
    console.log('::notice::PR Guardian self-review needs GITHUB_EVENT_PATH and GITHUB_TOKEN; skipping.');
    return 0;
  }
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pr = event.pull_request;
  if (!pr) {
    console.log('::notice::No pull_request in the event payload; nothing to review.');
    return 0;
  }

  const repo = event.repository?.full_name || process.env.GITHUB_REPOSITORY;
  const { files, truncated } = await fetchFiles({
    api: process.env.GITHUB_API_URL || 'https://api.github.com',
    repo,
    number: pr.number,
    token,
  });

  const snapshot = {
    repo,
    headSha: pr.head?.sha || '',
    workspaceId: process.env.HUQAN_WORKSPACE_ID || 'default',
    title: pr.title || '',
    body: pr.body || '',
    baseRef: pr.base?.ref || '',
    headRef: pr.head?.ref || '',
    files,
    // The runner has no view of branch protection, so requiredness is unknown
    // and the policy says so rather than reporting a pass it has not earned.
    checks: [],
    filesTruncated: truncated,
  };

  const verdict = evaluatePullRequest(snapshot, { action: 'github.pr.snapshot', phase: 'preview' });
  const summary = summarize(verdict, snapshot);
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  const detail = `${verdict.decision}: ${verdict.reason || 'no risk signal'}${verdict.riskLabels?.length ? ` (${verdict.riskLabels.join(', ')})` : ''}`;
  if (verdict.decision === DECISIONS.BLOCK) {
    console.log(`::error title=HUQAN PR Guardian blocked this change::${detail}`);
    return 1;
  }
  if (verdict.decision === DECISIONS.REVIEW || verdict.decision === DECISIONS.DRY_RUN_ONLY) {
    console.log(`::warning title=HUQAN PR Guardian wants a look::${detail}`);
    return 0;
  }
  console.log(`::notice title=HUQAN PR Guardian::${detail}`);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    // Fail closed on an unexpected error: an unreadable snapshot is not evidence
    // of a safe change.
    console.log(`::error title=HUQAN PR Guardian could not evaluate this change::${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { summarize, fetchFiles };
