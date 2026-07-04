'use strict';

const { MCP_GATE_DECISIONS } = require('../mcp-gate-adapter');
const { toCanonicalVerdict } = require('../verdict/action-verdict');

const MCP_MAX_SHORT = 256;

function sanitizeMcpString(val, maxLen = MCP_MAX_SHORT) {
  if (typeof val !== 'string') return '';
  return val.slice(0, maxLen).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

function readNestedString(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return '';
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const child of Object.values(value)) {
    const found = readNestedString(child, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

function normalizeMcpToolVerdict(gate) {
  try {
    return toCanonicalVerdict('mcp', gate?.decision || MCP_GATE_DECISIONS.block);
  } catch (_) {
    return MCP_GATE_DECISIONS.block;
  }
}

function buildMcpToolVerdictSurface(name, args, gate, result) {
  const safeArgs = args && typeof args === 'object' ? args : {};
  const receiptId = readNestedString(result, ['receiptId', 'receipt_id']);
  const traceId = readNestedString(result, ['traceId', 'trace_id', 'requestId', 'request_id']);
  const workspaceId = sanitizeMcpString(
    safeArgs.workspaceId
      || gate?.metadata?.workspaceId
      || readNestedString(result, ['workspaceId', 'workspace_id']),
    MCP_MAX_SHORT,
  );
  return {
    ok: Boolean(result && result.ok !== false),
    verdict: normalizeMcpToolVerdict(gate),
    reason: sanitizeMcpString(gate?.reason || result?.error?.code || 'mcp_tool_decision', MCP_MAX_SHORT),
    tool: sanitizeMcpString(name, MCP_MAX_SHORT) || 'unknown',
    receiptId: receiptId || null,
    traceId: traceId || null,
    workspaceId: workspaceId || null,
  };
}

function getMcpProvenanceDetails(args, result) {
  const safeArgs = args && typeof args === 'object' ? args : {};
  const provenance = safeArgs.provenance && typeof safeArgs.provenance === 'object'
    ? safeArgs.provenance
    : {};
  const sourceType = sanitizeMcpString(
    provenance.sourceType
      || safeArgs.sourceType
      || readNestedString(result, ['sourceType', 'source_type']),
    MCP_MAX_SHORT,
  );
  const sourceRef = sanitizeMcpString(
    provenance.sourceRef
      || safeArgs.sourceRef
      || readNestedString(result, ['sourceRef', 'source_ref']),
    MCP_MAX_SHORT,
  );
  const provenanceId = sanitizeMcpString(
    provenance.provenanceId
      || safeArgs.provenanceId
      || readNestedString(result, ['provenanceId', 'provenance_id']),
    MCP_MAX_SHORT,
  );
  return {
    present: Boolean(provenanceId || sourceType || sourceRef),
    sourceType: sourceType || null,
    sourceRef: sourceRef || null,
  };
}

function readMcpAdmission(result) {
  if (!result || typeof result !== 'object') return null;
  const dataAdmission = result.data && typeof result.data === 'object' ? result.data.admission : null;
  if (dataAdmission && typeof dataAdmission === 'object') return dataAdmission;
  const metaAdmission = result.meta && typeof result.meta === 'object' ? result.meta.admission : null;
  if (metaAdmission && typeof metaAdmission === 'object') return metaAdmission;
  return result.admission && typeof result.admission === 'object' ? result.admission : null;
}

function memoryAdmissionStatusFor(name, verdict, result) {
  if (name !== 'axiom.learn') return 'not_applicable';
  const admission = readMcpAdmission(result);
  const outcome = sanitizeMcpString(admission?.outcome || admission?.decision, MCP_MAX_SHORT);
  if (outcome === 'allow') return 'admitted';
  if (outcome === 'review') return 'review_required';
  if (outcome === 'reject') return 'rejected';
  if (outcome === 'block') return 'blocked';
  if (verdict === 'review') return 'review_required';
  if (verdict === 'block') return 'blocked';
  if (verdict === 'allow') return 'candidate';
  return 'not_applicable';
}

function buildMemoryAdmissionSurface(name, args, gate, result, toolVerdict) {
  const safeArgs = args && typeof args === 'object' ? args : {};
  const verdict = toolVerdict?.verdict || normalizeMcpToolVerdict(gate);
  const status = memoryAdmissionStatusFor(name, verdict, result);
  const admission = readMcpAdmission(result);
  const workspaceId = sanitizeMcpString(
    safeArgs.workspaceId
      || admission?.workspaceId
      || toolVerdict?.workspaceId
      || readNestedString(result, ['workspaceId', 'workspace_id'])
      || 'default',
    MCP_MAX_SHORT,
  );
  const canonicalMutation = status === 'admitted' && Number(result?.data?.learned || 0) > 0;
  const mutationAllowed = status === 'admitted' && verdict === 'allow';
  return {
    ok: Boolean(result && result.ok !== false),
    status,
    verdict,
    reason: sanitizeMcpString(gate?.reason || admission?.reason || result?.error?.code || 'memory_admission_not_applicable', MCP_MAX_SHORT),
    memoryId: readNestedString(result, ['memoryId', 'memory_id']) || null,
    receiptId: toolVerdict?.receiptId || admission?.receiptId || null,
    traceId: toolVerdict?.traceId || null,
    workspaceId: workspaceId || null,
    provenance: getMcpProvenanceDetails(safeArgs, result),
    contextIntegrity: {
      workspaceScoped: Boolean(workspaceId),
      canonicalMutation,
      mutationAllowed,
    },
  };
}

function withMcpToolVerdictSurface(result, name, args, gate) {
  const safeResult = result && typeof result === 'object'
    ? { ...result }
    : { ok: false, error: { code: 'INVALID_TOOL_RESULT', message: 'MCP tool returned a non-object result.' } };
  const toolVerdict = buildMcpToolVerdictSurface(name, args, gate, safeResult);
  const memoryAdmission = buildMemoryAdmissionSurface(name, args, gate, safeResult, toolVerdict);
  return {
    ...safeResult,
    verdict: toolVerdict.verdict,
    toolVerdict,
    memoryAdmission,
    meta: safeResult.meta && typeof safeResult.meta === 'object'
      ? { ...safeResult.meta, toolVerdict, memoryAdmission }
      : { toolVerdict, memoryAdmission },
  };
}

module.exports = {
  withMcpToolVerdictSurface,
};
