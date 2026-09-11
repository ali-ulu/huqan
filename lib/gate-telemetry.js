'use strict';

const { ensureObservabilitySink } = require('./observability/kernel-sink');

/**
 * Central emission point for "a gate reached a decision" events (#212's
 * metric-collector.js consumes these).
 *
 * Before this module, no gate decision was observable by a plugin at all --
 * confirmed by grepping every lib/*-gate.js call site: only three actually
 * have one (evaluateMcpGate in mcpServer.js, evaluateMemoryAdmission in
 * kernel.js, evaluateAgentLoopBudget in agent.v3.js; every other gate file
 * -- code-change-gate, cross-workspace-access-gate, etc. -- either has no
 * caller at all or is only reached indirectly through lib/mcp-gate-adapter.js,
 * whose own findings array is what evaluateMcpGate's result already
 * surfaces). This module is the one place each of those call sites reports
 * through; agent.js's toolPolicy decisions (#469) were added as a fourth,
 * since agent.js's own execution loop ran evaluateToolPolicy without ever
 * reporting through here, leaving its block/review decisions invisible to
 * the same plugins that already observe every other gate.
 *
 * Uses plugins.emit() (fire-and-forget), never emitStrict(): a gate
 * decision must not be revisable by a plugin's return value. This hook
 * exists to observe decisions already made, never to let a plugin veto or
 * downgrade one.
 *
 * This module also makes sure there is somewhere to write. It used to read
 * `kernel?.observability` and accept `undefined` in silence, and `undefined` is
 * what it got everywhere outside the HTTP server: the sink was attached only by
 * lib/observability/server-runtime.js, whose sole caller is server.js. Every
 * decision made by the MCP process and the CLI was therefore dropped. Owning
 * the attachment here -- rather than in kernel.js -- keeps it at the one place
 * that actually needs a sink, and keeps a kernel that never emits from paying
 * for one.
 */
function emitGateTelemetry(kernel, source, decision) {
  if (!decision || typeof decision !== 'object') return;
  const event = {
    source,
    decision: decision.decision,
    reason: decision.reason,
    findings: Array.isArray(decision.findings) ? decision.findings : undefined,
    metadata: decision.metadata,
    timestamp: new Date().toISOString(),
  };

  // Observability is deliberately non-authoritative: a failed metrics write
  // must never revise, delay, or downgrade an already-made gate decision.
  try {
    ensureObservabilitySink(kernel)?.recordGateDecision?.({
      workspaceId: decision.metadata?.workspaceId || 'default',
      runId: decision.metadata?.runId,
      traceId: decision.metadata?.traceId,
      agentId: decision.metadata?.agentId,
      decision: decision.decision,
      reason: decision.reason,
      // Which capability this decision was about. Without it the event proves
      // that *something* ran, which cannot answer "has this capability ever
      // run?" for any particular one.
      tool: decision.tool || decision.metadata?.tool || '',
      payload: {
        source,
        findingsCount: Array.isArray(decision.findings) ? decision.findings.length : 0,
        metadata: decision.metadata,
      },
    });
  } catch (_) {}

  if (!kernel || !kernel.plugins || typeof kernel.plugins.emit !== 'function') return;
  kernel.plugins.emit('afterGateDecision', event);
}

module.exports = { emitGateTelemetry };
