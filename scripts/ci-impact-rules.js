'use strict';

/**
 * Change-classification tables for the CI impact plan.
 *
 * These are the hand-written glob pairs that `ci-impact-plan.js` matched
 * changes against before dependency-derived selection existed (#2610). They are
 * data, not logic, so they live here: the plan engine stays under the file-size
 * budget and the tables can be reviewed as a diff on their own.
 *
 * The tables are now a floor rather than the whole answer. `ci-test-selection.js`
 * derives additional tests from the real dependency graph, because a table can
 * only describe the tree and drifts silently when the tree moves -- #2505 C
 * changed `lib/external-action-identity.js`, matched no rule here at all, and
 * five suites that should have run did not.
 *
 * Keep every entry. The union of these patterns is what guarantees the
 * safety-critical surface is selected regardless of what the graph says.
 */

/** Always selected whenever the plan runs at all. */
const MUST_HAVE_PATTERNS = Object.freeze([
  'agent.v3.test.js',
  'agentRuntime.test.js',
  'capability.test.js',
  'cli.test.js',
  'graph.test.js',
  'kernel.test.js',
  'kernel.v2.test.js',
  'mcpServer.test.js',
  'requestGuards.test.js',
  'server.test.js',
  'test/action-risk-classifier.test.js',
  'test/agent-action-firewall.test.js',
  'test/approval*.test.js',
  'test/automation-safety-gate.test.js',
  'test/ci-*.test.js',
  'test/classifier-downgrade-fail-closed.test.js',
  'test/code-change-gate.test.js',
  'test/command-exec-gate.test.js',
  'test/connector-action-firewall.test.js',
  'test/connector-firewall-coverage.contract.test.js',
  'test/cross-workspace-access-gate.test.js',
  'test/data-egress-gate.test.js',
  'test/durable-mutation-journal.test.js',
  'test/faz2-admission-*.test.js',
  'test/faz2-*-gate-*.test.js',
  'test/faz2-*-parity.contract.test.js',
  'test/faz2-universal-mutation-boundary.contract.test.js',
  'test/import-cycles.test.js',
  'test/memory-admission-*.test.js',
  'test/memory-mutation-gate.test.js',
  'test/memory-schema*.test.js',
  'test/memory-store*.test.js',
  'test/module-reachability*.test.js',
  // #3014's wiring-debt ratchet. It is not reachable from any changed file:
  // it reads the live analyzeReachability() surface and pins it to
  // config/reachability-baseline.json, so neither a lib/ edit in
  // lib/module-reachability.js nor a new leaf module puts it in the selection.
  // #3164 and #3170 both added unreachable modules, changed nothing the
  // graph could see, and left the ratchet unrun — main went red with the
  // baseline unexplained until #3169 and #3173 fixed it by hand. The
  // reachability surface is safety-critical, so pin it to the floor.
  'test/reachability-baseline.test.js',
  // #3069's self-run vs third-party boundary. It reads the README, the
  // conformance runners and the published 0.2 bundle contract, so no changed
  // lib/ file reaches it through the require graph; without this entry a PR
  // that moved the boundary would leave the guard unselected.
  'test/third-party-interoperability-boundary.test.js',
  'test/mutation-admission*.test.js',
  'test/mutation-journal*.test.js',
  // #3197's review-rule contract. It reads .opencodereview/rule.json, a config
  // file no lib/ module requires, so editing the rule file selects nothing that
  // reaches this pin -- the same shape as the reachability ratchet above.
  'test/opencodereview-rule-file.test.js',
  'test/operator-token-constant-time.test.js',
  'test/package-closure.test.js',
  'test/path-containment-*.test.js',
  'test/path-safety.test.js',
  'test/persistence-path-*.test.js',
  'test/plugin-manifest-integrity.test.js',
  'test/plugin-hash-portability.test.js',
  'test/provenance*.test.js',
  'test/receipt-*.test.js',
  'test/route-auth-policy.test.js',
  'test/rustGraph-workspace-isolation.test.js',
  'test/sandbox-*.test.js',
  'test/secret-*-gate.test.js',
  'test/secret-and-sourceref-redaction.test.js',
  'test/tenancy-boundary.test.js',
  'test/tool-call-gate*.test.js',
  'test/tool-policy.test.js',
  'test/traversal-and-policy-fail-closed.test.js',
  'test/verify-*.test.js',
  'test/workflow-action-pinning.test.js',
  'test/workspace-id.test.js',
]);

