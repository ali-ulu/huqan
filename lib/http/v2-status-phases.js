'use strict';

/**
 * Static roadmap copy for /v2-status.
 *
 * Lifted out of server.js, which sits at the line-count ceiling recorded in
 * scripts/file-size-baseline.json (issue #328). This block is pure
 * presentation data: it contains no runtime state, so moving it changes
 * nothing about what the endpoint reports.
 *
 * The v2.3 entry no longer describes KernelV2 as an opt-in behind an
 * environment flag; kernel-factory made it canonical, and status copy that
 * still advertised the selector was part of what #755 was about.
 */

const V2_STATUS_PHASES = Object.freeze([
  {
    id: 'v2.0',
    title: 'v2.0 Core / Release',
    status: 'done',
    summary: 'Core contract, paranoid mode, MCP, benchmarks, release notes, and v2.0.0 tag are shipped.',
    items: [
      'Core envelope contract',
      'paranoidMode + AXIOM_ERROR + contractVersion',
      'MCP stdio adapter',
      'Deterministic benchmark fixtures',
      'Release docs + v2.0.0 tag',
    ],
  },
  {
    id: 'v2.1',
    title: 'v2.1 Verify Reasoning',
    status: 'done',
    summary: 'KernelV2 verify now supports multi-hop type inference, contradiction reasons, and richer evidence.',
    items: [
      'Multi-hop type-chain inference',
      'Negated known fact conflict',
      'Opposite predicate conflict',
      'Known type mismatch conflict',
    ],
  },
  {
    id: 'v2.2',
    title: 'v2.2 Ecosystem',
    status: 'done',
    summary: 'MCP schema reflects v2 verify fields and can opt into KernelV2 runtime.',
    items: [
      'Richer verify output schema',
      'Canonical KernelV2 runtime',
      'Schema tests',
    ],
  },
  {
    id: 'v2.3',
    title: 'v2.3 CLI/REST Runtime',
    status: 'done',
    summary: 'CLI, REST, and MCP run the canonical v2 kernel.',
    items: [
      'CLI KernelV2 canonical',
      'REST KernelV2 canonical',
      'Health/status kernel visibility',
    ],
  },
  {
    id: 'v2.4',
    title: 'v2.4 Status Dashboard',
    status: 'done',
    summary: 'The web UI and /v2-status endpoint show phase, runtime, test, and commit state in one place.',
    items: [
      'Single status endpoint',
      'Runtime kernel/backend cards',
      'Phase progress cards',
      'Last commit visibility',
    ],
  },
  {
    id: 'v2.5',
    title: 'v2.5 REST Structured Verify',
    status: 'done',
    summary: 'New /v2/verify endpoint returns the full core envelope while legacy /dogrula stays stable.',
    items: [
      'GET /v2/verify',
      'POST /v2/verify',
      'Legacy /dogrula compatibility',
      'Structured REST tests',
    ],
  },
  {
    id: 'v2.6',
    title: 'v2.6 MCP Schema Polish',
    status: 'done',
    summary: 'MCP tool descriptions and output schemas now mirror the real payload shapes more closely.',
    items: [
      'Concrete tool descriptions',
      'Per-tool output schemas',
      'Evidence and meta schema details',
      'Developer-friendly MCP docs',
    ],
  },
  {
    id: 'v2.7',
    title: 'v2.7 Manipulation Guard',
    status: 'done',
    summary: 'KernelV2 now flags manipulative, coercive, or injection-style text with additive risk metadata.',
    items: [
      'Prompt-injection detection',
      'Coercive and overclaim risk labels',
      'Risk-aware learnFromLLM filtering',
      'Structured verify risk metadata',
    ],
  },
  {
    id: 'v2.8',
    title: 'v2.8 Status Dashboard Polish',
    status: 'done',
    summary: 'The dashboard now makes progress, remaining phases, and current focus easier to scan at a glance.',
    items: [
      'Progress percentage',
      'Remaining phase count',
      'Current focus clarity',
      'Dashboard readability polish',
    ],
  },
  {
    id: 'v2.9',
    title: 'v2.9 Evidence Polish',
    status: 'done',
    summary: 'KernelV2 verify now adds compact explanation and evidence summary fields for clearer reasoning traces.',
    items: [
      'Verify explanation text',
      'Compact evidence summary',
      'Risk-aware reasoning polish',
      'MCP schema exposure',
    ],
  },
  {
    id: 'v3.0',
    title: 'v3.0 Agent Workflow',
    status: 'in_progress',
    summary: 'AXIOM now has a lightweight multi-step agent planner with persistent goal memory, tool selection policy, and execution reports.',
    items: [
      'Goal planner',
      'Persistent goal memory',
      'Multi-step execution loop',
      'Tool selection policy',
      'CLI agent commands',
    ],
  },
]);

module.exports = { V2_STATUS_PHASES };
