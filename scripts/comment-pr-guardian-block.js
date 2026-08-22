#!/usr/bin/env node

'use strict';

const fs = require('node:fs/promises');

const MARKER = '<!-- huqan-pr-guardian:block:v1 -->';

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value == null ? '' : value).trim();
}

function required(env, name) {
  const value = text(env[name]);
  if (!value) {
    const error = new Error(`${name} is required`);
    error.code = `${name}_REQUIRED`;
    throw error;
  }
  return value;
}

function escapeInline(value) {
  return text(value)
    .replace(/\\/g, '\\\\')
    .replace(/[`*_{}\[\]()#+\-.!|<>]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ');
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${name} must be a positive integer`);
    error.code = `${name}_INVALID`;
    throw error;
  }
  return parsed;
}

async function readJson(path) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (cause) {
    const error = new Error(`could not read JSON response: ${cause.message}`);
    error.code = 'PR_GUARDIAN_RESPONSE_INVALID';
    error.cause = cause;
    throw error;
  }
}

function decisionFrom(response) {
  return text(response?.decision || response?.policy?.decision);
}

function blockReason(response) {
  return text(
    response?.reason
      || response?.policy?.reason
      || response?.code
      || 'PR Guardian policy blocked this action',
  );
}

function buildComment({ response, repo, number, headSha, runUrl, action }) {
  const reason = escapeInline(blockReason(response));
  const code = escapeInline(response?.code || response?.policy?.reason || 'policy_block');
  const target = escapeInline(`${repo}#${number}`);
  const sha = escapeInline(headSha);
  const run = runUrl ? `[workflow run](${runUrl})` : 'workflow run';
  const actionName = escapeInline(action || response?.action || 'github.pr.guardian');

  return [
    MARKER,
    '## HUQAN PR Guardian: merge blocked',
    '',
    `HUQAN PR Guardian **blocked** the requested action for \`${target}\`.`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Decision | \`block\` |`,
    `| Action | \`${actionName}\` |`,
    `| Head SHA | \`${sha}\` |`,
    `| Reason | ${reason} |`,
    `| Policy code | \`${code}\` |`,
    '',
    'No merge, deploy, force-push, or other external mutation was authorized.',
    'Resolve the policy finding and push a new commit to trigger a fresh review.',
    '',
    `This managed warning is emitted by HUQAN PR Guardian. See the ${run}.`,
  ].join('\n');
}

/**
 * Page budget for the managed-comment search: 2000 comments at per_page=100.
 * A bound rather than a while(next) loop, so a malformed or cyclic Link header
 * cannot turn this into an unbounded run of authenticated requests.
 */
const MAX_COMMENT_PAGES = 20;

async function githubRequest({ apiBaseUrl, token, method, path, body }) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'user-agent': 'huqan-pr-guardian-block-comment',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = { raw }; }
  if (!response.ok) {
    const error = new Error(`GitHub API request failed: ${response.status}`);
    error.code = 'GITHUB_COMMENT_API_ERROR';
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return { data: parsed, link: text(response.headers?.get?.('link')) };
}

/**
 * The `rel="next"` target of a Link header, as a path under `apiBaseUrl`.
 *
 * Returns '' when there is no next page. Throws when the header names a
 * different host: this request carries a bearer token, so following a URL the
 * response chose would hand that token to whoever chose it. A pagination
 * cursor is allowed to move us through the API, not off it.
 */
function nextPagePath(link, apiBaseUrl) {
  if (!link) return '';
  const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(link);
  if (!match) return '';
  const target = text(match[1]);
  if (!target) return '';
  if (!target.startsWith(`${apiBaseUrl}/`)) {
    const error = new Error('GitHub pagination pointed outside the configured API host');
    error.code = 'GITHUB_COMMENTS_PAGINATION_INVALID';
    error.target = target;
    throw error;
  }
  return target.slice(apiBaseUrl.length);
}

