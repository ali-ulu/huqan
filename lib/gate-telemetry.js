'use strict';

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
 * surfaces). This module doesn't add new call sites; it's the one place
 * each of those three existing call sites reports through.
 *
 * Uses plugins.emit() (fire-and-forget), never emitStrict(): a gate
 * decision must not be revisable by a plugin's return value. This hook
 * exists to observe decisions already made, never to let a plugin veto or
 * downgrade one.
 */
function emitGateTelemetry(kernel, source, decision) {
  if (!kernel || !kernel.plugins || typeof kernel.plugins.emit !== 'function') return;
  if (!decision || typeof decision !== 'object') return;

  kernel.plugins.emit('afterGateDecision', {
    source,
    decision: decision.decision,
    reason: decision.reason,
    findings: Array.isArray(decision.findings) ? decision.findings : undefined,
    metadata: decision.metadata,
    timestamp: new Date().toISOString(),
  });
}

module.exports = { emitGateTelemetry };
