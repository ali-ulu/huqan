'use strict';

const { normalizePullRequestSnapshot } = require('./snapshot');

// GitHub returns at most 100 files per page. Ten pages is a deliberate ceiling:
// enough for any review-worthy PR, bounded enough that one enormous PR cannot
// turn a webhook into a thousand API calls. Reaching it is reported rather than
// swallowed -- see `filesTruncated`.
const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 10;

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value == null ? '' : value).trim();
}

function createGitHubRestClient({ token = '', apiBaseUrl = 'https://api.github.com', userAgent = 'huqan-pr-guardian' } = {}) {
  const bearer = text(token);
  if (!bearer) return null;
  const base = text(apiBaseUrl).replace(/\/$/, '');

  async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': userAgent,
        authorization: `Bearer ${bearer}`,
        ...(options.headers || {}),
      },
    });
    const raw = await response.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = { raw }; }
    if (!response.ok) {
      const error = new Error(`GitHub API request failed: ${response.status}`);
      error.code = 'GITHUB_API_ERROR';
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  /**
   * Every changed file, not just the first page.
   *
   * The files endpoint was requested once with `per_page=100` and the response's
   * pagination ignored, so file 101 onward never entered the snapshot -- and the
   * policy derives every risk signal from `files[].filename` and
   * `files[].patch`. A secret or a migration sitting past file 100 was invisible,
   * and reordering the same PR's files could change the decision (#1308).
   *
   * @returns {Promise<{files: object[], truncated: boolean}>}
   */
  async function fetchPullRequestFiles(repo, number) {
    const files = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
      // eslint-disable-next-line no-await-in-loop -- pages must be walked in order.
      const batch = await request(`/repos/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/files?per_page=${FILES_PER_PAGE}&page=${page}`);
      const rows = Array.isArray(batch) ? batch : [];
      files.push(...rows);
      // A short page is the last page.
      if (rows.length < FILES_PER_PAGE) return { files, truncated: false };
    }
    // The budget ran out with a full final page, so more files may exist. The
    // caller is told rather than handed a silently partial list.
    return { files, truncated: true };
  }

  return Object.freeze({
    async getPullRequestSnapshot(repo, number, { workspaceId, deliveryId } = {}) {
      const pr = await request(`/repos/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`);
      const { files, truncated: filesTruncated } = await fetchPullRequestFiles(repo, number);
      const checks = pr.head?.sha
        ? await request(`/repos/${encodeURIComponent(repo)}/commits/${encodeURIComponent(pr.head.sha)}/check-runs?per_page=100`).then(data => (data.check_runs || []).map(check => ({
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
            // Deliberately absent, not `false`. The check-runs API does not say
            // which checks are required -- that is branch protection state
            // (/branches/{base}/protection/required_status_checks), which this
            // client does not read and a GitHub App without admin scope cannot.
            // Claiming `required: false` told the policy gate that nothing was
            // required, which is a different statement from "unknown" and it
            // silently disabled the required-checks escalation (#1267).
          })))
        : [];
      return normalizePullRequestSnapshot({
        repo,
        number,
        title: pr.title,
        body: pr.body,
        baseRef: pr.base?.ref,
        headRef: pr.head?.ref,
        headSha: pr.head?.sha,
        actor: pr.user?.login,
        url: pr.html_url,
        labels: (pr.labels || []).map(label => label.name),
        files,
        filesTruncated,
        checks,
        workspaceId,
        deliveryId,
      });
    },

    async createComment(repo, number, body) {
      return request(`/repos/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: text(body) }),
      });
    },

    async createStatus(repo, sha, { state, description, context } = {}) {
      return request(`/repos/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(sha)}`, {
        method: 'POST',
        body: JSON.stringify({ state: text(state), description: text(description), context: text(context || 'huqan/pr-guardian') }),
      });
    },
  });
}

module.exports = Object.freeze({ createGitHubRestClient });
