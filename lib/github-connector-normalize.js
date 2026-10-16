const crypto = require('crypto');
const { redactGitHubSourceRef } = require('./github-url');
const { normalizeWorkspaceId } = require('./workspace-id');

const GITHUB_SOURCE_TYPES = Object.freeze({
  merged_pr: 'merged_pr',
  open_pr: 'open_pr',
  closed_issue: 'closed_issue',
  open_issue: 'open_issue',
  release_tag: 'release_tag',
  commit_message: 'commit_message',
});

function nowIso() {
  return new Date().toISOString();
}

function sanitize(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function getGraph(kernelOrGraph) {
  return kernelOrGraph && kernelOrGraph.graph ? kernelOrGraph.graph : kernelOrGraph;
}

function buildIdempotencyKey(item = {}, opts = {}) {
  const workspaceId = normalizeWorkspaceId(item.workspaceId || opts.workspaceId);
  const actor = sanitize(item.actor || opts.actor || 'github');
  const sourceRef = sanitize(item.sourceRef || opts.sourceRef);
  return `${sourceRef}|${workspaceId}|${actor}`;
}

function stableCandidateId(item = {}, opts = {}) {
  return `ghcand_${crypto.createHash('sha1').update(buildIdempotencyKey(item, opts), 'utf8').digest('hex').slice(0, 16)}`;
}

function parseRepo(repo = '') {
  const text = sanitize(repo);
  if (!text || !text.includes('/')) return { owner: '', name: '', repo: text };
  const [owner, name] = text.split('/', 2);
  return { owner, name, repo: `${owner}/${name}` };
}

// #2180: one row per known subtype with both of its formats; a new GitHub source type is a row, not
// a case in each builder. Null prototype, so a subtype named like an Object.prototype member is unknown.
const pullRef = ({ repo, number }) => `github://${repo}/pull/${number || '0'}`;
const issueRef = ({ repo, number }) => `github://${repo}/issues/${number || '0'}`;
const SUBTYPE_FORMATS = Object.freeze(Object.assign(Object.create(null), {
  [GITHUB_SOURCE_TYPES.merged_pr]: { sourceRef: pullRef, claim: ({ repo, title, number }) => `PR ${number || '?'} merged in ${repo}: ${title}` },
  [GITHUB_SOURCE_TYPES.open_pr]: { sourceRef: pullRef, claim: ({ repo, title, number }) => `PR ${number || '?'} opened in ${repo}: ${title}` },
  [GITHUB_SOURCE_TYPES.closed_issue]: { sourceRef: issueRef, claim: ({ repo, title, number }) => `Issue ${number || '?'} closed in ${repo}: ${title}` },
  [GITHUB_SOURCE_TYPES.open_issue]: { sourceRef: issueRef, claim: ({ repo, title, number }) => `Issue ${number || '?'} opened in ${repo}: ${title}` },
  [GITHUB_SOURCE_TYPES.release_tag]: {
    sourceRef: ({ repo, tag }) => `github://${repo}/releases/tag/${tag || 'unknown'}`,
    claim: ({ repo, title, tag }) => `Release ${tag || '?'} published in ${repo}: ${title}`,
  },
  [GITHUB_SOURCE_TYPES.commit_message]: {
    sourceRef: ({ repo, sha }) => `github://${repo}/commit/${sha || 'unknown'}`,
    claim: ({ repo, title, sha }) => `Commit ${sha || '?'} in ${repo}: ${title}`,
  },
}));

function buildSourceRef(item = {}) {
  const repo = sanitize(item.repo);
  const subtype = sanitize(item.sourceSubType).toLowerCase();
  const number = item.number != null ? String(item.number).trim() : '';
  const sha = sanitize(item.sha);
  const tag = sanitize(item.tag);

  const format = SUBTYPE_FORMATS[subtype];
  if (format) return format.sourceRef({ repo, number, sha, tag });
  const token = number || sha || tag || sanitize(item.title).toLowerCase().replace(/\s+/g, '-').slice(0, 32) || 'item';
  return `github://${repo}/items/${subtype || 'unknown'}/${token}`;
}

function buildClaimText(item = {}) {
  const repo = sanitize(item.repo);
  const title = sanitize(item.title, 'Untitled');
  const subtype = sanitize(item.sourceSubType).toLowerCase();
  const number = sanitize(item.number);
  const sha = sanitize(item.sha);
  const tag = sanitize(item.tag);

  const format = SUBTYPE_FORMATS[subtype];
  if (format) return format.claim({ repo, title, number, sha, tag });
  return `${subtype || 'github'} item in ${repo}: ${title}`;
}

function normalizeGitHubItem(input = {}, opts = {}) {
  const sourceSubType = sanitize(input.sourceSubType || opts.sourceSubType).toLowerCase();
  const repo = sanitize(input.repo || opts.repo);
  if (!repo) {
    throw new Error('repo is required for GitHub ingestion');
  }
  if (!sourceSubType) {
    throw new Error('sourceSubType is required for GitHub ingestion');
  }
  const workspaceId = normalizeWorkspaceId(input.workspaceId || opts.workspaceId);
  const actor = sanitize(input.actor || opts.actor || `github:${repo || 'unknown'}`, `github:${repo || 'unknown'}`);
  const timestamp = sanitize(input.timestamp || opts.timestamp, nowIso()) || nowIso();
  const title = sanitize(input.title || opts.title || '', '');
  const body = sanitize(input.body || opts.body || '', '');
  const url = redactGitHubSourceRef(sanitize(input.url || opts.url || '', ''));
  const labels = Array.isArray(input.labels) ? [...input.labels] : Array.isArray(opts.labels) ? [...opts.labels] : [];
  const claim = buildClaimText({ ...input, sourceSubType, repo, title });
  const sourceRef = redactGitHubSourceRef(sanitize(input.sourceRef || opts.sourceRef || buildSourceRef({ ...input, sourceSubType, repo, title }), ''));
  const sourceTitle = title || claim;
  const sourceType = 'github';
  const suppliedEdge = input.proposedEdge || opts.proposedEdge;
  const proposedEdge = suppliedEdge && typeof suppliedEdge === 'object'
    ? { ...suppliedEdge, sourceRef: redactGitHubSourceRef(suppliedEdge.sourceRef || sourceRef) }
    : (input.subject || input.relation || input.object
    ? {
        from: input.subject || input.from || `github:${repo || 'unknown'}`,
        relation: input.relation || 'reports',
        to: input.object || input.to || claim,
        confidence: typeof input.confidence === 'number' ? input.confidence : undefined,
        sourceRef,
        workspaceId,
      }
    : {
        from: `github:${repo || 'unknown'}`,
        relation: 'reports',
        to: claim,
        sourceRef,
        workspaceId,
      });

  return {
    sourceType,
    sourceSubType,
    repo,
    ...parseRepo(repo),
    number: input.number != null ? input.number : opts.number,
    sha: sanitize(input.sha || opts.sha, ''),
    tag: sanitize(input.tag || opts.tag, ''),
    title: sourceTitle,
    sourceTitle,
    url,
    body,
    labels,
    actor,
    timestamp,
    workspaceId,
    sourceRef,
    claim,
    proposedEdge,
  };
}

module.exports = {
  GITHUB_SOURCE_TYPES,
  nowIso,
  sanitize,
  stableCandidateId,
  getGraph,
  normalizeGitHubItem,
};
