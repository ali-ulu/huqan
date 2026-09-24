'use strict';

// #2167: bounded GitHub reads -- the exact pull request head and its changed
// files -- each under the evaluation's remaining time budget.

const { GITHUB_API_VERSION } = require('./github-app-beta-auth');
const { isPlainObject } = require('./is-plain-object');
const { ERROR_CODES, FILES_PER_PAGE, FILE_STATUSES, GITHUB_API_BASE, MAX_FILES, MAX_FILE_PAGES, MAX_PATH_BYTES, MAX_TOTAL_CHANGES, SHA_PATTERN, fail } = require('./github-app-streaming-trust-contract');

function repositoryParts(repositoryFullName) {
  const parts = repositoryFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust repository identity is invalid');
  return parts.map(part => encodeURIComponent(part));
}

function apiHeaders(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust installation token is invalid');
  }
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'huqan-streaming-trust',
  };
}

async function fetchJson(fetchImpl, url, options, errorCode, signal) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal });
  } catch (_) {
    if (signal?.aborted) fail(ERROR_CODES.BUDGET_EXCEEDED, 'Streaming Trust evaluation budget expired during a GitHub request');
    fail(errorCode, 'Streaming Trust GitHub request failed');
  }
  if (!response || response.ok !== true || typeof response.json !== 'function') {
    fail(errorCode, 'Streaming Trust GitHub request was rejected');
  }
  try {
    return await response.json();
  } catch (_) {
    if (signal?.aborted) fail(ERROR_CODES.BUDGET_EXCEEDED, 'Streaming Trust evaluation budget expired while reading a GitHub response');
    fail(errorCode, 'Streaming Trust GitHub response is invalid');
  }
}

/**
 * A budget the loop reads from a monotonic source, not from `nowMs`.
 *
 * `nowMs` is the canonical instant stamped into the receipt: one value for the
 * whole delivery, deliberately not moving. Measuring elapsed time with it would
 * always read zero.
 */
function createBudget({ budgetMs, elapsedMs }) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) {
    fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust budget is invalid');
  }
  const started = elapsedMs();
  return function requireBudget(stage) {
    const remainingMs = budgetMs - (elapsedMs() - started);
    if (remainingMs <= 0) {
      fail(ERROR_CODES.BUDGET_EXCEEDED, `Streaming Trust gave up before ${stage}: its evaluation budget is spent`);
    }
    return remainingMs;
  };
}

function budgetSignal(requireBudget, stage) {
  return AbortSignal.timeout(requireBudget(stage));
}

async function readExactPullRequest({ binding, token, fetchImpl, requireBudget = () => 30_000 }) {
  const signal = budgetSignal(requireBudget, 'reading the pull request');
  const [owner, repo] = repositoryParts(binding.repositoryFullName);
  const payload = await fetchJson(
    fetchImpl,
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${binding.pullRequestNumber}`,
    { method: 'GET', headers: apiHeaders(token) },
    ERROR_CODES.PR_READ_FAILED, signal,
  );
  if (!isPlainObject(payload)
      || payload.number !== binding.pullRequestNumber
      || !isPlainObject(payload.base)
      || !isPlainObject(payload.base.repo)
      || payload.base.repo.id !== binding.repositoryId
      || payload.base.repo.full_name !== binding.repositoryFullName
      || !isPlainObject(payload.head)
      || typeof payload.head.sha !== 'string'
      || !SHA_PATTERN.test(payload.head.sha)) {
    fail(ERROR_CODES.PR_RESPONSE_INVALID, 'Streaming Trust pull request response is not bound to the delivery');
  }
  if (payload.head.sha !== binding.headSha) {
    fail(ERROR_CODES.HEAD_DRIFT, 'Streaming Trust refuses to evaluate a pull request after head drift');
  }
  return Object.freeze({ headSha: payload.head.sha });
}

function snapshotChangedFile(value) {
  if (!isPlainObject(value)
      || typeof value.filename !== 'string'
      || value.filename.length === 0
      || Buffer.byteLength(value.filename, 'utf8') > MAX_PATH_BYTES
      || value.filename.includes('\0')
      || typeof value.status !== 'string'
      || !FILE_STATUSES.has(value.status)
      || !Number.isSafeInteger(value.additions) || value.additions < 0
      || !Number.isSafeInteger(value.deletions) || value.deletions < 0) {
    fail(ERROR_CODES.FILES_RESPONSE_INVALID, 'Streaming Trust changed-file response is invalid');
  }
  return Object.freeze({
    path: value.filename,
    status: value.status,
    changeType: 'source',
    additions: value.additions,
    deletions: value.deletions,
  });
}

async function readChangedFiles({ binding, token, fetchImpl, requireBudget = () => 30_000 }) {
  const [owner, repo] = repositoryParts(binding.repositoryFullName);
  const files = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const signal = budgetSignal(requireBudget, `reading changed-file page ${page}`);
    const payload = await fetchJson(
      fetchImpl,
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${binding.pullRequestNumber}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
      { method: 'GET', headers: apiHeaders(token) },
      ERROR_CODES.FILES_READ_FAILED, signal,
    );
    if (!Array.isArray(payload) || payload.length > FILES_PER_PAGE) {
      fail(ERROR_CODES.FILES_RESPONSE_INVALID, 'Streaming Trust changed-file page is invalid');
    }
    if (files.length + payload.length > MAX_FILES) {
      fail(ERROR_CODES.EVIDENCE_TOO_LARGE, 'Streaming Trust changed-file count exceeds its bound');
    }
    for (const item of payload) {
      const file = snapshotChangedFile(item);
      totalAdditions += file.additions;
      totalDeletions += file.deletions;
      if (!Number.isSafeInteger(totalAdditions)
          || !Number.isSafeInteger(totalDeletions)
          || totalAdditions + totalDeletions > MAX_TOTAL_CHANGES) {
        fail(ERROR_CODES.EVIDENCE_TOO_LARGE, 'Streaming Trust changed-file totals exceed their bound');
      }
      files.push(file);
    }
    if (payload.length < FILES_PER_PAGE) break;
    if (page === MAX_FILE_PAGES) {
      fail(ERROR_CODES.EVIDENCE_TOO_LARGE, 'Streaming Trust changed-file pagination exceeds its bound');
    }
  }

  return Object.freeze({
    files: Object.freeze(files),
    fileCount: files.length,
    totalAdditions,
    totalDeletions,
  });
}

module.exports = {
  apiHeaders,
  budgetSignal,
  createBudget,
  fetchJson,
  readChangedFiles,
  readExactPullRequest,
  repositoryParts,
  snapshotChangedFile,
};
