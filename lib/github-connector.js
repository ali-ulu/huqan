const { GITHUB_SOURCE_TYPES, normalizeGitHubItem } = require('./github-connector-normalize');
const { buildGitHubProvenance } = require('./github-connector-provenance');
const { ingestGitHubItem, ingestGitHubItems } = require('./github-connector-ingest');

module.exports = {
  GITHUB_SOURCE_TYPES,
  buildGitHubProvenance,
  normalizeGitHubItem,
  ingestGitHubItem,
  ingestGitHubItems,
};
