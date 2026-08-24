'use strict';

const { normalizePullRequestSnapshot } = require('./snapshot');

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

  return Object.freeze({
    async getPullRequestSnapshot(repo, number, { workspaceId, deliveryId } = {}) {
      const pr = await request(`/repos/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`);
      const files = await request(`/repos/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/files?per_page=100`);
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
