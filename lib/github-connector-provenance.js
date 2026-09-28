const { buildProvenance } = require('./provenance-ingest');
const { contentHash, CONTENT_HASH_ALGORITHM } = require('./content-hash');
const {
  GITHUB_SOURCE_TYPES,
  sanitize,
  normalizeGitHubItem,
} = require('./github-connector-normalize');

/**
 * The version of the item this connector was handed, if it can be named.
 *
 * This module fetches nothing -- it normalises an item somebody else retrieved.
 * So it cannot resolve a version; it can only record the one the caller states.
 * That is why these come off the input rather than off a request.
 *
 * Which reference is immutable differs by subtype, and the difference is the
 * point: `github://repo/pull/671` keeps resolving after the branch behind it
 * gains commits and after the body is edited, so a receipt citing it names a
 * moving thing. A head sha names one version of it. `commit/<sha>` was already
 * immutable and simply never recorded what it knew.
 *
 * Absent stays absent. An empty sourceVersion would read as "pinned, to
 * nothing" -- a claim where the caller made none. The content hash covers that
 * case instead, and covers every case.
 */
/**
 * The text this item actually carried, in a stable order.
 *
 * What a later reader wants to check is whether the source still says what it
 * said, so this covers the material the claim was drawn from rather than the
 * claim itself.
 */
function sourceMaterial(input = {}, normalized = {}) {
  const title = sanitize(input.title || normalized.sourceTitle || '');
  const body = sanitize(input.body || '');
  return `${title}\n\n${body}`;
}

function resolveItemVersion(input = {}, normalized = {}) {
  const subtype = sanitize(normalized.sourceSubType || input.sourceSubType).toLowerCase();
  const headSha = sanitize(input.headSha || input.head_sha);
  const sha = sanitize(input.sha);

  if (subtype === GITHUB_SOURCE_TYPES.merged_pr || subtype === GITHUB_SOURCE_TYPES.open_pr) {
    if (headSha) return { sourceVersion: headSha, sourceVersionKind: 'pr_head_sha' };
  }
  if (sha) return { sourceVersion: sha, sourceVersionKind: 'commit_sha' };
  if (headSha) return { sourceVersion: headSha, sourceVersionKind: 'pr_head_sha' };
  return {};
}

function buildGitHubProvenance(input = {}, opts = {}) {
  const normalized = normalizeGitHubItem(input, opts);
  const provenanceInput = {
    provenanceId: input.provenanceId || opts.provenanceId || '',
    sourceRef: normalized.sourceRef,
    sourceTitle: normalized.sourceTitle,
    sourceType: 'github',
    sourceSubType: normalized.sourceSubType,
    actor: normalized.actor,
    timestamp: normalized.timestamp,
    confidence: input.confidence ?? opts.confidence,
    workspaceId: normalized.workspaceId,
    // Hash of the source material -- title and body as supplied -- not of the
    // derived claim. Measured, not assumed: the claim for a pull request is
    // "PR 671 merged in o/r: <title>", which is identical before and after the
    // body is rewritten. Hashing it would have produced the same record for two
    // different documents, and the drift a reader needs to see is in the body.
    contentHash: contentHash(sourceMaterial(input, normalized)),
    contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
    ...resolveItemVersion(input, normalized),
  };

  const provenanceBundle = buildProvenance(provenanceInput, {
    ...opts,
    sourceType: 'github',
    sourceSubType: normalized.sourceSubType,
    sourceRef: normalized.sourceRef,
    sourceTitle: normalized.sourceTitle,
    actor: normalized.actor,
    timestamp: normalized.timestamp,
    workspaceId: normalized.workspaceId,
  });

  const warnings = [...provenanceBundle.warnings];
  if (!Object.prototype.hasOwnProperty.call(GITHUB_SOURCE_TYPES, normalized.sourceSubType)) {
    warnings.push(`unknown GitHub sourceSubType: ${normalized.sourceSubType || 'unknown'}`);
  }

  return {
    provenance: provenanceBundle.provenance,
    warnings,
    normalized,
    trustPolicy: provenanceBundle.policy,
  };
}

module.exports = {
  sourceMaterial,
  resolveItemVersion,
  buildGitHubProvenance,
};
