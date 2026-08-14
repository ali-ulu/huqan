'use strict';

/**
 * The immutable reference for a repository file that has already been fetched.
 *
 * adapters/github-adapter.js resolves a branch to a commit and reads every file
 * at that commit, handing back `commitSha` on each one. This turns what it
 * already holds into the fields a provenance record needs -- it resolves
 * nothing and fetches nothing, deliberately: a second resolution here could
 * disagree with the one the bytes actually came from, and a record that names a
 * commit it did not read is worse than one that names none.
 *
 * `repo:<owner>/<repo>:<path>` keeps resolving after the branch moves, so two
 * ingests of a file that changed produce the same reference. Adding the commit
 * is what makes them tell apart.
 */

const { contentHash, CONTENT_HASH_ALGORITHM } = require('./content-hash');
const { buildProvenance } = require('./provenance-ingest');

/**
 * @param {string} owner
 * @param {string} repo
 * @param {{path: string, content?: string, commitSha?: string}} file
 *   as returned by adapters/github-adapter.js fetchRepoFiles
 * @returns {{sourceRef: string, contentHash: string, contentHashAlgorithm: string,
 *            sourceVersion?: string, sourceVersionKind?: string}}
 */
function pinnedRepoFile(owner, repo, file = {}) {
  const filePath = String(file.path || '');
  const commitSha = String(file.commitSha || '').trim();

  const pinned = {
    sourceRef: commitSha
      ? `repo:${owner}/${repo}@${commitSha}:${filePath}`
      : `repo:${owner}/${repo}:${filePath}`,
    contentHash: contentHash(file.content || ''),
    contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
  };

  // Absent stays absent. A file that arrived without a commit must not produce
  // a record that reads as pinned to one.
  if (commitSha) {
    pinned.sourceVersion = commitSha;
    pinned.sourceVersionKind = 'commit_sha';
  }

  return pinned;
}

/**
 * Provenance for a connector-sourced record.
 *
 * The pinning fields travel through `...pinning` rather than being named: a
 * fixed destructuring list is what silently dropped sourceVersion and
 * contentHash on their way in, and the next field added upstream would have
 * gone the same way.
 */
function buildConnectorProvenance({
  sourceType,
  sourceSubType,
  sourceRef,
  sourceTitle,
  actor,
  workspaceId,
  confidence,
  timestamp,
  ...pinning
}) {
  return buildProvenance({
    ...pinning,
    sourceType,
    sourceSubType,
    sourceRef,
    sourceTitle,
    actor,
    workspaceId,
    confidence,
    timestamp,
  }).provenance;
}

module.exports = { pinnedRepoFile, buildConnectorProvenance };