/**
 * The managed comment, wherever it is, or null when it is genuinely absent.
 *
 * The search used to read one page. A PR with more than 100 issue comments
 * therefore hid an existing marker behind the first page, and the caller --
 * finding nothing -- posted another comment, which is the opposite of the
 * idempotency this script exists to provide.
 *
 * Two failures are deliberately *not* reported as "absent", because absent is
 * what makes the caller create a comment:
 *
 *   - a request that fails partway through the pages: it throws;
 *   - a PR longer than the page budget: it throws.
 *
 * "Not in the pages I could read" is not "not there", and treating it as such
 * is precisely the duplicate this fixes. A run that cannot complete the search
 * leaves the thread untouched and fails loudly instead.
 */
async function findManagedComment({ apiBaseUrl, token, encodedRepo, number, botLogin }) {
  let path = `/repos/${encodedRepo}/issues/${number}/comments?per_page=100`;

  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const { data, link } = await githubRequest({ apiBaseUrl, token, method: 'GET', path });
    if (!Array.isArray(data)) {
      const error = new Error('GitHub comments response was not an array');
      error.code = 'GITHUB_COMMENTS_RESPONSE_INVALID';
      throw error;
    }

    const found = data.find(comment => (
      comment
        && comment.user?.login === botLogin
        && typeof comment.body === 'string'
        && comment.body.includes(MARKER)
    ));
    if (found?.id) return found;

    const next = nextPagePath(link, apiBaseUrl);
    if (!next) return null;
    path = next;
  }

  const error = new Error(
    `PR has more than ${MAX_COMMENT_PAGES} pages of comments; the managed comment could not be ruled out`,
  );
  error.code = 'GITHUB_COMMENTS_PAGINATION_EXHAUSTED';
  throw error;
}

async function run(env = process.env) {
  const responseFile = required(env, 'PR_GUARDIAN_RESPONSE_FILE');
  const token = required(env, 'GITHUB_TOKEN');
  const repo = required(env, 'GITHUB_REPOSITORY');
  const number = parsePositiveInteger(required(env, 'PR_NUMBER'), 'PR_NUMBER');
  const headSha = required(env, 'PR_HEAD_SHA');
  const apiBaseUrl = text(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const runUrl = text(env.PR_GUARDIAN_RUN_URL);
  const action = text(env.PR_GUARDIAN_ACTION || 'github.pr.guardian');
  const response = await readJson(responseFile);
  const decision = decisionFrom(response);

  if (!decision) {
    const error = new Error('PR Guardian response did not contain a decision');
    error.code = 'PR_GUARDIAN_DECISION_MISSING';
    throw error;
  }
  if (decision !== 'block') {
    return { ok: true, commented: false, decision };
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    const error = new Error('GITHUB_REPOSITORY must have owner/name format');
    error.code = 'GITHUB_REPOSITORY_INVALID';
    throw error;
  }

  const encodedRepo = repo.split('/').map(encodeURIComponent).join('/');
  const botLogin = text(env.GITHUB_ACTIONS_BOT_LOGIN || 'github-actions[bot]');
  const existing = await findManagedComment({ apiBaseUrl, token, encodedRepo, number, botLogin });

  const body = buildComment({ response, repo, number, headSha, runUrl, action });

  if (existing?.id) {
    const updated = await githubRequest({
      apiBaseUrl,
      token,
      method: 'PATCH',
      path: `/repos/${encodedRepo}/issues/comments/${encodeURIComponent(existing.id)}`,
      body: { body },
    });
    return { ok: true, commented: true, updated: true, commentId: existing.id, response: updated.data };
  }

  const created = await githubRequest({
    apiBaseUrl,
    token,
    method: 'POST',
    path: `/repos/${encodedRepo}/issues/${number}/comments`,
    body: { body },
  });
  return { ok: true, commented: true, created: true, commentId: created.data?.id || null, response: created.data };
}

if (require.main === module) {
  run()
    .then(result => {
      if (result.commented) {
        console.log(`HUQAN PR Guardian block comment ${result.updated ? 'updated' : 'created'} for ${process.env.GITHUB_REPOSITORY}#${process.env.PR_NUMBER}.`);
      } else {
        console.log(`HUQAN PR Guardian decision was ${result.decision}; no block comment was needed.`);
      }
    })
    .catch(error => {
      console.error(`HUQAN PR Guardian block comment failed: ${error.code || error.message}`);
      process.exitCode = 1;
    });
}

module.exports = Object.freeze({ MARKER, buildComment, run });
