'use strict';

/**
 * What state is this graph in?
 *
 * The `durum` CLI command built its answer inline and printed it, so the only
 * way to get the numbers was to parse the sentence. Splitting the report from
 * its rendering lets `huqan.status` hand an MCP client the counts directly
 * while the CLI keeps printing exactly what it printed before -- one source of
 * truth, two presentations, no chance of the two drifting into different
 * answers.
 */

function safe(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function buildSystemStatus(kernel, { agentRuntime = null } = {}) {
  const stats = safe(() => kernel.graph.getStats() || {}, {});
  return {
    nodes: Number(stats.nodes) || 0,
    edges: Number(stats.edges) || 0,
    entropy: safe(() => kernel.entropy(), 0),
    gaps: safe(() => kernel.detectGaps(), []),
    contradictions: safe(() => kernel.detectContradictions(), []),
    // #3034: drift/conflict health, so an operator sees contested and stale
    // sources without leaving the status surface. Absent (undefined, not
    // zero) when the kernel predates the accessor -- the CLI text layer
    // skips it either way.
    memoryHealth: safe(() => kernel.memoryHealth && kernel.memoryHealth(), undefined),
    agentRuntime,
  };
}

/**
 * The CLI's line, unchanged: same wording, same truncation points, same order.
 * `extra` carries the parts only the CLI has -- plugin capability status is
 * rendered from the live plugin manager, not from the report.
 */
function formatSystemStatusText(report, extra = '') {
  let out = `Status: ${report.nodes} nodes, ${report.edges} edges, entropy: ${report.entropy.toFixed(3)}`;
  if (report.agentRuntime === 'workflow') out += '\n  Agent runtime: workflow';
  if (report.gaps.length > 0) {
    out += `\n  ${report.gaps.length} unconnected node(s): ${report.gaps.slice(0, 10).join(', ')}${report.gaps.length > 10 ? '...' : ''}`;
  }
  out += extra;
  for (const item of report.contradictions.slice(0, 5)) {
    out += `\n  Contradiction [${item.type}]: ${item.node} -> ${item.targets.join(', ')}`;
  }
  // #3034: drift/conflict counts, only when the kernel carries them. A
  // quiet workspace prints nothing extra; the report object is the
  // machine-readable source of truth, this line is the operator's glance.
  const health = report.memoryHealth;
  if (health && typeof health === 'object') {
    const driftPending = health.driftFindings ? health.driftFindings.pending : 0;
    const conflictPending = health.conflictCandidates ? health.conflictCandidates.pending : 0;
    if (driftPending > 0 || conflictPending > 0) {
      out += `\n  Memory health: ${driftPending} drift finding(s), ${conflictPending} conflict candidate(s) pending review`;
    }
  }
  return out;
}

module.exports = { buildSystemStatus, formatSystemStatusText };