/** Changed-path globs to test globs, for the surfaces a glob pair can describe. */
const IMPACT_RULES = Object.freeze([
  {
    name: 'graph-kernel-memory',
    changed: ['graph.js', 'kernel.js', 'kernel.v2.js', 'storage.js', 'rustGraph.js', 'lib/graph-*.js', 'lib/memory-*.js', 'lib/ingest*.js'],
    tests: ['graph.test.js', 'kernel*.test.js', 'test/graph-*.test.js', 'test/kernel-*.test.js', 'test/memory-*.test.js', 'test/receipt-*.test.js', 'test/provenance*.test.js', 'test/reasonSandbox.test.js'],
  },
  {
    name: 'server-mcp-http',
    changed: ['server.js', 'mcpServer.js', 'lib/http/**', 'lib/mcp/**', 'lib/a2a/**'],
    tests: ['server.test.js', 'mcpServer*.test.js', 'test/a2a-*.test.js', 'test/http-*.test.js', 'test/mcp-*.test.js', 'test/route-auth-policy.test.js', 'test/approval*.test.js', 'test/workflow-*.test.js', 'test/v4-ui-*.test.js', 'test/v4-wb*.test.js'],
  },
  {
    name: 'cli',
    changed: ['cli.js', 'bin/**', 'lib/cli-*.js'],
    tests: ['cli.test.js', 'test/cli-*.test.js', 'test/quickstart-first-run.test.js'],
  },
  {
    name: 'adapters-connectors',
    changed: ['adapters/**', 'lib/*adapter*.js', 'lib/external-client-*.js', 'lib/*connector*.js'],
    tests: ['adapters/*.test.js', 'test/external-client-*.test.js', 'lib/external-client-*.test.js', 'lib/github-connector.test.js', 'test/github-app-server.test.js', 'test/secret-and-sourceref-redaction.test.js'],
  },
  {
    name: 'approval-policy-receipt-provenance',
    changed: ['lib/*approval*.js', 'lib/*policy*.js', 'lib/*firewall*.js', 'lib/*provenance*.js', 'lib/receipt/**', 'lib/audit-*.js', 'lib/ingest*.js', 'schemas/**'],
    tests: ['test/approval*.test.js', 'test/*firewall*.test.js', 'test/*policy*.test.js', 'test/provenance*.test.js', 'test/receipt-*.test.js', 'test/audit-*.test.js', 'test/ingest-approval-*.test.js', 'test/ingest-*.test.js', 'test/v4-*-receipt-*.test.js', 'test/v5-*-receipt-*.test.js'],
  },
  {
    name: 'plugins',
    changed: ['plugin.js', 'plugins/**', 'lib/plugin-*.js'],
    tests: ['plugin*.test.js', 'plugins/*.test.js', 'test/plugin-*.test.js', 'test/agent-*.test.js'],
  },
  {
    name: 'dream-reasoning-causal',
    changed: ['dream.js', 'reasonSandbox.js', 'causalSimulator.js', 'finalizer.js', 'lib/causal/**'],
    tests: ['dream.test.js', 'reasonSandbox.test.js', 'causalSimulator.test.js', 'finalizer*.test.js', 'test/causal-*.test.js', 'test/dream-*.test.js', 'test/reasoning-trace.test.js'],
  },
  {
    name: 'ui-workbench',
    changed: ['public/**'],
    tests: ['test/ui-*.test.js', 'test/v4-ui-*.test.js', 'test/v4-wb*.test.js', 'test/workbench-*.test.js', 'test/control-room-*.test.js', 'test/real-user-smoke-blockers.test.js'],
  },
  {
    name: 'ci-selection',
    changed: ['.github/workflows/**', 'scripts/ci-*.js', 'scripts/run-test-shard.js', 'scripts/ci-impact-plan.js', 'package.json', 'package-lock.json'],
    tests: ['test/ci-*.test.js', 'test/package-closure.test.js', 'test/module-reachability*.test.js', 'test/workflow-*.test.js', 'scripts/check-workflow-governance.test.js'],
  },
  {
    name: 'v5-protocol',
    changed: ['test/v5-*.test.js', 'lib/v5/**', 'schemas/v5/**', 'packages/huqan-verify/**'],
    tests: ['test/v5-*.test.js', 'test/a2a-*.test.js', 'lib/atp-conformance.test.js', 'packages/axiom-verify/index.test.js'],
  },
]);

/** Surfaces that need the impact rules but never the whole suite. */
const IMPACT_ONLY_PATTERNS = Object.freeze([
  'public/**',
]);

/** Surfaces where a partial selection is not trustworthy, so everything runs. */
const FULL_SUITE_PATTERNS = Object.freeze([
  'package.json',
  'package-lock.json',
  '.github/workflows/**',
  'scripts/ci-*.js',
  'scripts/ci-impact-plan.js',
  'scripts/run-test-shard.js',
  'Dockerfile',
  'docker-compose.yml',
]);

/** Documentation and fixtures that cannot affect runtime behaviour. */
const DOC_ONLY_PATTERNS = Object.freeze([
  'docs/**',
  'specs/**',
  'fixtures/**',
  'benchmarks/fixtures/**',
]);

module.exports = {
  DOC_ONLY_PATTERNS,
  FULL_SUITE_PATTERNS,
  IMPACT_ONLY_PATTERNS,
  IMPACT_RULES,
  MUST_HAVE_PATTERNS,
};
