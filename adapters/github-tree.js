const { toError, buildHeaders, normalizePath, parseRateLimitError } = require('./github-adapter-utils');

/**
 * Resolve a branch (or tag, or SHA) to the commit it names right now.
 *
 * Everything downstream addresses content by this SHA rather than by the branch.
 * A branch is a moving target: recording `blob/main/README.md` produces a
 * reference that keeps resolving after the content behind it changes, so a
 * reader following the receipt gets today's file and compares it against a hash
 * taken from a different one. Costs one API call, and buys a reference that
 * still means what it meant.
 */
async function resolveCommitSha(owner, repo, ref, token, fetchImpl) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
  const res = await fetchImpl(url, { method: 'GET', headers: buildHeaders(token) });
  if (!res.ok) {
    throw parseRateLimitError(res, `Failed to resolve ref to a commit (${res.status}): ${ref}`);
  }
  const payload = await res.json();
  const sha = payload && typeof payload.sha === 'string' ? payload.sha.trim() : '';
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    // Fail rather than fall back to the branch name: a silent fallback is how a
    // record ends up naming a version it never read.
    throw toError(`GitHub did not return a commit SHA for ref: ${ref}`, 'GITHUB_REF_UNRESOLVED');
  }
  return sha;
}

async function fetchTreePayload(owner, repo, treeSha, token, fetchImpl, { recursive = false, budget } = {}) {
  if (budget) {
    budget.treeRequests += 1;
    if (budget.treeRequests > budget.limits.maxTreeRequests) throw toError('GitHub tree request limit exceeded', 'GITHUB_TREE_WORK_LIMIT');
  }
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeSha)}${recursive ? '?recursive=1' : ''}`;
  const treeRes = await fetchImpl(treeUrl, {
    method: 'GET',
    headers: buildHeaders(token),
  });

  if (!treeRes.ok) {
    throw parseRateLimitError(treeRes, `Failed to fetch repository tree (${treeRes.status})`);
  }

  const payload = await treeRes.json();
  if (budget) {
    budget.treeEntries += Array.isArray(payload?.tree) ? payload.tree.length : 0;
    if (budget.treeEntries > budget.limits.maxTreeEntries) throw toError('GitHub tree entry limit exceeded', 'GITHUB_TREE_WORK_LIMIT');
  }
  return payload;
}

function treeBlobPaths(treePayload, prefix = '') {
  const tree = Array.isArray(treePayload && treePayload.tree) ? treePayload.tree : [];
  return tree
    .filter(item => item && item.type === 'blob' && typeof item.path === 'string')
    .map(item => normalizePath(prefix ? `${prefix}/${item.path}` : item.path));
}

/**
 * Can a path the caller asked for live under this directory?
 *
 * Only used to bound the walk below. With explicit paths the answer is exact.
 * With the default filter, includePath() accepts root blobs and anything under
 * `.github/`, so no other subtree can contribute a file and none is entered.
 */
function subtreeCanContainWantedPaths(dirPath, explicitPaths) {
  const lower = `${dirPath.toLowerCase()}/`;
  if (explicitPaths && explicitPaths.length > 0) {
    return explicitPaths.some(item => item.toLowerCase().startsWith(lower));
  }
  return lower === '.github/' || lower.startsWith('.github/');
}

/**
 * Enumerate blobs one directory at a time, entering only the subtrees that can
 * still hold a wanted path.
 *
 * The single `?recursive=1` call is cheaper and is still the normal path. But
 * GitHub answers it with `truncated: true` once a repository is large enough,
 * and a truncated tree is a partial tree that looks exactly like a complete
 * one: the adapter used to read `treePayload.tree` and return the surviving
 * subset as a successful, apparently full scan (#689). Failing there would be
 * honest but would make large repositories unreadable, so the truncation is
 * repaired instead -- and a subtree that is itself truncated, which no walk can
 * repair, fails closed rather than returning a quietly short list.
 */
async function walkTreeBlobPaths(owner, repo, commitSha, token, fetchImpl, explicitPaths, budget) {
  const paths = [];
  const queue = [{ path: '', sha: commitSha }];
  const visited = new Set();

  while (queue.length > 0) {
    const dir = queue.shift();
    if (visited.has(dir.path)) continue;
    visited.add(dir.path);

    const payload = await fetchTreePayload(owner, repo, dir.sha, token, fetchImpl, { budget });
    if (payload && payload.truncated === true) {
      throw toError(
        `GitHub returned a truncated tree for a single directory, so the file list cannot be completed: ${dir.path || '<root>'}`,
        'GITHUB_TREE_TRUNCATED',
      );
    }

    for (const path of treeBlobPaths(payload, dir.path)) paths.push(path);

    const entries = Array.isArray(payload && payload.tree) ? payload.tree : [];
    for (const item of entries) {
      if (!item || item.type !== 'tree' || typeof item.path !== 'string') continue;
      const childPath = normalizePath(dir.path ? `${dir.path}/${item.path}` : item.path);
      if (!subtreeCanContainWantedPaths(childPath, explicitPaths)) continue;
      if (typeof item.sha !== 'string' || !item.sha) {
        throw toError(
          `GitHub returned a tree entry without a sha, so its contents cannot be listed: ${childPath}`,
          'GITHUB_TREE_INCOMPLETE',
        );
      }
      queue.push({ path: childPath, sha: item.sha });
    }
  }

  return paths;
}

module.exports = {
  resolveCommitSha,
  fetchTreePayload,
  treeBlobPaths,
  subtreeCanContainWantedPaths,
  walkTreeBlobPaths,
};
