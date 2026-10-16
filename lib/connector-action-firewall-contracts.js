'use strict';

// #2190: the firewall version, how a connector contract is declared, every
// connector action's contract, and the coverage map derived from them.

const CONNECTOR_ACTION_FIREWALL_VERSION = 'CAF-v1.0.0';

function connectorContract(spec = {}) {
  const { sourceRefs = [], ...contract } = spec;
  return Object.freeze({
    ...contract,
    coverage: Object.freeze({
      productionReachable: true,
      sourceRefs: Object.freeze([...sourceRefs]),
      executorBoundary: 'executeConnectorAction',
      targetField: contract.targetField,
      workspaceField: 'workspaceId',
      branchField: 'branch',
      // The current connector family is read/preview/ingest only; no action
      // accepts a baseBranch selector. Keep that absence explicit rather than
      // implying branch-protection or deployment semantics.
      baseBranchField: null,
      approvalField: 'approval',
      previewField: 'preview',
      dryRunField: 'dryRun',
      rateCostPolicy: 'bounded_admission_budget_only',
      chainingPolicy: 'not_implemented_non_claim',
      stateChanging: contract.stateMutationBoundary !== 'none',
    }),
  });
}

// These are admission-time, per-call budgets. They bound target fan-out and
// estimated work before an executor is reached; they are not a global rate
// limiter, monetary meter, or cross-call chain detector. Those remain explicit
// non-claims until a durable policy owner is wired to this boundary.
const CONNECTOR_ACTIONS = Object.freeze({
  github: Object.freeze({
    ingest: connectorContract({
      canonicalAction: 'github.read_repository',
      firewallAction: 'read_repository',
      targetField: 'repoUrl',
      executor: 'fetchRepoFiles',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
      budget: Object.freeze({ class: 'remote_repository_read', maxTargets: 1, costPerTarget: 1, maxCostUnits: 1 }),
      egressClass: 'github_remote_read',
      sourceRefs: ['lib/connectors/repo-memory-firewall.js', 'adapters/github-adapter.js'],
    }),
  }),
  markdown: Object.freeze({
    ingest: connectorContract({
      canonicalAction: 'markdown.read_source',
      firewallAction: 'read_repository',
      targetField: 'targetPath',
      executor: 'ingestMarkdown',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
      budget: Object.freeze({ class: 'local_source_read', maxTargets: 1, costPerTarget: 1, maxCostUnits: 1 }),
      egressClass: 'local_filesystem_read',
      sourceRefs: ['lib/connectors/repo-memory-firewall.js', 'adapters/markdown-adapter.js'],
    }),
  }),
  json: Object.freeze({
    ingest: connectorContract({
      canonicalAction: 'json.read_source',
      firewallAction: 'read_repository',
      targetField: 'targetPath',
      executor: 'ingestJson',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
      budget: Object.freeze({ class: 'local_source_read', maxTargets: 1, costPerTarget: 1, maxCostUnits: 1 }),
      egressClass: 'local_filesystem_read',
      sourceRefs: ['lib/connectors/repo-memory-firewall.js', 'adapters/json-adapter.js'],
    }),
  }),
  yaml: Object.freeze({
    ingest: connectorContract({
      canonicalAction: 'yaml.read_source',
      firewallAction: 'read_repository',
      targetField: 'targetPath',
      executor: 'ingestYaml',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
      budget: Object.freeze({ class: 'local_source_read', maxTargets: 1, costPerTarget: 1, maxCostUnits: 1 }),
      egressClass: 'local_filesystem_read',
      sourceRefs: ['lib/connectors/repo-memory-firewall.js', 'adapters/yaml-adapter.js'],
    }),
  }),
  'git-log': Object.freeze({
    ingest: connectorContract({
      canonicalAction: 'git_log.read_source',
      firewallAction: 'read_repository',
      targetField: 'targetPath',
      executor: 'ingestGitLog',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
      budget: Object.freeze({ class: 'local_source_read', maxTargets: 1, costPerTarget: 1, maxCostUnits: 1 }),
      egressClass: 'local_filesystem_read',
      sourceRefs: ['lib/connectors/repo-memory-firewall.js', 'adapters/git-log-adapter.js'],
    }),
  }),
  pdf: Object.freeze({
    ingest: connectorContract({
      canonicalAction: 'pdf.read_source',
      firewallAction: 'read_repository',
      targetField: 'targetPath',
      executor: 'ingestPdf',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
      budget: Object.freeze({ class: 'local_source_read', maxTargets: 1, costPerTarget: 1, maxCostUnits: 1 }),
      egressClass: 'local_filesystem_read',
      sourceRefs: ['lib/connectors/repo-memory-firewall.js', 'adapters/pdf-adapter.js'],
    }),
  }),
  http: Object.freeze({
    ingest: connectorContract({
      canonicalAction: 'http.fetch_url',
      firewallAction: 'read_repository',
      targetField: 'urls',
      executor: 'ingestUrls',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
      budget: Object.freeze({ class: 'bounded_http_ingest', maxTargets: 4, costPerTarget: 1, maxCostUnits: 4 }),
      egressClass: 'external_http_read',
      sourceRefs: ['lib/connectors/repo-memory-firewall.js', 'adapters/http-adapter.js'],
    }),
    probe: connectorContract({
      canonicalAction: 'http.probe_url',
      firewallAction: 'read_repository',
      targetField: 'url',
      executor: 'fetchUrl',
      stateMutationBoundary: 'none',
      budget: Object.freeze({ class: 'bounded_http_probe', maxTargets: 1, costPerTarget: 1, maxCostUnits: 1 }),
      egressClass: 'external_http_probe',
      sourceRefs: ['plugins/evidence-validator.js', 'adapters/http-adapter.js'],
    }),
  }),
});

const CONNECTOR_ACTION_COVERAGE = Object.freeze(Object.fromEntries(
  Object.entries(CONNECTOR_ACTIONS).map(([connector, actions]) => [
    connector,
    Object.freeze(Object.fromEntries(
      Object.entries(actions).map(([action, contract]) => [action, contract.coverage]),
    )),
  ]),
));

module.exports = {
  CONNECTOR_ACTIONS,
  CONNECTOR_ACTION_COVERAGE,
  CONNECTOR_ACTION_FIREWALL_VERSION,
};
